# Gemini CLI & AgentPulse (`agentpulse`)

Local-first observability for CLI coding agents. Every interaction with an agent — prompt, response, command run, file changed, tokens spent — is recorded to a PostgreSQL database on this machine and browsable in a read-only dashboard. **Nothing leaves the machine.**

---

## Architecture & Monorepo Structure

- **`packages/schema`**: Shared types, reversible SQL migrations, and compiled-in redaction patterns.
- **`apps/collector`**: Layer 1 (log tailer for transcripts) and Layer 2 (hook receiver for event logs on port `4317`).
- **`apps/proxy`**: Layer 3 (local reverse proxy for model APIs on port `4318`, teeing streams and recording usage).
- **`apps/web`**: Read-only Next.js App Router dashboard (port `3000`) with `default_transaction_read_only = on`.

---

## Core Invariants & Rules

1. **Absence is not zero**: A missing token count renders as `"——"`, a missing cost as `"not priced"`, a missing exit code as `"unknown"` — never `0`, `$0.00`, or success. Enforced by database CHECK constraints and formatting utilities.
2. **Cost is never recomputed retroactively**: Cost is computed once at ingest and stored using `model_pricing`. Price changes insert new pricing rows; past turns retain their original cost and pricing reference.
3. **Provenance per fact**: Every record tracks its source (`token_source`, `provider_source`, `duration_source`, `cost_source`, `attribution`, `match_method`). Precedence is hooks > logs > proxy applied field by field.
4. **Host paths only in the DB**: `/host/...` paths are rejected by a CHECK constraint. Host-to-container translation uses `PATH_MAP`.
5. **Never break the agent**: The proxy and hook scripts are in the agent's critical path. Recording is best-effort and always happens after delivery. Hook script times out in 2s and exits 0.
6. **Never edit an applied migration**: The migration runner checksums both directions. Corrections require a new migration (e.g., 011, 012).
7. **Redaction contract**: Redaction runs before insert over prompts, responses, command outputs, diff bodies, and proxy request/response bodies. Bumping `Redactor.version` requires matching pattern hashes or services refuse to start.

---

## Conventions & Style

- **Naming**: `snake_case` in SQL, `camelCase` in TypeScript. Map types at the query boundary; no snake_case keys in TS types. Enums match SQL string values exactly.
- **Comments**: Explain *why*, not what. Match surrounding density.
- **Database Access**: All dashboard SQL lives in `apps/web/src/lib/queries.ts`. The dashboard database connection is strictly read-only (`default_transaction_read_only = on`).
- **Data Veracity**: Never infer from memory. Inspect actual files, payloads, and schemas on the machine.

---

## Development & Operations Commands

- **`make help`**: List all available Makefile targets.
- **`make up`**: Start PostgreSQL, run migrations, and start collector + proxy.
- **`make web`**: Start the Next.js dashboard at `http://127.0.0.1:3000`.
- **`make logs`**: Follow collector logs.
- **`make typecheck`**: Typecheck all packages (`tsc`).
- **`make test`**: Run unit tests across packages.
- **`make migrate-status`**: Check applied/pending database migrations.
- **`make backup`**: Run `pg_dump` into `./backups`.
