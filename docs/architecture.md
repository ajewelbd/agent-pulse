# Architecture

How the system is put together, and why each decision went the way it did.
For *where* things live, see [map.md](map.md). For *how to run it*, see
[operations.md](operations.md).

---

## The shape of the problem

CLI coding agents already write down what they did — in transcript files, in
hook events, in HTTP requests to a model API. None of those three sources is
complete, and they disagree.

- Transcripts are **retroactive and complete for history**, but record no exit
  codes, no provider, and durations only as wall-clock gaps that include model
  latency.
- Hooks are **live and precise** — real measured durations, exact tool ids —
  but only for sessions that ran after they were installed.
- The model API sees **the actual upstream host and provider-reported usage**,
  but knows nothing about sessions, projects or files.

So the system captures all three and records, per fact, which one supplied it.

## Components

```
   HOST                                    CONTAINERS
   ─────                                   ──────────

   ~/.claude/projects/*.jsonl ──(ro bind)──▶ ┌───────────┐
                                             │ collector │──┐
   ~/.claude/settings.json                   │  :4317    │  │
        │ hooks                              └───────────┘  │
        └── post-event.sh ──── POST /v1/hooks ──▶ (same)    │
                                                            ├──▶ ┌──────────┐
   agent ── ANTHROPIC_BASE_URL ──▶ ┌───────┐                │    │ postgres │
                                   │ proxy │────────────────┘    │  :5432   │
                                   │ :4318 │──▶ api.anthropic    └──────────┘
                                   └───────┘                          │
                                                                 read-only
   browser ──▶ http://127.0.0.1:3000 ──▶ ┌─────┐                      │
                                         │ web │──────────────────────┘
                                         └─────┘
```

Four services, one database. The collector and proxy are **separate services on
purpose**: restarting the proxy to change an upstream must not drop the tailer's
file watches or checkpoints.

---

## Layer 1 — the log tailer

The collector discovers transcripts under each agent's read-only-mounted home,
and tails them.

**Adapters are the only agent-specific code.** An adapter does two things —
`discover()` and `parse()` — and produces `ParsedTurn` objects in container-path
space with raw text. Everything after that (path translation, redaction,
provider resolution, cost, writes) is identical for every agent and lives in
`ingest.ts`. Adding an agent is one adapter file plus one line in the registry:
no migration, no pipeline change.

### Checkpointing

Each transcript has a byte offset in `ingest_checkpoints`, keyed on the
transcript's **host** path.

The checkpoint advances **in the same transaction as the rows it accounts for**,
so a crash can never leave an offset ahead of the data. That is the entire
reason checkpoints live in Postgres rather than in a file.

The offset recorded is the **start of the currently-open turn, not EOF**. On
restart the open turn is re-read from its first byte instead of being lost.
Re-reading costs nothing because every write is idempotent: turns upsert on
`(session_id, seq)`, raw events on `(source, external_id)`.

External ids are **content-derived hashes, never line numbers** — compaction
rewrites transcripts in place, and a line number would silently point at
different content afterwards.

Rotation and truncation are both detected (inode change; size below the recorded
offset) and both mean "re-read this file from zero".

### Failure isolation

One transaction **per transcript**, not per pass. This was learned the hard way:
a single constraint violation once rolled back and aborted the whole loop,
ingesting 134 turns instead of 442 with nothing in the logs naming the file at
fault. Now a poisoned transcript is skipped, named on stderr, and counted in a
`TRANSCRIPT(S) FAILED` line that a success message can never hide.

## Layer 2 — hooks

`scripts/install-hooks.sh` writes a small forwarder into `~/.claude/aiuo/` and
registers it for nine events in `~/.claude/settings.json`. The forwarder POSTs
the payload **verbatim** to the collector, which stores it in `raw_events`
unparsed.

Storing it unparsed is deliberate: the payload shape changes between agent
versions, and a parser written against a guessed schema is worse than no parser.
The verified shape is in [hook-payloads.md](hook-payloads.md), read out of the
shipped binary and then confirmed against live events.

The forwarder **never blocks the agent**: 2-second timeout, errors swallowed,
always exits 0. A collector that is down must not break a coding session.

The endpoint requires `X-Aiuo-Secret`, compared with a timing-safe equality.
Without it, any local process could post fabricated history — or read yours back.

**Not yet done:** the enrichment pass that folds these events into `tool_calls`.
Events are being captured meanwhile, so nothing is being lost, but `exit_code`,
measured `duration_ms` and `agent_id` are still sitting in `raw_events`. One
trap for whoever writes it: PostToolUse "may run concurrently for parallel tool
calls" per its own schema, so events must be sequenced from the payload, not
from arrival order.

