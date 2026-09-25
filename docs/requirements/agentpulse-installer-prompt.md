# Role

You are a senior platform engineer working on **AgentPulse** (existing codebase, Phases 1–5 built). Your task: build a **one-command installer** that sets up AgentPulse either **with Docker** or **without Docker (native)**, resolving every environment variable automatically where possible and asking the user only for what it cannot determine.

Read `CLAUDE.md`, `docs/architecture.md`, `docs/map.md`, `docs/schema.md`, `.env.example`, `compose.yaml`, `compose.dev.yaml`, `Makefile`, `scripts/install-hooks.sh` and every service's config loader (`apps/*/src/config.ts` or equivalent) **before writing anything**. The architecture is fixed — do not relitigate it. The installer adapts to the app; the app does not change to suit the installer, except where this brief explicitly says so.

> **CRITICAL:** Do not assume env var names, defaults, paths, service entrypoints or build commands from memory. Derive them from the repo. If something cannot be determined, say **"I'm not sure"** and name the command or file that would settle it.

---

## Deliverable

A user runs **one command** from a fresh clone:

```bash
./install.sh            # interactive: asks Docker vs native, then only what's missing
./install.sh --docker   # skip the mode question
./install.sh --native
./install.sh --yes      # non-interactive: accept detected/default values, fail on any unresolved REQUIRED var
```

Also wire it into `make install` / `make uninstall` (add to `make help`).

### Flags (minimum)

| Flag | Behaviour |
|---|---|
| `--docker` / `--native` | Select mode; otherwise prompt (default = Docker if a working Docker + Compose v2 is found) |
| `--yes`, `--non-interactive` | Never prompt; exit non-zero listing every unresolved required variable |
| `--env-file <path>` | Read values from an extra file (lower precedence than process env) |
| `--dry-run` | Resolve and print the plan + masked env table; change nothing |
| `--reconfigure` | Re-ask for values already in `.env` |
| `--upgrade` | Pull/rebuild, back up, migrate, restart |
| `--uninstall` | Stop and remove services; **keep data unless `--purge` is also passed**, and require typed confirmation for `--purge` |
| `--with-hooks` / `--no-hooks` | Run / skip `make install-hooks` at the end (otherwise ask) |

The same script is **idempotent**: re-running on an installed system must be a no-op apart from reporting status, never regenerating secrets or wiping data.

---

## Environment variable resolution

`.env.example` is the **single source of truth** for which variables exist. Parse it; do not hardcode the list. If a variable is read in code but missing from `.env.example`, report it as a finding and stop for my review rather than guessing.

For every variable, resolve in this order and **record the source**:

