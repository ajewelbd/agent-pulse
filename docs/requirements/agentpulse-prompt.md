# Role

You are a senior backend/platform engineer working on **"AgentPulse"** — a local-first system that records every interaction I have with CLI coding agents and exposes them in a dashboard.

Phases 1–5 are built. This brief describes the system **as it exists in the codebase**, and marks what is still open. Read [CLAUDE.md](../../CLAUDE.md), [architecture.md](../architecture.md) and [map.md](../map.md) before changing anything.

Status markers used below: ✅ built · ⚠️ partial · ❌ not built.

---

## Target agents

v1 targets: Claude Code, Codex CLI, Qwen Code, Cursor CLI, GitHub Copilot CLI. Gemini CLI was added later as a second verified format.

| Agent | Adapter | Status |
|---|---|---|
| Claude Code | `apps/collector/src/adapters/claude-code.ts` | ✅ verified, enabled |
| Gemini CLI | `apps/collector/src/adapters/gemini-cli.ts` | ✅ legacy JSON + JSONL (verified against 0.61.0, 2026-09-24); enabled by default in `compose.yaml`, off by default in `config.ts` |
| Codex CLI, Qwen Code, Cursor CLI | none | ❌ not installed on this machine — format unverified |
| GitHub Copilot CLI | none | ❌ `~/.copilot` writes no transcripts; Layer 3 proxy is the only viable source |

Adding an agent = one file in `apps/collector/src/adapters/` implementing `AgentAdapter` (`discover()` + `parse()`), one `case` in the registry in `main.ts`, plus its mount, `PATH_MAP` entry and `AGENT_<NAME>_ENABLED` flag. No migration, no change to `ingest.ts`. Agents and providers are **lookup tables**, not enums, so this stays true.

---

## What a dashboard row shows

One row = one **turn** (one user prompt → one assistant completion):

| # | Field | Status |
|---|---|---|
| 1 | project — name + absolute **host** path | ✅ |
| 2 | prompt text — full, redacted, full-text searchable | ✅ |
| 3 | input tokens + `cache_read` + `cache_write` (split 5m / 1h) and materialized `total_input_tokens` | ✅ |
| 4 | response — rendered markdown (no raw HTML injection) | ✅ |
| 5 | output tokens | ✅ |
| 6 | shell commands — ordered, with exit code + duration | ⚠️ commands ✅; durations are `derived` from transcripts; **exit codes are NULL ("unknown")** until hook enrichment is built |
| 7 | file changes — path, change type, +/- lines, unified diff | ✅ from agent edit payloads (Claude Code); Gemini records none |
| 8–9 | start / end (UTC), duration, cost | ✅ |
| 10 | provider, with `provider_source` | ✅ — all inferred (`model_map`) until the proxy carries real traffic |
| 11 | raw model string + normalized id (generated column) | ✅ |
| 12 | git branch, HEAD sha, dirty flag | ⚠️ branch from the Claude Code transcript only; **sha and dirty are always NULL** (git gap-fill not built) |

Also on the turn: status (`complete|partial|error|aborted`), prompt attachments (editor selection, open file, `@mentions`, screenshots), and provenance chips.

---

## Architecture (fixed — do not relitigate)

- **Storage:** PostgreSQL 16. Normalized tables + `raw_payload JSONB`. `tsvector` GIN search (input capped at 512 KB per field).
- **Deployment:** Docker Compose, local-first. Every port published on `127.0.0.1` only.
- **Collector + proxy:** Node 20 + TypeScript, separate services.
- **Dashboard:** Next.js App Router, React 19, Tailwind v4, server components. Read-only connection (`default_transaction_read_only=on`).
- **Layout:** monorepo — `apps/collector`, `apps/proxy`, `apps/web`, `packages/schema`.
- **Migrations:** versioned, reversible, one transaction each, both directions checksummed. Never edit an applied migration.

---

## Capture layers

### Layer 1 — session log tailer ✅