## Layer 3 — the proxy

A reverse proxy in front of the model API. The agent points at it with its
base-URL env var.

**The overriding rule is: never break the agent.** This process sits in the path
of every model call, so a recording failure, a database outage or a slow insert
must not fail, stall or alter the request. Specifically:

- Response chunks are **teed** — forwarded to the client the instant they
  arrive, while a *capped* copy accumulates for usage extraction. Buffering the
  whole stream first would destroy streaming.
- Recording happens **after** the response is fully delivered, and catches
  everything. A failure logs a line and moves on.
- There is **no upstream timeout**. A long agentic completion can legitimately
  run for many minutes, and a proxy timeout would look to the user like the
  model failed.

The proxy sees every credential the agent sends. So credential headers are
replaced with `[REDACTED]` before anything is recorded, bodies go through the
same redaction pipeline as prompts and diffs, and it is published on
`127.0.0.1` only.

`/_u/<name>/...` prefix routes let one proxy serve several upstreams, because an
agent gives you only one base-URL variable.

---

## Path translation

The agents run on the **host**; the collector runs in a **container** and reaches
their state through bind mounts. Two edges translate, and getting either wrong
fails quietly:

| Direction | From → to | Failure if wrong |
|---|---|---|
| inbound | host path in a hook event → container path to open | ENOENT, or worse, reading the wrong file |
| outbound | container path → host path to store | a dashboard full of `/host/code/...` paths that open on no machine |

`PATH_MAP` is an ordered list of `host_prefix:container_prefix` pairs. Three
properties matter:

- **Segment-boundary matching.** A naive `startsWith` would let `/host/code/ap`
  match `/host/code/app` and produce a silently corrupt path.
- **Split on the last colon.** macOS paths contain spaces, Windows paths contain
  a drive colon.
- **Shadowing is refused at startup.** First match wins, so a shorter earlier
  prefix can make a later entry dead — a bug that surfaces as "some projects
  have wrong paths" weeks later.

The database **rejects any `/host/...` path outright** with a CHECK constraint,
and the collector asserts it again before insert so the error names the value
and the field instead of surfacing as a constraint violation three frames away.

### Startup assertions

A missing mount must never degrade to "zero turns found" — that failure is
invisible: the collector runs, logs nothing alarming, and the dashboard is
simply empty forever. So startup fails loudly when:

- an enabled agent's home is not mounted, or is not a directory
- an enabled agent's home has **no `PATH_MAP` entry** (checkpoints are keyed on
  host paths, so without it *every* transcript fails to checkpoint)
- a `PATH_MAP` target is not mounted

---

## Provenance and precedence

Nothing is merged wholesale. Precedence is **hooks > logs > proxy**, applied
**field by field**.

### Provider attribution

`proxy > config > model_map > unknown`, recorded in `provider_source`.

The proxy **wins unconditionally** here, even though it is lowest precedence
generally. This is the one deliberate inversion, and it is not a contradiction:
it is not a disagreement about the same fact. The proxy *observed* the host that
was actually connected to. The log never had that fact at all — it can only
infer from a model id, and that inference cannot tell direct traffic from a
gateway serving the same model.

### Tokens

The proxy **fills gaps only**. Where the log reported provider counts, those
win. Where it reported none (`token_source = 'unknown'`), the proxy's numbers
are the only ones there are — which is the whole reason Layer 3 exists for
agents whose logs omit usage.

Wholesale "last layer wins" would silently replace provider-reported counts with
proxy-observed ones and make the two indistinguishable afterwards.
`token_source` records which it was, so an aggregate never mixes them silently.

### Correlating proxy calls to turns

Nothing in an Anthropic or OpenAI request carries a session id, so correlation
is necessarily a heuristic: match on `(model, time window)` with a 2-minute
grace. **A window containing two turns on the same model is marked `ambiguous`
and left unmatched.** A wrong attribution is worse than none, because afterwards
it is indistinguishable from a right one. The method used is stored per row.

Observations older than 30 minutes with no match become `no_candidate`, which
keeps "not processed yet" distinct from "no match exists".

---

## Cost

```
cost = Σ over five buckets:  tokens / 1e6 × rate
       input · output · cache read · cache write 5m · cache write 1h
```

Rates come from `model_pricing`, looked up by `(provider_id, model_normalized,
started_at)` against an `effective_from` / `effective_to` period.

- **Computed once at ingest and stored.** A price change inserts a new pricing
  row; it does not rewrite what past turns cost. Each turn stores the
  `pricing_id` it used, so any figure can be traced to the rate that produced it.
