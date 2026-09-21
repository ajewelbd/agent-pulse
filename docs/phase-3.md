# Phase 3 — Compose, path translation, and the Claude Code adapter

Everything below was run against the real 31 transcripts in `~/.claude`, not a
fixture. Results in [Verification](#verification).

## What landed

```
compose.yaml / compose.dev.yaml     4 services, all ports 127.0.0.1-bound
Makefile                            up / dev / migrate / backup / install-hooks / uid
scripts/install-hooks.sh            host-side hook installer (idempotent, reversible)
apps/collector/
  src/paths.ts       + .test.ts     path translation, both edges   (14 tests)
  src/config.ts                     env parsing and validation
  src/redaction.ts                  11-pattern pipeline, pre-insert
  src/db.ts                         idempotent writes
  src/watcher.ts                    inotify | poll | auto (with probe)
  src/server.ts                     Layer 2 hook receiver
  src/ingest.ts                     shared agent-agnostic pipeline
  src/adapters/types.ts             the adapter contract
  src/adapters/claude-code.ts       Layer 1 tailer
  src/main.ts                       startup assertions → backfill → live tail
packages/schema/migrations/008, 009 two bugs found by running it (below)
```

## Running it

```bash
make uid                 # put HOST_UID/HOST_GID in .env
cp .env.example .env     # (a generated .env is already present)
make up                  # postgres + migrate + collector
make logs
make install-hooks       # host-side; takes effect in your NEXT agent session
```

`proxy` and `web` are declared in `compose.yaml` under the `phase4` / `phase5`
profiles — the topology is reviewable now, and `docker compose up` still works
because profiled services do not start.

## The adapter, and how its rules were derived

The one rule that matters is **what starts a turn**. Too loose and every tool
result becomes a phantom turn (8,883 candidates in this corpus); too strict and
whole conversations vanish. It was derived empirically, not assumed:

| Signal | Records | Verdict |
|---|---|---|
| `origin.kind === 'human'` | 449 | **real prompt** (authoritative, v2.1.204+) |
| `origin.kind === 'task-notification'` | 17 | not a prompt |
| content has a `tool_result` block | 8,883 | not a prompt — these are tool results stored as `type: "user"` |
| XML injections (`<ide_opened_file>`, `<command-name>`, …) | 109 | not a prompt |
| compaction summaries | 73 | **not a prompt** — see below |
| `[Request interrupted by user]` | 25 | not a prompt |
| `isMeta` skill preambles | 17 | not a prompt |

Two findings worth calling out:

**Version drift.** `origin` does not exist before v2.1.204, and in those
transcripts a genuine human prompt and an `<ide_opened_file>` injection are
*indistinguishable by metadata* — both carry `promptSource: "sdk"`. So the
adapter has an explicit legacy path that falls back to content shape. Without
it, every pre-2.1.204 session is silently empty.

**Compaction summaries are the trap.** When a session resumes after context
compaction, Claude Code injects a `user` record beginning *"This session is
being continued from a previous conversation…"* — prose, no `origin`. It looks
exactly like a human prompt. 73 of them exist here, and treating them as turn
starts would invent a phantom turn at every compaction boundary.

`<ide_opened_file>` turned out **not** to be a false positive: it arrives as the
first of two text blocks on a genuinely human message, the second being the real
prompt. Those are real turns, and `prompt_text` keeps the injection prefix
verbatim — the spec asks for the full prompt, so nothing is stripped.

Validated independently: a Python reimplementation of the rule counts **464
turns across 22 transcripts**, and the collector ingested exactly 464 before
dedupe. The 9 sub-agent files correctly yield zero human turns.

## Two bugs the real data found

Both were invisible in review and only appeared under a running tail.

### Migration 008 — duplicate turns on every poll

The tailer checkpoints at the **start** of the open turn, so a restart re-reads
it rather than losing it. That is only safe if the turn comes back with the
*same* seq — turns upsert on `(session_id, seq)`.

Deriving the resume seq from `max(seq) + 1` does the opposite: the open turn
already occupies `max(seq)`, so it returns as `max(seq)+1` every poll. Observed
live: one session grew from 129 real turns to 156 rows in minutes, unbounded.

Filtering the max by status does not fix it either — a legitimately closed
`aborted` turn would drop out of the max and the next turn would overwrite it.
So the checkpoint carries its own `next_seq`, advancing in the same transaction
as the rows it accounts for.

### Migration 009 — resumed sessions replay their history

`seq` is a position in a file, and **the file repeats itself**. In session
`10e3cf92`, prompt uuid `bd1bce1e` appears at line indexes **2, 1900 and 3454** —
Claude Code re-appends earlier records to the same transcript on resume. The
tailer faithfully read three turns at seq 1, 15 and 28.

Turn identity is therefore the agent's own prompt uuid, via a partial unique
index on `(session_id, external_turn_id)`. Deliberate consequence: `seq` stays
unique but becomes non-contiguous on resumed sessions, because a replayed turn
updates its original row. `seq` is an ordering key, not a count.

This is the spec's "resumed / continued sessions that append to an existing
transcript" edge case, met in real data.

Two smaller fixes, also from running it: PostgreSQL rejects `U+0000` in `text`
**and** `jsonb`, and real transcripts contain NUL bytes from captured terminal
output — one NUL was costing an entire transcript. And `gitBranch` is recorded
as the literal string `"HEAD"` on a detached HEAD, which would have offered
"HEAD" as a branch filter spanning unrelated repos; stored as a null branch per
spec.

## Path translation

`PathMapper` translates at both edges and refuses to guess:

- **Inbound** (hook event host path → container path to open).
- **Outbound** (container path → the host path stored in `projects.path`,
  `tool_calls.cwd`, `file_changes.path`).

Design points, each with a test:

- **Segment-boundary matching.** A naive `startsWith` makes `/host/code/root10`
  match the prefix `/host/code/root1` and corrupt the translation silently.
- **Split on the last colon.** Host roots here contain spaces
  (`/Volumes/Macintosh HD 1`), and a Windows path contains a drive colon.
- **Shadowing is refused at startup.** `PATH_MAP` is ordered and first-match-
  wins, so a shorter earlier prefix can leave a later mapping dead. That
  surfaces weeks later as "some projects have wrong paths"; it is now a startup
  error.
- **Unmapped paths throw** rather than being stored raw, and
  `assertHostPath()` is a final check before insert. The database's CHECK
  constraints are the backstop — verified never to fire in practice.

## Startup assertions

A missing mount must not degrade to "zero turns found" — that failure is
invisible. The collector refuses to start when an enabled agent's home is not
mounted, or when a `PATH_MAP` target directory does not exist, and names which.

It also asserts the schema is migrated, rather than failing later with a
confusing "relation does not exist".

## Layer 2 hook receiver

`POST /v1/hooks?event=<name>&agent=<key>` with an `X-Aiuo-Secret` header.
Auth verified: no secret → 401, wrong secret → 401, correct → 202. Constant-time
comparison. `/healthz` is unauthenticated (for the compose healthcheck) and
reveals nothing.

**Hook payloads are stored in `raw_events` verbatim and are not yet folded into
turns.** I still cannot verify the `PostToolUse` payload shape: I installed a
probe hook and it did not fire, because Claude Code reads `settings.json` at
**session start**. So writing a parser now would mean guessing a schema — which
is what the brief forbids. Storing every event loses nothing: once the real
shape is known, the enrichment pass reads it back out of `raw_events`, including
events captured in the meantime.

`make install-hooks` registers 9 events (PostToolUse, PostToolUseFailure,
UserPromptSubmit, SessionStart, SessionEnd, Stop, PreCompact, PostCompact,
PostModelSwitch). The installed hook script forwards stdin verbatim and never
parses it, so it survives payload changes; it has a 2s timeout and always exits
0, because a collector that is down must not break your coding session.

## Verification

Run 2026-09-18 against `postgres:16.14` and the real `~/.claude`.

**Backfill:** 31 transcripts → **439 turns, 7,932 tool calls, 1,959 file
changes, 1,477 diffs, 36,558 raw events, 11 projects, 22 sessions**, in ~13s.
(464 turns before dedupe; the 25 removed were replayed history.)

| Check | Result |
|---|---|
| Turn count vs independent Python analysis | 464 = 464 ✓ |
| Duplicate turn rows after dedupe | 0 |
| Counts stable across 20 poll cycles | yes (only this session's live transcript grew) |
| Full collector restart | exact no-op: `440/7941/1962/36606` before and after |
| Container paths in `projects.path` / `tool_calls.cwd` / `file_changes.path` | **0 / 0 / 0** |
| Turns with provider-reported tokens | 425 priced, 14 unpriced (correctly NULL cost) |
| Tool calls with an exit code | **0** — exactly as Phase 1 predicted |
| Tool calls with derived durations | 7,932, all flagged `duration_source='derived'` |
| Full-text search | matches on prompt + response |
| Hook auth (none / wrong / correct) | 401 / 401 / 202 |
| Hook idempotency (same payload twice) | stored 1, then 0 |
| Path translation unit tests | 14/14 |
| `pnpm -r typecheck` | clean |
| `docker compose config` (base + dev override) | valid |
| Published ports | all 4 bound to `127.0.0.1` |
| Host mounts | both `read_only: true` |
| `install-hooks` run 3× | 1 entry, not 3 |
| Pre-existing user hook + settings | survive install and uninstall |

## Open, and worth your attention

1. **The `PostToolUse` payload** — since verified by reading the schema
   compiled into claude-code 2.1.278; see [hook-payloads.md](hook-payloads.md).
   It unlocks measured durations, but **not** exit codes: the sentence above
   claiming otherwise was written from assumption, and the Bash tool result
   has no exit status field at all.

2. **Sanity-check the cost figures.** Backfill totals ~$4.4k across 439 turns.
   The arithmetic is consistent (cache reads dominate — one turn read 23.5M
   cached tokens across 59 tool calls), and rates were verified 2026-09-11, but
   these are *derived*, not billing-authoritative. Worth comparing against a
   real invoice before anyone treats the dashboard as ground truth.

3. **Only one code root is in `.env`.** `PATH_MAP` currently maps
   `/Volumes/Macintosh HD 1/Projects/Atom` only. Your transcripts also show
   `/Volumes/Macintosh HD 1/Practice`. Add `CODE_ROOT_2` plus a matching
   `PATH_MAP` entry and bind mount, or turns under it will be skipped — loudly,
   by the startup assertion.

4. **Sub-agent token double-counting is not yet handled.** Sidechain sessions
   are ingested as child sessions with their own turns; the parent's summary
   record also reports the same totals. Aggregates that sum across parent and
   child would double-count. The parent summary currently lands in `raw_events`
   only, so this is not yet wrong — but Phase 5 must not sum both.

## Next: Phase 4 — remaining adapters + proxy

Blocked in part on the four agents not being installed. The proxy is not: it is
the only viable source for Copilot CLI, and the only way to get authoritative
`provider_source='proxy'` attribution for anything.