- Adapters discover transcripts under read-only-mounted agent homes and emit `ParsedTurn`s; everything after (path translation, redaction, provider, cost, writes) is shared in `ingest.ts`.
- Checkpoints are **byte offsets in `ingest_checkpoints` (Postgres)**, not a volume file — they advance in the same transaction as the rows. Offset = start of the open turn, not EOF.
- External ids are content hashes, never line numbers (compaction rewrites transcripts).
- Rotation (inode change) and truncation (size < offset) → re-read from zero.
- One transaction per transcript; a failing file is named and counted in a `TRANSCRIPT(S) FAILED` line.
- Gemini files are re-parsed in full each time (rewritten in place / event log with `$set`); identity is the prompt message id.

### Layer 2 — hooks ⚠️

- `make install-hooks` (`scripts/install-hooks.sh`) registers 9 Claude Code hook events in `~/.claude/settings.json`. Idempotent, backs up, prints uninstall, prints base-URL `export` lines without editing the shell rc.
- Forwarder POSTs payloads verbatim to `POST /v1/hooks` with `X-Aiuo-Secret` (timing-safe compare). 2 s timeout, always exits 0.
- Stored unparsed in `raw_events`. Verified shape: [hook-payloads.md](../hook-payloads.md).
- ❌ **Enrichment pass not built** — folding `raw_events` into `tool_calls` (`exit_code`, measured `duration_ms`, `agent_id`). Sequence from the payload, not arrival order: PostToolUse may run concurrently.
- Exit codes come only from `PostToolUseFailure.error` (`"Exit code N"`). `PostToolUse` and the OTEL span carry none. Pre-hook history can never be backfilled.

### Layer 3 — LLM proxy ⚠️

- `apps/proxy` on `:4318`. Tees response chunks to the client, records a capped copy after delivery, no upstream timeout, swallows recording errors.
- Credential headers replaced with `[REDACTED]`; bodies redacted; stored in `proxy_requests`.
- `/_u/<name>/...` routes via `PROXY_UPSTREAMS`; default `PROXY_DEFAULT_UPSTREAM`.
- Usage extraction: Anthropic/OpenAI × streaming/non-streaming.
- Verified end-to-end with synthetic traffic (2026-09-21). ❌ **Never carried real agent traffic.**

### Layer 4 — OTLP receiver ❌

Not built.

### Reconciler ✅

- Closes `partial` turns older than 30 min.
- Correlates proxy calls to turns on `(model, time window)` with 2-min grace. Two candidate turns → `ambiguous`, left unmatched. No match after 30 min → `no_candidate`.
- Applies precedence per field. Does not reprice back-filled tokens.

### Precedence and provider attribution

- General precedence **hooks > logs > proxy**, field by field, never wholesale. Losers stay in `raw_events`.
- Provider: `proxy > config > model_map > unknown`, recorded in `provider_source`. The proxy wins provider unconditionally (it observed the host; logs can only infer).
- Tokens: proxy fills gaps only (`token_source = 'unknown'`), never overwrites provider-reported counts.
- `model_providers` seed maps prefixes (`claude-`, `gpt-`, `gemini-`, `qwen`, …) for inference only.

> **CRITICAL:** Do not assume log paths, layouts or JSON shapes from memory. Inspect the machine. If a format cannot be determined, say "I'm not sure" and give the command to run.

---

## Data model (as built — 15 tables, 8 enums, migrations 001–014)

| Table | Purpose |
|---|---|
| `agents`, `providers` | Lookup registries. Providers: `anthropic, openai, google, dashscope, openrouter, ollama, github-copilot, azure, aws-bedrock, google-vertex, unknown` |
| `redaction_versions` | Version ↔ pattern hash; services refuse to start on mismatch |
| `projects` | host path (unique), name, remote, first/last seen |
| `sessions` | agent, project, external id, parent session (sub-agents), provider/model, `provider_source` |
| `turns` | `(session_id, seq)` unique; prompt/response; token columns incl. 5m/1h cache writes; `token_source`; cost + `cost_source` + `pricing_id`; provider/model; git fields; status; denormalized `project_id`/`agent_id` held by composite FK |
| `tool_calls` | command, cwd, `exit_code` (NULL = unknown), stdout excerpt (8 KB cap), `duration_ms` + `duration_source` |
| `file_changes` | path, `old_path`, change type (`add|modify|delete|rename`), +/- lines, binary/truncated flags, blob hashes, `attribution` (`agent|uncertain`) |
| `file_change_diffs` | 1:1, lz4-compressed body. Never joined in a list query |
| `model_providers` | prefix → provider, inference only |
| `model_pricing` | `(provider, model)` rates, 5 buckets, `effective_from/to`, GiST `EXCLUDE` against overlap |
| `raw_events` | `UNIQUE (source, external_id)`; no FK to projects (survives cascade) |
| `ingest_checkpoints` | byte offset + resume seq per transcript host path |
| `proxy_requests` | Layer 3 records + correlation columns |
| `compactions` | stored compaction runs with their settings (migration 013) |