- **Overlapping rates are unrepresentable.** A GiST `EXCLUDE` constraint on
  `(provider_id, model_normalized, tstzrange(effective_from, effective_to))`
  makes the lookup provably unambiguous.
- **Unknown is not free.** No provider, no model, no reported tokens, or no rate
  covering the period → `cost_source = 'unpriced'` and a NULL cost, rendered
  "not priced". Never $0.00, which would make unknown models look free.
- **Cache tiers are separate columns** because they price differently (read
  0.1×, 5-minute write 1.25×, 1-hour write 2× the input rate). Collapsing them
  is a large error on cache-heavy sessions — on turn 8432 here, cache reads were
  94.5% of the token volume, so pricing them at the input rate would have
  overstated that turn roughly tenfold.
- **An unsplit cache-write total is charged at the 5m rate** — the cheaper of
  the two — so the estimate never over-bills.
- The reconciler deliberately does **not** reprice a turn whose tokens it
  back-filled. That would apply today's rates to an old turn, which is exactly
  what "never recomputed retroactively" forbids.

Rates were seeded from a pricing page and have **never been checked against an
invoice**. Treat totals as derived, not billing-authoritative.

---

## Redaction

Runs **before insert**, over prompt text, response text, command output, diff
bodies and proxy request/response bodies alike — a diff that adds an API key to
a config file contains that key just as surely as a prompt does.

The pattern set is **compiled in**, not loaded from a file, and every content row
stores the `redaction_version` it was written under. That is only an audit trail
if one version means one pattern set forever, so both services **refuse to start**
if a version already in the database has a different pattern hash. Registration
is `ON CONFLICT DO NOTHING`; an earlier `DO UPDATE` silently rewrote history.

It catches credential *shapes*. It is **not** PII removal. Details and the full
pattern list: [redaction.md](redaction.md).

---

## Database

PostgreSQL 16. Normalized tables plus a `raw_payload` JSONB column carrying the
verbatim source record, so nothing is lost to a parser's blind spot and any row
can be replayed.

Key mechanisms, with the reason each was chosen:

| Mechanism | Used for |
|---|---|
| Generated columns (STORED) | `model_normalized`, `total_input_tokens`, `duration_ms` — derived values that can never drift from their inputs |
| `EXCLUDE USING gist` | overlapping pricing periods made unrepresentable |
| Composite foreign keys | `turns.project_id` is denormalized from the session; the FK keeps them consistent by construction |
| `tsvector` + GIN | full-text search over prompts and responses |
| Partial indexes | e.g. unmatched proxy requests, so the hot index stays small |
| CHECK constraints | `/host/...` paths rejected; "absence is not zero" enforced at the storage layer |
| Advisory lock | migrations cannot race even if run by hand mid-startup |
| `default_transaction_read_only` | the dashboard's connection **cannot** write, regardless of what its code does |

Diff bodies live in their own table (`file_change_diffs`) so a list query can
never accidentally drag multi-MB TOASTed values it does not render.

### Migrations

Versioned, reversible, one transaction each. The runner checksums **both**
directions, so editing an applied `.up.sql` *or* `.down.sql` is detected and
`up` refuses to run rather than compounding the drift. A missing `.down.sql` is
a load-time error — every migration is reversible by construction, not by
convention. `down` requires `--yes`.

Migrations run as a **one-shot compose service, never on app boot**: two
collector replicas racing through DDL is a corruption path.

When an applied migration turns out to state something false, the correction is
a **new migration**, not an edit to the applied one — see 011 and 012, which
corrected 005's claim about exit codes.

Per-migration rollback cost is tabulated in [schema.md](schema.md).

---

## The dashboard

Next.js App Router, React 19, Tailwind v4. Server components only — no client
data fetching, no API layer.

- The pool sets `default_transaction_read_only=on`, so it is read-only at the
  database, not by convention.
- The pool is **lazy** (`getPool()`), because `next build` imports every route
  module and would otherwise require a live database at build time.
- All SQL is in one module so the indexes that justify it can be checked against
  it, rather than scattered through components where that correspondence rots.
- **Keyset pagination** on `(started_at, id)`, not OFFSET: OFFSET re-scans and
  discards every preceding row, so page 100 would cost 100× page 1.
- Prompt previews are truncated **in SQL**, so a 500 KB prompt is never
  transferred to show 200 characters.
- A data-quality banner states, up front, exactly where the numbers are
  incomplete. A dashboard that renders only what it knows quietly implies it
  knows everything.
