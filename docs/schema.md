# Phase 2 — Schema and migrations

PostgreSQL 16. 13 tables, 8 enums, 22 check constraints, 43 indexes.
All seven migrations were applied, rolled back, and re-applied against
`postgres:16.14` on 2026-09-11; results in [Verification](#verification).

## Layout

```
packages/schema/
  migrations/
    001_foundation.up.sql   / .down.sql   extensions, enums, normalize_model_id()
    002_registry.up.sql     / .down.sql   agents, providers, redaction_versions, projects
    003_reference.up.sql    / .down.sql   model_providers, model_pricing (+ seed)
    004_core.up.sql         / .down.sql   sessions, turns
    005_activity.up.sql     / .down.sql   tool_calls, file_changes, file_change_diffs
    006_ingest.up.sql       / .down.sql   raw_events, ingest_checkpoints
    007_indexes.up.sql      / .down.sql   every index
  src/
    migrate.ts    runner: up | down | status | verify
    types.ts      camelCase TS mirror of the tables
```

## Running it

```bash
export DATABASE_URL=postgres://aiuo:...@127.0.0.1:5433/aiuo

pnpm --filter @aiuo/schema migrate up        # apply pending
pnpm --filter @aiuo/schema migrate status    # applied/pending + drift check
pnpm --filter @aiuo/schema migrate verify    # exit 1 if a file was edited after apply
pnpm --filter @aiuo/schema migrate down --to 5 --yes
```

In Docker this runs as the one-shot `migrate` service, never on app boot — two
collector replicas racing through DDL is a corruption path. A session-level
advisory lock (`pg_advisory_lock`, fixed key) makes the race impossible even if
someone runs the command by hand mid-startup.

Runner properties:

- **One transaction per migration.** A failure rolls that migration back whole
  and leaves earlier ones applied, so a re-run resumes at the failure.
- **Checksums over both directions.** Editing an applied `.up.sql` *or*
  `.down.sql` is detected; `up` then refuses to run rather than compounding
  the drift.
- **A missing `.down.sql` is a load-time error.** Every migration is reversible
  by construction, not by convention.
- **`down` requires `--yes`.** Rollbacks drop tables; a mistyped command should
  not be able to destroy a database.
- **Connection backoff.** Ten attempts with exponential delay, because a
  `pg_isready`-healthy Postgres can still refuse connections for a beat.

## Rollback, per migration

| # | Rolling back costs you | Safe to do? |
|---|---|---|
| 007 indexes | Nothing but speed — correct results via seq scans and full sorts | **Yes.** Re-apply freely; this is the one to iterate on |
| 006 ingest | Byte offsets **and** raw event provenance. Next start re-ingests from scratch | Recoverable if transcripts still exist on the host |
| 005 activity | All commands, file changes and diff bodies. Turns survive → UI lists turns with empty detail panes | Re-ingestable from `raw_events` if 006 is intact |
| 004 core | **All history.** Every turn and session | Re-ingestable only from host transcripts |
| 003 reference | Seeded and hand-edited pricing. Cost history on turns survives (cost is stored, not computed on read) | Export first — hand-added rates are not in the seed |
| 002 registry | Projects, and the agent/provider registries | Destructive |
| 001 foundation | Nothing — no tables | Safe once 002-007 are down |

Each `.down.sql` opens with its own hazard note and a `pg_dump` line.

**Out-of-order rollback is blocked by the database, not by discipline.**
Running `003.down` while `turns` exists fails on
`turns_pricing_id_fkey`; `002.down` fails on `sessions_project_id_fkey`;
`001.down` fails because `turns.model_normalized` depends on
`normalize_model_id()`. All three verified.

### Backup

```bash
docker compose exec -T postgres pg_dump -Fc -U aiuo aiuo > ./backups/aiuo-$(date -u +%Y%m%dT%H%M%SZ).dump
```

**The `down -v` footgun:** `docker compose down -v` removes the named pgdata
volume and every byte of ingested history with it. `docker compose down`
(no `-v`) is the safe form. Take a dump before any `-v`.

## Design decisions worth reviewing

### Agent and provider are tables, not enums

The brief requires that adding an agent costs "one adapter + one config entry,
**nothing else**". An enum would add "+ one migration", and Postgres cannot
remove an enum label once added, so it would also make that migration
irreversible. `agents` and `providers` are lookup tables the collector upserts
at startup. Genuinely closed sets — `token_source`, `provider_source`,
`turn_status`, `change_type`, `attribution`, `duration_source`, `capture_layer`,
`cost_source` — remain real enums.

### `turns` carries project_id and agent_id, guaranteed by composite FK

The turn list filters on project/agent and sorts on `started_at`. Joining
`sessions` before the sort defeats the `(project_id, started_at DESC)` index
and forces a full sort for a 50-row page. So both columns are denormalized onto
`turns` — and kept honest structurally, not by convention:

```sql
ALTER TABLE sessions ADD CONSTRAINT sessions_id_project_unique UNIQUE (id, project_id);
-- turns:
CONSTRAINT turns_session_project_fk FOREIGN KEY (session_id, project_id)
  REFERENCES sessions (id, project_id) ON DELETE CASCADE
```

A turn claiming a different project than its session is rejected. Verified.

### `total_input_tokens` is materialized

Claude Code reports `input_tokens: 2` on a cache-hit turn that also read 12,959
and wrote 19,422 cached tokens. Summing `input_tokens` alone under-reports by
orders of magnitude, and every query author would have to remember the
three-way sum. It is a generated column instead: `2 + 12959 + 19422 = 32383`.

### Cache writes split by TTL

Anthropic bills the 5-minute TTL at 1.25× input and the 1-hour TTL at 2×.
Claude Code reports the buckets separately
(`usage.cache_creation.ephemeral_5m_input_tokens` / `_1h_`). Collapsing them
would misprice cache-heavy sessions by up to 60%, so `cache_write_5m_tokens`
and `cache_write_1h_tokens` are stored alongside the total, with matching rate
columns on `model_pricing`.

### An unpriced turn cannot claim a cost

```sql
CONSTRAINT turns_cost_consistent CHECK (
     (cost_source = 'priced'     AND cost_usd IS NOT NULL AND pricing_id IS NOT NULL)
  OR (cost_source = 'free_local' AND cost_usd = 0)
  OR (cost_source = 'unpriced'   AND cost_usd IS NULL))
```

No `model_pricing` row for a (provider, model) means `cost_usd IS NULL` and
`cost_source = 'unpriced'`, which the dashboard must render as "not priced".
The failure this prevents is an unknown model silently reporting **$0.00** and
looking free. This is also why the seed contains no unverified third-party
rates — only Anthropic's, verified 2026-09-11.

### Host paths enforced by CHECK

`projects.path`, `tool_calls.cwd`, `file_changes.path`, `file_changes.old_path`,
`raw_events.project_path` and `ingest_checkpoints.file_path` all reject
`/host/…`. Outbound path translation is easy to miss in one code path and
impossible to detect later — the dashboard just shows paths nobody can open.
The constraint turns silent corruption into a loud insert failure.

### `exit_code` is nullable and NULL means unknown

Verified on this machine: across **3,822** shell results in Claude Code
transcripts, not one carries an exit code. NULL is therefore the entire Layer 1
backfill, and rendering it as `0` would report every failed command in the
archive as a success. Same reasoning gives `tool_calls.duration_source` —
Layer 1 durations are `derived` (wall-clock around the call, an upper bound
including model latency) and must never be averaged together with `reported`
ones.

### Diffs live in their own table

`file_change_diffs` is 1:1 with `file_changes` but separate, so that a
`SELECT *` — or an ORM that generates one — cannot drag multi-MB TOASTed diff
bodies through a list page that does not render them. `unified_diff` uses lz4
compression (confirmed active), falling back to pglz on servers built without
it.

### Checkpoints live in Postgres — deviation, flagged

The brief puts resume offsets in a named Docker volume. They are in
`ingest_checkpoints` instead: a file-based offset and the rows it describes
cannot advance atomically, and the failure is silent in the direction that
matters — offset advanced, rows not written, turns permanently skipped. In
Postgres the offset advances in the same transaction as its inserts. The named
volume still matters for pgdata. **Say if you want this moved back.**

### `raw_events` has no FK to projects

Deliberate: it must survive the retention cascade, and hook events can arrive
before the session row exists. Confirmed — deleting a project removes its
turns, tool calls, file changes and diffs while `raw_events` stays. The
consequence is that **retention must delete `raw_events` explicitly**; it is
not cleaned up by cascade. That is what `raw_events_ingested_idx` is for.

### Full-text search input is capped at 512 KB per field

`to_tsvector` throws past ~1 MB of lexemes, which would turn one huge response
into a hard INSERT failure and stall the entire tail. The index input is
truncated; the full text is still stored intact. Config is `'english'`.

## Index justification

Every index, and the plan problem it prevents. UNIQUE constraints already
create btrees — `turns(session_id, seq)`, `tool_calls(turn_id, seq)`,
`file_changes(turn_id, seq)`, `raw_events(source, external_id)`,
`sessions(agent_id, external_session_id)` — and are not duplicated.

| Index | Query | Plan concern |
|---|---|---|
| `turns_started_at_idx` | global timeline | Without it, `ORDER BY started_at DESC LIMIT 50` sorts the whole table |
| `turns_project_started_idx` | project timeline | `(project_id, started_at DESC)` serves filter *and* sort; the reverse order serves only the sort |
| `turns_agent_started_idx` | agent filter | as above |
| `turns_provider_model_started_idx` | provider × model breakdown | Leading `provider_id` because "all Anthropic spend" is the real query; the prefix alone still serves it |
| `turns_project_branch_started_idx` | branch filter | Partial (`git_branch IS NOT NULL`); branch is always project-scoped since `main` is meaningless across repos |
| `turns_partial_reconcile_idx` | reconciler closing stale partials | Partial on `status='partial'`. A full index on status would be ~99% dead weight maintained on every insert |
| `turns_day_utc_idx` | tokens/cost by day | `date_trunc` on bare timestamptz is STABLE and unindexable; `AT TIME ZONE 'UTC'` makes it IMMUTABLE. Results unchanged — everything is stored UTC |
| `turns_search_tsv_idx` | full-text search | GIN not GiST: written once per turn, searched interactively |
| `turns_pricing_idx` | "which turns used this rate?" | Partial; cost audits only |
| `sessions_project_started_idx` | session list per project | filter + sort |
| `sessions_parent_idx` | sub-agent roll-up | Partial; most sessions have no parent |
| `file_changes_uncertain_idx` | attribution warning banner | Partial; `agent` is the overwhelming majority and never searched for |
| `file_changes_path_idx` | file history (post-v1) | `text_pattern_ops` so directory prefix `LIKE` can use it under a non-C collation |
| `raw_events_session_idx` | replay one session | |
| `raw_events_ingested_idx` | retention sweeps | The only way to delete raw events — no cascade reaches them |
| `model_pricing_lookup_idx` | cost lookup at ingest | Cheaper exact-match probe than the EXCLUDE constraint's GiST index |

**Deliberately absent:** no GIN on `raw_events.payload`. It would roughly double
the write cost of the hottest insert path to serve ad-hoc JSON queries that are
not a v1 feature. Replay reads by session or date, both covered.

## Changing model normalization

`normalize_model_id()` backs STORED generated columns. `CREATE OR REPLACE`
does **not** recompute stored values — old rows would keep the old rules and new
rows get the new ones, a silent split. To change it, write a migration that
drops and re-adds the generated columns:

```sql
ALTER TABLE turns DROP COLUMN model_normalized;
CREATE OR REPLACE FUNCTION normalize_model_id(text) ... ;
ALTER TABLE turns ADD COLUMN model_normalized text
  GENERATED ALWAYS AS (normalize_model_id(model_raw)) STORED;
```

Rewrites the table; take the downtime knowingly. `model_raw` always survives,
so normalization is never lossy.

## Verification

Run against `postgres:16.14` on 2026-09-11.

**Migrations:** all 7 applied; all 7 rolled back in reverse (leaving zero
tables, zero enums, zero functions); all 7 re-applied. Runner: `up` idempotent
on second run, `down` without `--yes` refused, `down --to 5 --yes` reverted
exactly 006 and 007, drift detection caught an edited applied migration and
blocked `up`. `tsc --noEmit` clean.

**Normalizer** — 12/12 correct:

| raw | normalized |
|---|---|
| `claude-sonnet-4-5-20250929` | `claude-sonnet-4-5` |
| `us.anthropic.claude-sonnet-4-5-20250929-v1:0` | `claude-sonnet-4-5` |
| `claude-opus-4-5@20251101` | `claude-opus-4-5` |
| `anthropic/claude-opus-5` | `claude-opus-5` |
| `models/gemini-2.5-pro` | `gemini-2.5-pro` |
| `openai/gpt-4o` | `gpt-4o` |
| `llama3.3:latest` | `llama3.3` |
| `qwen2.5-coder:7b` | `qwen2.5-coder:7b` *(size tag preserved — different weights)* |

**Generated columns**, on a real turn from the inspected transcript:
`total_input_tokens` = 32,383 (from `input_tokens` 2 + read 12,959 + write
19,422), `duration_ms` = 6,037, FTS matched
`websearch_to_tsquery('docker build error')`.

**Guard constraints** — 10/10 rejected as intended: container path in
`projects.path`; relative path; container `cwd`; turn claiming another project;
unpriced turn with a cost; priced turn without a `pricing_id`; overlapping
price period; binary file change with line counts; rename without `old_path`;
duplicate `(source, external_id)` raw event.

**Cascade:** `DELETE FROM projects` removed the turn, tool call, file change
and diff; `raw_events` survived.

## Assumptions made (Phase 1 questions still open)

You said proceed, so these are stated rather than blocking. None of them
changed the schema, which is agent-agnostic — they change Phase 3.

1. **Scope.** Schema supports all six agents; only `claude_code` has a verified
   format. `agents` rows for the others carry a note saying so.
2. **`PostToolUse` payload.** `duration_source='reported'` is unpopulated
   until hooks are installed. `exit_code` is unpopulated *permanently* on
   current capture layers — the hook carries no exit status (verified; see
   [hook-payloads.md](hook-payloads.md) and migration 011). The column stays,
   because NULL-means-unknown is still the right model and an OTLP receiver
   would fill it.
3. **Code roots.** No `PATH_MAP` default is committed; `.env.example` shows the
   shape using the two roots visible in your transcripts.

## Next: Phase 3

Compose skeleton + path translation + the Claude Code adapter end-to-end.