Enums: `capture_layer`, `token_source` (`provider|proxy|estimated|unknown`), `provider_source`, `turn_status`, `change_type`, `attribution`, `duration_source` (`reported|derived|unknown`), `cost_source` (`priced|unpriced|free_local`).

Full column list, index justification and per-migration rollback cost: [schema.md](../schema.md).

### Invariants (enforced in schema and code)

- **Absence is not zero** — NULL tokens "—", NULL cost "not priced", NULL exit code "unknown". `turns_cost_consistent` CHECK blocks an unpriced turn with a cost.
- **Cost is never recomputed** — computed at ingest over 5 buckets, stored with `pricing_id`. A price change is a new `model_pricing` row.
- **Host paths only** — CHECK rejects `/host/...` on every path column.
- **Idempotent writes** — turns on `(session_id, seq)`, raw events on `(source, external_id)`.
- Turn-level provider/model and git values win over session-level ones.

### Pricing seeds

- Anthropic (003) — verified against the pricing page 2026-09-11.
- Google Gemini (014) — operator-supplied 2026-09-24, not independently checked. No long-context tier; 3.7/3.8 Flash promo rows close 2027-01-01.
- ❌ No rate has been checked against an invoice. Totals are derived, not billing-authoritative.

---

## Diff capture

- ✅ **From agent payloads:** Claude Code `structuredPatch` rendered as unified diff; created files synthesized against `/dev/null` (their `structuredPatch` is always `[]`). `blob_hash_before` = sha256 of `originalFile`; `userModified` → `attribution = uncertain`.
- ✅ **Caps:** `COLLECTOR_MAX_DIFF_BYTES` 256 KB per diff, `COLLECTOR_MAX_TURN_DIFF_BYTES` 2 MB per turn; over cap → truncated with `is_truncated`, never dropped. Binary → no body.
- ✅ Redaction runs over diff bodies before insert.
- ❌ **Git gap-fill not built.** `git` is installed in the collector image (UID/GID build args, `safe.directory '*'`), but nothing calls it: no HEAD sha, no dirty flag, no git-derived diffs, no git edge-case handling (detached HEAD, worktrees, submodules, empty repos).

---

## Edge cases

| Case | Status |
|---|---|
| Resumed sessions replaying history | ✅ (migration 009) |
| Sub-agents / sidechains | ✅ ingested as child sessions. Parent summary lives only in `raw_events`; aggregates must not sum both |
| Streaming / partial turns | ✅ `partial` until terminal event; reconciler closes after 30 min |
| Compaction rewriting transcripts | ✅ content-hash ids; compaction summaries not treated as prompts |
| Outside a git repo | ✅ project falls back to cwd |
| Rotation / truncation / deletion | ✅ |
| Backfill then live tail | ✅ |
| Cross-layer conflicts | ✅ per-field precedence |
| Same project, multiple agents concurrently | ⚠️ supported by the model; untested with a second live agent |

---

## Docker

| Service | Purpose | Published |
|---|---|---|
| `postgres` | storage, `pg_isready` healthcheck | `127.0.0.1:${POSTGRES_HOST_PORT:-5433}:5432` |
| `migrate` | one-shot migrations (advisory-locked) | — |
| `collector` | tailer, hook receiver, reconciler | `127.0.0.1:${COLLECTOR_HOST_PORT:-4317}:4317` |
| `proxy` | Layer 3 | `127.0.0.1:${PROXY_HOST_PORT:-4318}:4318` |
| `web` | dashboard | `127.0.0.1:${WEB_HOST_PORT:-3000}:3000` |

