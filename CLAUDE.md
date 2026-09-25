# CLAUDE.md

Instructions for agents working in this repo. Read
[docs/architecture.md](docs/architecture.md) before changing how data is
captured, and [docs/map.md](docs/map.md) to find things.

---

## The rule that matters most

**Never write code against a format you have not verified on this machine.**

Log paths, directory layouts, JSON shapes, payload fields, env var names, API
behaviour — inspect them, don't recall them. A parser written against a guessed
schema is worse than no parser, because it produces plausible wrong data instead
of an error.

When something is uncertain, **say "I'm not sure" and say what to run to find
out.** Every finding in `docs/` cites how it was established; new findings must
do the same.

This has already caught three wrong claims about exit codes, each of which
looked obviously true:

1. "PostToolUse supplies exit codes" — false; the Bash output schema has 17
   fields and none is an exit status.
2. "The OTEL span attribute supplies it" — false; the function that would set it
   is a no-op in the shipped binary.
3. "Nothing can supply it" — also false; `PostToolUseFailure.error` begins
   `"Exit code N"`.

## Fixed architecture — do not relitigate

PostgreSQL 16 (normalized tables + `raw_payload` JSONB, tsvector GIN search) ·
Docker Compose · Node 20 + TypeScript collector and proxy · Next.js App Router +
Tailwind read-only dashboard · monorepo `apps/collector`, `apps/proxy`,
`apps/web`, `packages/schema` · versioned reversible migrations.

## Conventions

- **`snake_case` in SQL. `camelCase` in TypeScript.** Map at the query boundary;
  no snake_case keys in TS types.
- Enum *string values* match SQL labels exactly — they are data, not identifiers.
- Comments explain **why**, not what. Match the surrounding density; this
  codebase comments the non-obvious decision and nothing else.

## Invariants

Breaking any of these silently corrupts the record, so they are enforced in the
schema as well as in code.

| Invariant | Meaning |
|---|---|
| **Absence is not zero** | NULL tokens render "—", NULL cost "not priced", NULL exit code "unknown". Never 0, $0.00, or success. |
| **Cost is never recomputed** | A price change inserts a new `model_pricing` row. It does not rewrite what past turns cost. |
| **Provenance per fact** | `token_source`, `provider_source`, `duration_source`, `cost_source`, `source`, `attribution`, `match_method` — keep them accurate. |
| **Precedence is per field** | hooks > logs > proxy, applied field by field. Never merge wholesale. |
| **Host paths only in the DB** | A `/host/...` path is never correct. A CHECK constraint enforces it. |
| **Writes are idempotent** | Turns on `(session_id, seq)`, raw events on `(source, external_id)`. Re-reading must be free. |
| **Never break the agent** | The proxy and hook script are in the agent's critical path. Recording is best-effort, always after delivery. |

## Things that will bite you

- **Never edit an applied migration.** The runner checksums both directions and
  will refuse to run. Correct it with a new migration (see 011, 012).
- **Changing redaction patterns requires bumping `Redactor.version`.** Both
  services refuse to start if a known version's pattern hash changed.
- **Never bind a port to `0.0.0.0`.** Docker's publish rules bypass the host
  firewall; this database holds every prompt ever typed on this machine.
- **The dashboard connection is read-only** (`default_transaction_read_only`).
  Don't work around that.
- Diff bodies live in `file_change_diffs`, separate from `file_changes`, so list
  queries can't drag multi-MB TOASTed values. Don't join them in a list query.
- All SQL the UI runs lives in `apps/web/src/lib/queries.ts`. Keep it there.
- **`compose.override.yaml` is generated** from `CODE_ROOT_2…N` in `.env`
  (`scripts/installer/compose-override.sh`, run by `make up/web/dev` and the
  installer). Edit `.env`, not the file; it refuses to overwrite one it did not
  write.
- **The collector and proxy bind `0.0.0.0` by default** — correct only inside a
  container that publishes `127.0.0.1`. Anything running them outside Docker
  must set `COLLECTOR_BIND_HOST` / `PROXY_BIND_HOST=127.0.0.1` (native install
  does).
- `.env.example` is parsed by the installer: every variable needs a `# @tags`
  line directly above it (legend at the top of the file). A `@derived` variable
  also needs a derivation in `scripts/installer/env.sh`, or the install stops.

## Working against the live database

`aiuo` holds real history. **Read-only queries only** unless explicitly asked
otherwise — no INSERT, UPDATE, DELETE or DDL, and no probe rows. To prove
something about write behaviour, use `CREATE TEMP TABLE` or a scratch database.

`make backup` before anything destructive.

## Commands

```bash
./install.sh           # one-command install, Docker or native (make install / make uninstall)
make help              # every target
make up                # postgres + migrate + collector + proxy
make web               # + dashboard at :3000
make logs              # follow the collector
make typecheck         # every package
make test              # collector + web + installer tests (proxy: pnpm --filter @agentpulse/proxy run test)
make test-installer    # installer only; integration: scripts/installer/tests/*-integration.sh
make shellcheck
make migrate-status
make backup
```

Ports: postgres 5433, collector 4317, proxy 4318, web 3000 — all on
`127.0.0.1`, all overridable in `.env`.

## Git

Commit and push **only when explicitly asked in that message**. Permission does
not carry forward from an earlier commit. Otherwise: finish the work, leave it
in the working tree, and report what changed and how you'd group it.

## Current state

Working: Layer 1 tailing (Claude Code), Layer 2 hook capture, Layer 3 proxy,
reconciliation, the dashboard, the installer (`install.sh`: Docker verified on
macOS; native verified on macOS/launchd and Ubuntu 24.04/systemd — see
`docs/install.md`).

Not done — don't assume otherwise:

- The **hook enrichment pass** that folds `raw_events` into `tool_calls`
  (`exit_code`, measured `duration_ms`, `agent_id`). Events are being captured;
  nothing is being lost.
- The proxy has **never carried real traffic**, so every provider is inferred.
- Costs have **never been checked against an invoice**.
- Layer 4 (OTLP receiver) is not built.
- Adapters: Claude Code verified; Gemini CLI verified against 0.61.0 (legacy
  JSON + current JSONL), enabled by default in `compose.yaml` but `false` by
  default in `config.ts` outside compose; Codex / Qwen / Cursor / Copilot have
  none.
- **Git gap-fill** is not built: `git` is in the collector image but nothing
  calls it, so `git_head_sha` and `git_dirty` are always NULL.
- **Retention / hard-delete** by project or date range is not built.
- Installer, unverified: Docker mode on a Linux engine, WSL2, dnf/pacman
  package selection, switching an install between Docker and native.
- Gemini rates (migration 014) are operator-supplied and unverified.
