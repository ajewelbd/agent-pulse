# Role

You are a senior backend/platform engineer. Build **"AI Usage Observability"** — a local-first system that records every interaction I have with CLI coding agents and exposes them in a dashboard.

---

## Target agents (v1)

Claude Code, Codex CLI, Qwen Code, Cursor CLI, GitHub Copilot CLI.

Design for N agents via a pluggable adapter interface. Adding an agent must mean writing one adapter + one config entry, nothing else.

---

## What a dashboard row must show

One row = one **turn** (one user prompt → one assistant completion), with:

1. **project** — repo/folder name + absolute path
2. **input prompt text** — full, searchable
3. **input token count** — plus `cache_read` / `cache_write` tokens when reported
4. **output response** — rendered as markdown
5. **output token count**
6. **executed shell commands** — ordered, with exit code + duration when available
7. **files added/modified/deleted** — path, change type, +/- line counts, and the unified diff of the change itself
8. **start time** (UTC)
9. **end time** (UTC), plus derived duration and cost
10. **provider** — `anthropic` / `openai` / `google` / `dashscope` / `openrouter` / `ollama` / `github-copilot` / `azure` / `unknown`. Distinct from the agent that invoked it.
11. **model name** exactly as the provider reported it, plus a normalized model id
12. **git branch** at the time of the turn, with HEAD sha and dirty-tree flag

---

## Architecture decisions (fixed — do not relitigate)