- Agent homes mounted `:ro` at `/host/agents/<agent>`, code roots at `/host/code/...`. Named volume for pgdata only.
- `PATH_MAP` — ordered `host:container` pairs; segment-boundary matching, split on last colon, shadowing refused at startup. Translated inbound (hook events) and outbound (DB).
- Startup fails loudly if an enabled agent home is unmounted, lacks a `PATH_MAP` entry, or a `PATH_MAP` target is unmounted.
- `WATCH_MODE=inotify|poll|auto` (`auto` probes), `WATCH_POLL_INTERVAL_MS` default 2000.
- `TZ=UTC` everywhere; `compose.dev.yaml` adds bind mounts + hot reload.
- Web reaches postgres over the compose network; reaches the collector at `COLLECTOR_URL=http://collector:4317`.
- `.env.example` documents every variable.

Make targets: `help, uid, up, dev, web, web-dev, down, logs, migrate, migrate-status, backup, install-hooks, uninstall-hooks, typecheck, test, build, clean`.

**`docker compose down -v` deletes all history.** Run `make backup` first.

---

## Security

- ✅ Redaction before insert over prompts, responses, stdout, diffs and proxy bodies. Pattern set **compiled in** (`packages/schema/src/redaction.ts`); changing it requires bumping `Redactor.version`. Credential shapes only — not PII removal. See [redaction.md](../redaction.md).
- ✅ `127.0.0.1` publishing on every port; never `0.0.0.0`.
- ✅ Shared secret on `/v1/hooks` and `/v1/compactions`.
- ✅ All host mounts `:ro`.
- ✅ stdout cap `COLLECTOR_MAX_STDOUT_BYTES` (8 KB); proxy body cap `PROXY_MAX_STORED_BODY_BYTES` (64 KB).
- ❌ **Retention policy and hard-delete endpoint (by project or date range) not built.** When built, it must delete `raw_events` explicitly — no cascade reaches them.

---

## Dashboard

- ✅ **Turn list** — filters: project, agent, provider, model, branch, session (dropdown, narrowed by project), date range; full-text search; keyset pagination on `(started_at, id)`; no diff bodies; prompt previews truncated in SQL.
- ✅ **Turn detail** — prompt + attachments rail, markdown response, command timeline, collapsible diffs, cost and token working on info icons, JSON export.
- ✅ **Aggregates** — tokens and cost by day / project / agent / provider / model / branch, plus provider × model.
- ✅ **Health banner** — states where numbers are incomplete (inferred providers, unknown exit codes, unpriced turns).
- ✅ **Compaction** — pick turns (checkbox or drag to the floating dock) and fold them into one context block. Stage 1 (assembly, local, always runs) is distinct from stage 2 (optional summary via `ANTHROPIC_API_KEY` or local Ollama). Output always says which stage is shown. Runs from a turn's detail page are stored in `compactions` via the collector.
- No auth, no multi-user. The dashboard DB connection is read-only; its only write path is POSTing compactions to the collector. All UI SQL lives in `apps/web/src/lib/queries.ts`.

---

## Non-goals

Cloud sync, team features, billing integration, editing history, IDE plugins. The optional compaction summary is the only outbound call, and only on an explicit button press.

---

## Open work, in priority order

1. Hook enrichment pass → `tool_calls.exit_code`, `duration_ms` (`reported`), `agent_id`.
2. Route a real agent through the proxy to verify provider attribution and correlation.
3. Git gap-fill: HEAD sha, dirty flag, git-derived diffs with `attribution=uncertain` on blob-hash mismatch, and the git edge cases.
4. Retention policy + hard-delete by project or date range.
5. Check costs against a real invoice.
6. Adapters for Codex / Qwen / Cursor once installed and their formats inspected; Copilot via proxy only.
7. Layer 4 OTLP receiver.

---

## Working agreement

- Stop for my review between phases of work.
- Deliver working code, not pseudocode.
- When an API, config key, env var or path is uncertain, say **"I'm not sure"** and name the command that would settle it. New findings in `docs/` must cite how they were established.
- `snake_case` in SQL, `camelCase` in TypeScript; map at the query boundary.
- Commit and push only when explicitly asked in that message.