1. **Process environment** (already exported in the user's shell)
2. **Existing `.env`** (previous install) — never overwrite silently
3. `--env-file`
4. **Auto-detection** (table below)
5. **Generated** (secrets only)
6. **Prompt the user** — show the `.env.example` comment as help text and the default, validate the input, re-ask on invalid
7. **Default from `.env.example`** (only in `--yes` mode, and only for non-required vars)

Classify each variable as `required | optional | secret | generated` from the `.env.example` comments and the config loaders. If that classification is not stated anywhere, say "I'm not sure" and propose annotating `.env.example` (e.g. `# @required`, `# @secret`) — stop for review before changing its format.

### Auto-detection

| What | How |
|---|---|
| Agent homes (`~/.claude`, `~/.gemini`, …) | Check existence of each adapter's discovery root **as defined in the adapter code**, not from memory. Set `AGENT_<NAME>_ENABLED=true` only for homes that exist and contain transcripts; ask to confirm |
| `PATH_MAP` | Build from detected agent homes + code roots (ask the user for code roots, suggest `$HOME/code`, `$HOME/projects`, cwd's parent). Must satisfy the existing rules: segment-boundary matching, no shadowing. Validate with the collector's own parser if it is importable; otherwise replicate its checks and cite the source line |
| UID / GID | `id -u` / `id -g` (same as `make uid`) |
| Host ports | `POSTGRES_HOST_PORT`, `COLLECTOR_HOST_PORT`, `PROXY_HOST_PORT`, `WEB_HOST_PORT` — keep defaults if free, otherwise propose the next free port and ask. Check with `ss -ltn` (Linux) / `lsof -iTCP -sTCP:LISTEN` (macOS) |
| `WATCH_MODE` | Leave `auto` unless on a filesystem known to break inotify (Docker Desktop on macOS, WSL `/mnt/*`) — then propose `poll` |
| `ANTHROPIC_API_KEY` / Ollama | If present in the process env, **ask before persisting it into `.env`** (it is optional and only used for compaction stage 2). Detect a local Ollama on `127.0.0.1:11434` and offer it |
| OS / arch | `uname -s`, `uname -m`; WSL via `/proc/version` |

### Secrets

- Generate the hook shared secret (`X-Aiuo-Secret` value) and DB passwords with `openssl rand -hex 32` (fallback `/dev/urandom` + `od`). Never regenerate if already set — the hook forwarder in `~/.claude/settings.json` depends on it.
- `.env` written with `umask 077` → mode `600`. Atomic write (temp file + `mv`). Back up the previous `.env` as `.env.bak.<UTC timestamp>` before any change.
- Secrets are **never** echoed, logged, or passed as CLI args (visible in `ps`). Mask in all output (`abcd…(64)`).

### Confirmation screen

Before writing anything, print a table: `VAR | value (masked if secret) | source (env|.env|detected|generated|prompt|default)` and ask to proceed. `--yes` skips the prompt but still prints the table.

---

## Mode A — Docker

1. Preflight: Docker daemon reachable, **Compose v2** (`docker compose version`), user can run docker without sudo (or explain the fix), required ports free, disk space for pgdata.
2. Write `.env`, then use the **existing** targets: `make uid` → `make up` (or `docker compose up -d --build`). Do not duplicate compose logic in the installer.
3. Wait for health: `postgres` healthy, `migrate` exited 0, then collector/proxy/web responding on `127.0.0.1`. Timeout with the failing service's last 50 log lines.
4. Verify every published port is bound to `127.0.0.1`, never `0.0.0.0` (`docker compose port` / `ss`). Fail loudly otherwise.
5. `--upgrade`: `make backup` **first**, then rebuild, migrate, restart. `--uninstall`: `docker compose down` — **never `down -v`** unless `--purge` with typed confirmation, and run `make backup` before purging.

## Mode B — Native (no Docker)

Supported targets: **Linux (systemd)** and **macOS (launchd)**. Windows only via WSL2 (Linux path). Say so up front and exit cleanly on anything else.

1. **Prerequisites** — check, and offer to install via the platform package manager (apt/dnf/pacman/brew) only with explicit consent:
   - Node 20 (exact major the repo pins — read `.nvmrc` / `engines` / Dockerfiles), and the repo's package manager (pnpm/npm/yarn — whichever the lockfile says)
   - PostgreSQL **16** (not "any Postgres"). Reuse an existing 16 server if the user agrees; otherwise install it. Refuse other majors unless the user overrides.
   - `git` (the collector image ships it for future gap-fill)
2. **Database** — create a dedicated DB, an owner role for migrate/collector/proxy, and the **read-only role/settings the dashboard uses** (`default_transaction_read_only=on`) exactly as the Docker setup does — find where that is configured and mirror it. `listen_addresses = 'localhost'` if the installer created the cluster. Never touch a pre-existing cluster's global config without consent.
3. **Build** — install deps with the lockfile (`--frozen-lockfile` / `npm ci`), build `packages/schema` then apps, in the order the Dockerfiles use.
4. **Migrate** — run the same migrate entrypoint the `migrate` service runs (advisory-locked). Never edit applied migrations.
5. **Paths — the key difference from Docker.** In native mode there is no `/host/...` layer: container path == host path. Determine from the collector code whether an **identity `PATH_MAP`** (or an empty one) satisfies the startup checks ("enabled agent home must have a `PATH_MAP` entry", "target must be mounted"). If the code cannot run natively without a change, **stop and report the minimal change** (e.g. a `DEPLOY_MODE=native` switch that skips mount checks but keeps the `/host/...` CHECK constraints meaningful) for my review. Do not patch it silently.
6. **Services** — one unit per long-running service (collector, proxy, web), with `TZ=UTC`, `EnvironmentFile=` pointing at `.env` (systemd) / an env wrapper (launchd), restart-on-failure, logs to journald / `~/Library/Logs/agentpulse/`. Prefer **user-level** units (`systemctl --user`, `~/Library/LaunchAgents`) so no root is needed after prerequisites. Ensure each binds `127.0.0.1` — confirm the bind-address env var name from code ("I'm not sure" if the services bind `0.0.0.0` by default; then that is a finding).
7. Health check, upgrade and uninstall semantics identical to Docker mode (backup before upgrade/purge; keep DB unless `--purge`). Native backup = `pg_dump -Fc`, matching what `make backup` produces if feasible.

---

## Post-install

- Offer `make install-hooks` (it is idempotent, backs up `settings.json`, and prints the proxy `export` lines — the installer must **not** edit shell rc files either; print the lines).
- Print: dashboard URL, which agents are enabled and which were skipped (and why), where `.env` and backups live, how to upgrade / uninstall, and the reminder that `docker compose down -v` deletes all history.
- Exit codes: `0` success, `1` preflight failed, `2` unresolved required vars in non-interactive mode, `3` health check failed.

---

## Engineering constraints

- **Bash only** (`#!/usr/bin/env bash`, `set -Eeuo pipefail`, `trap` for cleanup), POSIX tools, works on macOS's bash 3.2 **or** re-execs under a newer bash with a clear message — decide and state which. No new runtime dependency; any addition (e.g. `bats-core` for tests) must be justified and dev-only.
- Structure: `install.sh` (thin entrypoint) + `scripts/installer/{lib,env,docker,native,services}.sh`. Functions small and testable; `snake_case` function names.
- Every destructive or system-level step (package install, DB creation, unit install, purge) is announced, confirmable, and logged to `./.install/install.log` (secrets masked).
- Safe on partial failure: re-running resumes; state recorded in `./.install/state` (mode, versions, timestamp — **no secrets**).
- `shellcheck` clean. Add a CI step if a CI config exists in the repo.
- Tests: env-resolution precedence, `.env.example` parsing (comments, quotes, empty values, `=` inside values), `PATH_MAP` building/validation, port-conflict fallback, idempotent re-run, `--yes` failure listing.
- Document in `docs/install.md` — every finding cites how it was established (file + line, or command output).

---

## Phases (stop for my review after each)

1. **Discovery report** — full env var table from `.env.example` + config loaders (name, required?, secret?, default, consumer service); how each service is started in Docker; the read-only DB setup; whether the collector can run natively as-is. List every "I'm not sure" with the command that settles it.
2. **Env resolution + preflight** — the resolver, detection, prompts, confirmation screen, `--dry-run`, tests. No services started yet.
3. **Docker mode** end-to-end, including upgrade/uninstall.
4. **Native mode** — prerequisites, DB, build, migrate, services, health checks.
5. **Polish** — `make install/uninstall`, docs, shellcheck/CI, final test on a clean machine or container.

## Working agreement

- Working code, not pseudocode.
- Uncertain API, config key, env var, flag or path → "I'm not sure" + the command to check.
- Do not change application code, `compose.yaml` or migrations without flagging it and waiting for approval.
- Commit and push only when explicitly asked in that message.