- **Storage:** PostgreSQL 16. Normalized tables + `raw_payload JSONB` on every ingested event for provenance and replay. `tsvector` GIN index for prompt/response search. No Mongo.
- **Deployment:** local-first. Nothing leaves the machine. Everything runs under Docker Compose — see [Running in Docker](#running-in-docker).
- **Collector:** Node 20 + TypeScript (file watching, NDJSON stream parsing, long-running process).
- **Dashboard:** Next.js (App Router) + Tailwind + server components. Read-only against Postgres.
- **Layout:** single monorepo — `apps/collector`, `apps/proxy`, `apps/web`, `packages/schema`.
- **Migrations:** versioned, reversible, with a documented rollback for each.

---

## Capture strategy — implement in this priority order per agent

### Layer 1 — session log tailer (primary)

Most CLI agents persist session transcripts as JSON/JSONL under a home directory. Tail these with a watcher, parse incrementally, resume from a byte-offset checkpoint so restarts don't re-ingest.

### Layer 2 — agent hooks (enrichment)

Where the agent exposes lifecycle hooks (session start, prompt submit, pre/post tool use, stop), register hook scripts that POST normalized events to the collector. This is the most reliable source for executed commands and file mutations, because it fires at execution time with real exit codes and real edit payloads.

### Layer 3 — local LLM proxy (fallback + ground truth)

A reverse proxy the agent is pointed at via its base-URL env var. It records request/response bodies and provider-reported `usage`. Use it for agents whose logs omit token counts, and to reconcile Layer 1 numbers.

### Provider attribution

The agent name does not imply the provider. Qwen Code may hit DashScope, OpenRouter, or a local Ollama; Cursor CLI and Copilot CLI route through their own gateways. Resolve provider in this precedence order and record which rule fired in `provider_source`:

1. `proxy` — the API host actually connected to (authoritative)
2. `config` — resolved base-URL env var / agent config at session start
3. `model_map` — lookup in `model_providers` by model id prefix (inference)
4. `unknown` — never guess past this point; leave null and flag it

Store the raw model string verbatim **and** a normalized id. Do not collapse `claude-sonnet-4-5-20250929` and `claude-sonnet-4-5` into one value at ingest — normalize in a generated column so the raw string survives.

> **CRITICAL:** Do not assume log file paths, directory layouts, or JSON shapes from memory. Inspect the actual machine first (`ls`/`find` under the relevant home directories, read a real session file, dump one full record). If a format cannot be determined, say so and ask me to run a command — do not invent a parser against a guessed schema.

---

## Data model requirements

Tables, at minimum:

- **`projects`** — path (unique), name, git remote, first_seen, last_seen
- **`sessions`** — agent, agent_version, project_id, external_session_id, provider, model_raw, model_normalized, provider_source, started_at, ended_at, source
- **`turns`** — session_id, seq, prompt_text, response_text, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, token_source, cost_usd, provider, model_raw, model_normalized, provider_source, git_branch, git_head_sha, git_dirty, started_at, ended_at, status (`complete|partial|error|aborted`)
- **`tool_calls`** — turn_id, tool_name, command, cwd, exit_code, stdout_excerpt, duration_ms, started_at
- **`file_changes`** — turn_id, path, change_type, lines_added, lines_removed, is_binary, is_truncated, blob_hash_before, blob_hash_after, attribution (`agent|uncertain`)
- **`file_change_diffs`** — file_change_id (1:1, separate table), unified_diff TEXT compressed, byte_size. Kept out of `file_changes` so the dashboard list query never TOASTs in multi-MB diffs it doesn't render.
- **`model_providers`** — model_id_prefix, provider, notes. Seed data, used only for Layer-3-absent inference.
- **`raw_events`** — source, external_id, payload JSONB, ingested_at
- **`model_pricing`** — provider, model, input/output/cache rates, effective_from

### Constraints

- `UNIQUE (source, external_id)` on `raw_events` → ingestion is idempotent. Re-running the collector over the same logs must be a no-op.
- Every timestamp `timestamptz`, stored UTC.
- Flag whether token counts are provider-reported or locally estimated (`token_source` enum). Never silently mix them.
- Cost is keyed on **`(provider, model)`**, not model alone — the same model id through OpenRouter or Bedrock prices differently than direct. Computed at ingest and stored; never recomputed retroactively.
- `sessions` and `turns` both carry provider/model. A session can switch model mid-flight (fallback, `/model` command, rate-limit downgrade) — the **turn** value wins for all reporting.
- `turns` carries git branch/sha/dirty, captured per turn, not per session: a checkout mid-session is normal.
- Indexes justified against the actual dashboard queries — state the query plan concern for each (e.g. `(project_id, started_at DESC)` for the project timeline; partial index on `status='partial'` for the reconciler).

---

## Diff capture — implement explicitly

Prefer agent-reported edit payloads over git, and use git only to fill gaps.

- **From hooks (best):** post-tool-use events for edit/write tools usually carry the old and new content, or the exact replacement pair. Compute the unified diff from that payload. This is correct even in a dirty tree and even for untracked files.
- **From git (gap fill):** record `git rev-parse HEAD` + `git status --porcelain` at turn start, diff against turn end. Known failure: a concurrent human edit in another terminal gets attributed to the agent. Detect by comparing `blob_hash_before` against the hash the agent reported; on mismatch mark the file_change `attribution=uncertain` rather than dropping it.
- **Caps:** default 256KB per diff, 2MB per turn. Over cap → store head+tail with `is_truncated=true`, never silently drop the row. Binary files get change_type + sizes, no diff body.
- **Git edge cases:** detached HEAD (store sha, null branch), git worktrees, submodules, bare/no repo, `.git` present but no commits yet, branch renamed mid-session, files outside the repo root.
- Diffs contain the same secrets prompts do. The redaction pipeline runs over diff bodies before insert, same `redaction_version`.

---

## Edge cases the implementation must handle explicitly

- Resumed / continued sessions that append to an existing transcript
- Sub-agents and parallel tasks producing nested or interleaved turns
- Streaming responses where the turn is written incrementally → turn stays `partial` until a terminal event; a reconciler closes stale partials after a timeout
- Compaction / context-summarization events that rewrite history
- Same-project work from multiple agents concurrently
- Agent invoked outside a git repo → project resolution falls back to cwd
- Log rotation, truncation, and files deleted mid-tail
- Backfill mode: ingest all pre-existing history on first run, then switch to live tail
- Conflicting data for the same turn across layers → precedence `hooks > logs > proxy`, with the loser kept in `raw_events`

---

## Running in Docker

Four services in one `compose.yaml`:

| service     | purpose                     | published             |
|-------------|-----------------------------|-----------------------|
| `postgres`  | storage                     | `127.0.0.1:5433:5432` |
| `collector` | tailer + hook receiver      | `127.0.0.1:4317:4317` |
| `proxy`     | LLM reverse proxy (Layer 3) | `127.0.0.1:4318:4318` |
| `web`       | Next.js dashboard           | `127.0.0.1:3000:3000` |

`proxy` is a separate service from `collector` on purpose: restarting the proxy to change an upstream must not drop the tailer's file watches or checkpoints.

### Host mounts (collector only, all read-only)

The agents run on the **host**, not in a container. The collector reaches their state through bind mounts:

- agent session/config dirs → `/host/agents/<agent>` `:ro`
- my code roots (configurable list) → `/host/code/...` `:ro`
- a named volume for checkpoints/offsets — these MUST survive `down`/`up` or every restart re-ingests history

### Path translation (mandatory)

Container paths are not host paths. Config takes an ordered `PATH_MAP` of `host_prefix:container_prefix` pairs. Translate at **both** edges:

- **inbound:** hook events arrive from the host with host paths → map to container paths before touching the filesystem
- **outbound:** everything written to `projects.path`, `tool_calls.cwd`, `file_changes.path` is stored as the **host** path

Never store a `/host/...` path in the database. Add a startup assertion that fails loudly if a configured code root isn't actually mounted — a missing mount must not degrade to "zero turns found".

### File watching

Bind-mount inotify is unreliable on Docker Desktop (macOS/Windows) and fine on native Linux. Watcher takes `WATCH_MODE=inotify|poll|auto`; `auto` probes by writing to a scratch path in a mounted dir and falling back to polling if no event fires within N ms. Log which mode was chosen at startup. Polling interval configurable — default 2s.

### Git inside the container

- `git` installed in the collector image.
- Container UID/GID settable via build args so it matches my host user; document how to find it. Otherwise `git` rejects the repo with *detected dubious ownership* and all git-based gap fill silently returns nothing.
- Run `git config --global --add safe.directory '*'` in the image as a belt-and-braces fallback. Safe here: mounts are read-only.
- If git is unusable for a repo, mark those turns `attribution=uncertain` and surface a dashboard warning. Do not fail the turn.

### Host-side install script

`make install-hooks` (or equivalent) that writes the agent hook configs on the **host**, pointing at `http://127.0.0.1:4317`. Must be idempotent, must back up any existing hook config, and must print an uninstall command. Also emits the `export` lines for pointing each agent's base URL at the proxy — print them, don't edit my shell rc.

### Compose details

- `depends_on: postgres: condition: service_healthy`, with a real `pg_isready` healthcheck. Collector must also retry the connection with backoff rather than crash-looping.
- Named volume for pgdata. Document the backup command (`pg_dump` into a mounted dir) and the exact `down -v` footgun.
- Migrations run as a one-shot `migrate` service, not on app boot — two collector replicas racing migrations is a corruption path.
- `TZ=UTC` on every service.
- Separate `compose.dev.yaml` override with source bind-mounts + hot reload; base file is production-ish (multi-stage build, non-root user, `NODE_ENV`).
- Web talks to `postgres:5432` over the compose network, never through the published host port.
- `.env.example` with every variable, including `PATH_MAP`, `WATCH_MODE`, `COLLECTOR_SHARED_SECRET`, and per-agent enable flags.

---

## Security (call these out inline in code comments)

- Prompts, command output, and diffs routinely contain API keys, `.env` contents, and customer data. Ship a redaction pipeline that runs **before** insert, with a configurable pattern set, and store a `redaction_version` per row.
- Collector and proxy listeners bind `0.0.0.0` inside their containers but MUST be published as `127.0.0.1:PORT:PORT` in compose — a bare `PORT:PORT` exposes your full prompt history to the LAN, and Docker's publish rules bypass host firewalls. Shared-secret header on every collector endpoint regardless.
- All host mounts are `:ro`. The collector never writes to my repos or agent config directories.
- Cap stored stdout per tool call (configurable, default 8KB) to avoid unbounded rows.
- Retention policy + hard-delete endpoint by project or date range.

---

## Dashboard scope (v1)

- **Turn list** — filter by project, agent, provider, model, branch, date range; full-text search over prompt + response. Must not fetch diff bodies.
- **Turn detail** — prompt, rendered markdown response, command timeline, file change list with collapsible syntax-highlighted diffs.
- **Aggregates** — tokens and cost by day / project / agent / provider / model / branch, plus a provider × model breakdown.
- No auth (localhost-only), no multi-user, no write operations.

---

## Non-goals

Cloud sync, team features, billing integration, editing history, IDE plugins.

---

## Working agreement

- Phase the work and stop for my review between phases:
  1. **Format discovery report** for all five agents. Must include, per agent: does the transcript record provider or only model? does it record the resolved base URL? does it include edit payloads with old/new content, or only a file path? what hooks exist?
  2. Schema + migrations
  3. Compose skeleton + path translation + one adapter end-to-end
  4. Remaining adapters + proxy
  5. Dashboard
- Deliver working code, not pseudocode. Full files when I'll paste them back.
- When an API, config key, env var, or file path is uncertain — say **"I'm not sure"** and tell me what to run to find out. A wrong guess about a log format costs more than a question.
- Conventions: `snake_case` in SQL and PHP, `camelCase` in TS.
