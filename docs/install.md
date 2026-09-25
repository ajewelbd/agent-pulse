# Installer

One command sets AgentPulse up, either with Docker or natively (no Docker).

```bash
./install.sh              # asks Docker or native, then only what it cannot work out
make install              # the same; flags via ARGS="--native --yes"
```

Status: all five phases of the brief (`docs/requirements/agentpulse-installer-prompt.md`) are done.

| Mode | Verified on |
|---|---|
| Docker | macOS arm64, Docker Compose 5.5.1 |
| Native | macOS with launchd, and Ubuntu 24.04 with systemd (in a container, §14) |
| Docker on a Linux engine | **not verified yet** |

The first part of this file is for **using** the installer. §1–§14 are the build record: every finding, with how it was established.

---

## Using it

### Commands

| Command | Does |
|---|---|
| `./install.sh` | Install, or re-check an installed system. A re-run with nothing changed restarts nothing and writes nothing but the state file |
| `./install.sh --dry-run` | Resolve everything and print the plan and a masked table; change nothing |
| `./install.sh --upgrade` | Back up the database, rebuild (Docker: pull + build; native: `pnpm install` + build), migrate, restart |
| `./install.sh --uninstall` | Stop and remove the services. **The database is kept**, and so are `.env` and `backups/` |
| `./install.sh --uninstall --purge` | Also delete the database, after you type `delete <name>` and a backup succeeds. Refused with `--yes` |
| `make install` / `make uninstall` | The same two, with `ARGS="…"` for flags |

### Flags

| Flag | Meaning |
|---|---|
| `--docker`, `--native` | Choose the mode. Otherwise it is asked, defaulting to Docker when Docker + Compose v2+ work. A re-run uses the mode already installed |
| `--yes`, `--non-interactive` | Never prompt. Exit 2 listing every value that could not be resolved. Never installs a system package |
| `--env-file PATH` | Extra values, below your shell and the existing `.env` in precedence |
| `--reconfigure` | Ask again for values already in `.env`. Secrets are kept |
| `--with-hooks`, `--no-hooks` | Install (or, with `--uninstall`, remove) the Claude Code hooks, or skip them. Otherwise it asks; under `--yes` it leaves them as they are |

**Exit codes:** `0` ok, `1` preflight failed (or a refused purge / failed backup), `2` configuration unresolved or invalid, `3` a health or port check failed.

### Where values come from

For each variable in `.env.example`, the first source that has a value wins:
1. your shell
2. the existing `.env`
3. `--env-file`
4. detected on this machine
5. generated (secrets only, `openssl rand -hex 32`)
6. asked
7. the `.env.example` default

The confirmation table shows the source of every value, with secrets masked (`abcd…(64)`). A secret is never regenerated once set, and never echoed, logged or passed as a command-line argument.

**You will be asked for:**
- **`CODE_ROOT_1`**, the code tree to collect from (suggestions: `~/code`, `~/projects`, the repo's parent), plus any more roots.
- Whether to collect each agent it found transcripts for.
- A busy port: it proposes the next free one.
- On a first install, an optional `ANTHROPIC_API_KEY` for compaction. If one is already exported in your shell, it's saved only if you say so.

### What it creates

| | Docker | Native |
|---|---|---|
| Config | `.env` (mode 600; previous copy in `.env.bak.<UTC>`), `compose.override.yaml` (code roots 2…N) | `.env` (same) |
| Database | Volume `aiuo_pgdata` | `~/Library/Application Support/agentpulse/pgdata` (macOS) or `~/.local/share/agentpulse/pgdata` (Linux), a dedicated PostgreSQL 16 cluster on `localhost` with no unix socket. Or, if you agree, a role + database on an existing 16 server |
| Services | The compose project `aiuo` | User units: `~/Library/LaunchAgents/com.agentpulse.*.plist` or `~/.config/systemd/user/agentpulse-*.service` |
| Logs | `docker compose logs` | `~/Library/Logs/agentpulse/` or `journalctl --user -u 'agentpulse-*'` |
| Backups | `backups/aiuo-<UTC>.dump` | `backups/agentpulse-<UTC>.dump` (both `pg_dump -Fc`, mode 600) |

Both modes also write `.install/state` and `.install/install.log` (no secrets in either).

### Native prerequisites

- **Node 20** and **pnpm 10.18.3** (corepack, which ships with Node, is enough).
- **PostgreSQL 16** server binaries.

If one is missing, the installer names the brew/apt/dnf/pacman command and runs it **only after you say yes**.

Node 20 is not in Debian 12's or Ubuntu 24.04's default repositories. There it asks you to install Node yourself, from nodejs.org or with `nvm install 20`.

On Linux, the services stop when you log out unless lingering is on (`loginctl enable-linger`). The installer offers to turn it on.

### Tests

```bash
make test-installer                               # 40 tests, plain bash, no Docker or network
scripts/installer/tests/docker-integration.sh     # real Docker; isolated project, ports 55xxx (a few minutes)
scripts/installer/tests/native-integration.sh     # real Node 20 + PostgreSQL 16 + launchd/systemd; ports 56xxx
make shellcheck                                   # shellcheck, or its Docker image when not installed
```

The integration scripts copy the repo, use their own project or instance name and ports, and remove everything they created when they exit, pass or fail. Three overrides exist for them, and are safe to use by hand:
- `AGENTPULSE_ROOT` (another checkout)
- `AGENTPULSE_COMPOSE_PROJECT` / `AGENTPULSE_INSTANCE` (another name)
- `AGENTPULSE_HEALTH_TIMEOUT` (seconds)

Two more affect the database choice:
- `AGENTPULSE_PG_ADMIN_URL` (reuse an existing server)
- `AGENTPULSE_PG_ANY_MAJOR=1` (allow a PostgreSQL major other than 16)

---

Every claim below cites a file + line or a command that was run
(macOS arm64, Darwin 25.5.0, 2026-09-24/25, unless a section says otherwise).

---

## 1. Environment variables

### 1a. Declared in `.env.example`

`.env.example` has two kinds of line: **active** (`VAR=value`) and **commented
examples** (`# VAR=value`). The parser has to read both. A commented one means
"exists, unset by default". The file has **no required/secret annotations**
(see decision D1).

| Var | Line | Class (proposed) | Default | Consumer | Evidence |
|---|---|---|---|---|---|
| `POSTGRES_USER` | 13 | optional | `aiuo` | postgres; compose builds each service's `DATABASE_URL` from it | compose.yaml:23,53,71,126,150 |
| `POSTGRES_PASSWORD` | 14 | **required, secret, generated** | placeholder `change-me-before-first-run`, which counts as unset | postgres, all `DATABASE_URL`s | compose.yaml:24 (`:?`) |
| `POSTGRES_DB` | 15 | optional | `aiuo` | postgres, `DATABASE_URL`s | compose.yaml:25 |
| `DATABASE_URL` | 19 | **derived**. Docker ignores it; native needs it | built from USER/PASSWORD/DB | native: migrate, collector, proxy, web | compose.yaml:53,71,126,150 override it; read at migrate.ts:102, collector config.ts:81, proxy config.ts:83, web lib/db.ts:21 |
| `POSTGRES_HOST_PORT` | 25 | optional, detected | `5433` | compose publish only | compose.yaml:30 |
| `COLLECTOR_HOST_PORT` | 26 | optional, detected | `4317` | compose publish; `install-hooks.sh --port` | compose.yaml:90; install-hooks.sh:18,23 |
| `PROXY_HOST_PORT` | 27 | optional, detected | `4318` | compose publish | compose.yaml:133 |
| `WEB_HOST_PORT` | 28 | optional, detected | `3000` | compose publish | compose.yaml:171 |
| `DATABASE_URL_HOST` | 32 | **derived**, not read by any code | — | people running psql from the host | not in any `process.env` grep of apps/*/src or packages/schema/src |
| `TZ` | 34 | optional | `UTC` | **no consumer in Docker**: compose hard-codes `TZ: UTC` | compose.yaml:15-16 |
| `REDACTION_DISABLED` | 52 | optional; the installer never sets `true` | `false` | collector, proxy | collector config.ts:72; proxy config.ts:74 |
| `COLLECTOR_MAX_STDOUT_BYTES` | 57 | optional | `8192` | collector | config.ts:87 |
| `COLLECTOR_MAX_DIFF_BYTES` | 58 | optional | `262144` | collector | config.ts:88 |
| `COLLECTOR_MAX_TURN_DIFF_BYTES` | 59 | optional | `2097152` | collector | config.ts:89 |
| `PROXY_DEFAULT_UPSTREAM` | 66 | optional | `https://api.anthropic.com` | proxy | proxy config.ts:86 |
| `PROXY_UPSTREAMS` | 67 (commented) | optional | empty | proxy | proxy config.ts:89 |
| `PROXY_MAX_STORED_BODY_BYTES` | 68 | optional | `65536` | proxy | proxy config.ts:92 |
| `CLAUDE_HOME` | 81 (commented) | optional, detected | `~/.claude` | compose mount source; `install-hooks.sh` reads it from the **process env, not `.env`** | compose.yaml:97; install-hooks.sh:28 |
| `GEMINI_HOME` | 82 (commented) | optional, detected | `~/.gemini` | compose mount source | compose.yaml:98 |
| `CODE_ROOT_1` | 83 (commented) | **required (Docker)**, prompted | — | compose mount source | compose.yaml:101 (`:?`) |
| `CODE_ROOT_2` | 84 (commented) | **required (Docker)**, prompted | — | compose mount source | compose.yaml:105 (`:?`), see F4 |
| `PATH_MAP` | 85 (commented) | **required**, detected + built | — | collector | compose.yaml:74 (`:?`); config.ts:84 |
| `WATCH_MODE` | 86 (commented) | optional, detected | `auto` | collector | config.ts:59-62 (`inotify\|poll\|auto`) |
| `WATCH_POLL_INTERVAL_MS` | 87 (commented) | optional | `2000` | collector | config.ts:86 |
| `COLLECTOR_SHARED_SECRET` | 88 (commented, empty) | **required, secret, generated** (min length 16) | — | collector, web, and baked into `~/.claude/aiuo/post-event.sh` | compose.yaml:73 (`:?`); config.ts:64-70; install-hooks.sh:38,146 |
| `AGENT_CLAUDE_CODE_ENABLED` | 89 (commented) | optional, detected | `true` | collector | config.ts:95; compose.yaml:81 |
| `AGENT_CODEX_CLI_ENABLED` … `AGENT_COPILOT_CLI_ENABLED` | 90-93 (commented) | optional; **no adapter exists**, so the installer keeps them `false` | `false` | collector (logs "no adapter yet") | config.ts:101-104; main.ts:216-236 |
| `AGENT_GEMINI_CLI_ENABLED` | 94 (commented) | optional, detected | **conflicting defaults**: compose `true`, code `false`, `.env.example` `false` | collector | compose.yaml:87; config.ts:105 (F5) |
| `ANTHROPIC_API_KEY` | 112 (commented) | optional, **secret**; ask before persisting | unset | web | app/api/compact/route.ts:225; models/route.ts:29 |
| `OLLAMA_BASE_URL` | 130 (commented) | optional, detected | `http://127.0.0.1:11434` (host); compose uses `host.docker.internal` | web | lib/ollama.ts:19; compose.yaml:160 |
| `COLLECTOR_URL` | 146 (commented) | native only, **derived** | `http://127.0.0.1:<COLLECTOR port>` | web | lib/compactionStore.ts:25; compose hard-codes it (compose.yaml:164) |

### 1b. Read by code or compose but **missing from `.env.example`** (brief: stop for review)

| Var | Read at | Why it matters to the installer |
|---|---|---|
| `HOST_UID`, `HOST_GID` | compose.yaml:67-68 (build args, defaults 501/20); Makefile:9-15 | Docker mode. Already in this machine's `.env` |
| `AGENT_CLAUDE_CODE_HOME`, `AGENT_GEMINI_CLI_HOME`, `AGENT_{CODEX_CLI,QWEN_CODE,CURSOR_CLI,COPILOT_CLI}_HOME` | config.ts:96,101-105 (default `/host/agents/*`); compose hard-codes two (compose.yaml:82,88) | **Essential for native mode.** Must be set to host paths there |
| `COLLECTOR_PORT` | config.ts:82 (default 4317); compose hard-codes it (compose.yaml:72) | Native: this is the listen port |
| `PROXY_PORT` | proxy config.ts:84 (default 4318); compose hard-codes it (compose.yaml:127) | Native: this is the listen port |
| `PROXY_MAX_BODY_BYTES`, `PROXY_MAX_CAPTURE_BYTES` | proxy config.ts:90-91 | Optional tuning |
| `LOG_LEVEL` | config.ts:91; compose.dev.yaml:17 | Optional |
| `AIUO_OPERATOR` | web app/layout.tsx:22 | Decorative avatar label |
| `PORT`, `HOSTNAME`, `NODE_ENV` | Next standalone `server.js:9` (`process.env.HOSTNAME \|\| '0.0.0.0'`); apps/web/Dockerfile (`PORT=3000 HOSTNAME=0.0.0.0`) | Native: the web bind address (see F2) |

---

## 2. How each service starts in Docker

| Service | Image / build | Command | Health |
|---|---|---|---|
| postgres | `postgres:16` | image default | `pg_isready -U -d` (compose.yaml:35-42) |
| migrate | packages/schema/Dockerfile | `node packages/schema/dist/migrate.js up`, one-shot, advisory lock (migrate.ts:151) | exit 0; others wait on `service_completed_successfully` |
| collector | apps/collector/Dockerfile | `node apps/collector/dist/main.js` | `GET /healthz` (server.ts:138) |
| proxy | apps/proxy/Dockerfile | `node apps/proxy/dist/main.js` | `GET /healthz` (main.ts:95) |
| web | apps/web/Dockerfile, **profile `phase5`** | `node apps/web/server.js` (Next standalone) | `GET /healthz` (app/healthz) |

- `make up` does **not** start web. `make web` does (`--profile phase5`), Makefile:17-28. The installer calls `make web` to get all four.
- Build order: schema first, then collector/proxy via `pnpm --filter "<app>..." run build`. Web builds on its own because it has no dependency on `@agentpulse/schema` (apps/web/package.json).
- All four Dockerfiles use `pnpm install --no-frozen-lockfile`. The brief wants `--frozen-lockfile` for native mode (see "I'm not sure" #1).
- Node: `engines: >=20`, every image is `node:20-bookworm-slim`, no `.nvmrc`, so native pins **major 20**. The package manager is **pnpm 10.18.3** (`packageManager` in package.json; `pnpm-lock.yaml` is tracked).

## 3. The read-only dashboard DB setup

There is **no read-only role**. The web pool connects as the same owner role,
using the same `DATABASE_URL`, and sets
`options: '-c timezone=UTC -c default_transaction_read_only=on'` per connection
(apps/web/src/lib/db.ts:35). Nothing in migrations or compose creates a
second role (`grep read_only` across migrations/compose.yaml).

**Native mirror:** nothing to create. Web gets the same `DATABASE_URL`. The
brief's "create the read-only role" step does not apply as the code stands.
A dedicated `ALTER ROLE … SET default_transaction_read_only=on` role would be
hardening, and an app change. I'm not proposing it unless you want it.

## 4. Can the collector run natively as-is?

**Paths: yes, with no code change.** Verified with the collector's own parser
(`node --input-type=module -e "import {PathMapper} from './apps/collector/dist/paths.js' …"`):

- An identity `PATH_MAP` (`$HOME/.claude:$HOME/.claude,…`) parses. `toHostIfMapped` and `toContainer` both return the input unchanged.
- `assertMounts` (main.ts:31-80) passes when `AGENT_<X>_HOME` is set to the host path. `stat` succeeds, the mapped home does not start with `/host/`, and every identity target exists.
- An **empty** `PATH_MAP` is rejected (paths.ts:90-92), so identity is the only option.
- Shadowing still applies. `$HOME` listed before `$HOME/.claude` throws. The more specific prefix listed first is fine (paths.ts:102-121, reproduced above). The builder must sort longest-prefix first.
- The DB `CHECK (… !~ '^/host/')` constraints (002:98, 005:55,101,102, 006:48,94) keep their meaning. A native path never starts with `/host/` unless the user's real directory is `/host`.

**Bind address: no. This blocks native mode.**

- **F1.** Collector `server.listen(options.port, '0.0.0.0')` (server.ts:125) and proxy `server.listen(config.port, '0.0.0.0')` (proxy main.ts:304) hard-code all interfaces. That is safe in Docker, where only `127.0.0.1:` is published. Natively, the collector's hook endpoint and the proxy would be reachable from the LAN. **Proposed minimal change (needs approval):** read `COLLECTOR_BIND_HOST` / `PROXY_BIND_HOST`, default `0.0.0.0` so Docker behaviour is unchanged, and have native units set `127.0.0.1`. Add both to `.env.example`.
- **F2.** Web is fine without a code change. The standalone `server.js` honours `HOSTNAME` (read in the built `.next/standalone/apps/web/server.js:9`), so native sets `HOSTNAME=127.0.0.1 PORT=<WEB port>`. Do **not** use `pnpm start` (`next start -p 3000`, apps/web/package.json), because its bind is not pinned.

## 5. Other findings

- **F3.** `.env` on this machine is mode `644` (`ls -la .env`). The brief wants `600`. The installer will fix this when it next writes `.env`. It is untouched for now.
- **F4.** `CODE_ROOT_2` is `:?`-required in compose.yaml:105, so a user with one code root has to edit compose.yaml, and roots 3+ need a new mount line. The installer must not edit compose.yaml. Options are in D3.
- **F5.** Gemini's default disagrees: compose says `true` (compose.yaml:87), code and `.env.example` say `false`. If `~/.gemini` is missing, Docker creates an empty mount source, and the collector starts "healthy" with nothing to read. The installer will always write `AGENT_GEMINI_CLI_ENABLED` explicitly.
- **F6.** `install-hooks.sh` reads the secret with `grep … | cut -d= -f2-` (line 38), so it would pick up any quotes too. The installer writes **unquoted** values. Hex secrets are safe. Paths with spaces (`/Volumes/Macintosh HD 1`) stay unquoted, and compose already accepts them in this machine's `.env`.
- **F7.** For the same reason, the native launchd wrapper must **parse** `.env` line by line, not `source` it. Unquoted spaces break `source`. systemd `EnvironmentFile=` takes the rest of the line, so it is fine.
- **F8.** `install-hooks.sh` defaults `--port 4317` and prints `ANTHROPIC_BASE_URL=http://127.0.0.1:4318` hard-coded (lines 18, 171). The installer passes `--port "$COLLECTOR_HOST_PORT"`. If the proxy port moves, the printed export is wrong. That needs a small script change (flag only).
- **F9.** `docker compose version` reports **v5.5.1**. The preflight check is "major ≥ 2", not "== 2".
- **F10.** `DATABASE_URL` and `DATABASE_URL_HOST` repeat the password. The installer derives both and never asks for them. The generated password is hex, so it needs no URL encoding.
- **F11.** No CI config in the repo (`ls .github .gitlab-ci.yml` → none), so there is no CI step to add.
- **F12.** `shellcheck` and `bats` are not installed here (`which`). Tests will be a plain-bash runner with no new dependency. shellcheck is dev-only, and until you install it the "shellcheck clean" claim is unverified.

## 6. Adapter discovery roots (for agent detection)

| Agent | Root the adapter scans | Evidence | This machine |
|---|---|---|---|
| claude_code | `<home>/projects/<slug>/*.jsonl` | adapters/claude-code.ts:490 | `~/.claude/projects`: 11 entries |
| gemini_cli | `<home>/tmp/<hash>/chats/session-*` | adapters/gemini-cli.ts:283-304 | `~/.gemini/tmp`: 8 entries |
| codex/qwen/cursor/copilot | no adapter | main.ts:216-224 | not detected, always `false` |

"Contains transcripts" = at least one file matching the pattern above.

## 7. Bash target

macOS ships **bash 3.2.57** (`/bin/bash --version`). The installer will be
**bash 3.2-compatible**: no associative arrays, no `${var,,}`, no `mapfile`.
So it needs no re-exec. Keeping to 3.2 is cheaper than adding a Homebrew-bash
dependency.

## 8. "I'm not sure"

| # | Question | Command that settles it |
|---|---|---|
| 1 | Does `pnpm-lock.yaml` match the manifests? The Dockerfiles skip `--frozen-lockfile`, so drift would go unnoticed | `cp -R . "$SCRATCH/x" && cd "$SCRATCH/x" && pnpm install --frozen-lockfile --ignore-scripts` |
| 2 | Does the collector fully boot natively (watcher, backfill) with identity paths? Only the parser and startup-check logic were exercised | Phase 4: run `node apps/collector/dist/main.js` against a scratch DB with identity env |
| 3 | Does `resolveWatchMode('auto')` pick inotify correctly on native macOS (FSEvents)? | Phase 4: read the `watch mode:` log line on native start |
| 4 | Is PostgreSQL 16 going to be installed natively here? Currently absent (`psql`, `pg_ctl` not found; `brew` present) | `brew info postgresql@16` |
| 5 | Is the host `pg_dump` output restorable into the Docker image's pg16 (same `-Fc` format)? | Phase 4: `pg_dump -Fc` then `pg_restore --list` |

## 9. Decisions (approved 2026-09-24, implemented)

- **D1 — `.env.example` tags.** One `# @…` tag line directly above every variable, with the legend at the top of the file. The parse rule: a line is a variable only if a tag line sits directly above it. That keeps prose such as `#   export ANTHROPIC_BASE_URL=…` out. 50 variables, all tagged (checked with awk over the file).
- **D2 — missing vars declared.** Everything in §1b is in `.env.example` now, plus `COLLECTOR_BIND_HOST` / `PROXY_BIND_HOST` from D4. Cross-check: every name in a `process.env` / `required` / `intEnv` / `boolEnv` read under apps/*/src and packages/schema/src, and every `${VAR}` in compose.yaml, appears in `.env.example`. The exceptions are `NODE_ENV`, and Next's `PORT`/`HOSTNAME`, which are documented as set by the native web unit.
- **D3 — code roots 2…N.** Option (a) turned out to be impossible. Compose rejects an empty volume entry (`${R2:+…}` unset gives `invalid empty volume spec`, tested with `docker compose config`). A placeholder source would defeat the "not mounted" startup check (main.ts:63-75). So:
  - compose.yaml keeps `CODE_ROOT_1` only.
  - `scripts/installer/compose-override.sh` writes a gitignored `compose.override.yaml` with one long-syntax read-only mount per `CODE_ROOT_N` (N ≥ 2). It reads process env first, then `.env`, like compose.
  - The script refuses a relative path, a missing directory, or a `compose.override.yaml` it did not write. It rewrites the file only when the content changes, and `--check` is available.
  - Compose auto-merges the file. `make up|web|dev|web-dev` run `make compose-override` first, and `DEV` names the file explicitly, because `-f` disables auto-merge.
  - Verified on this machine: `docker compose --profile phase5 config` before and after differs only by root2's `bind: {}`. Long syntax sets `create_host_path` to false, so a vanished root now fails at `up` instead of mounting an empty directory. Escaping of spaces, `"` and `$` was confirmed with a real `docker compose run` mount.
- **D4 — bind host.** Added `COLLECTOR_BIND_HOST` (config.ts, server.ts:125) and `PROXY_BIND_HOST` (proxy config.ts, main.ts:304). Both default to `0.0.0.0`, so Docker is unchanged; compose does not set them. The startup log now prints `host:port`. Typecheck clean; collector 43/43 and proxy 17/17 tests pass. A native bind to `127.0.0.1` has not been exercised at runtime yet (Phase 4).
- **D5 — `install-hooks.sh`.** Added `--proxy-port`. `--port` and `--proxy-port` now default to `COLLECTOR_HOST_PORT` / `PROXY_HOST_PORT` from `.env`, falling back to 4317 / 4318, and the printed `export` lines use the proxy port. This is identical to before when `.env` keeps the default ports.

## 10. Found while implementing

- **F13.** `make` is **not installed** on this machine. Running it pops the Xcode command-line-tools prompt (`make help` → `xcode-select: note: No developer tools were found`). The installer cannot depend on `make` for native mode, and on macOS Docker mode either. It will call the underlying commands (`docker compose …`, `scripts/…`) and keep `make install` as a thin alias.
- **F14.** Compose does not pass `AIUO_OPERATOR`, `LOG_LEVEL`, `PROXY_MAX_BODY_BYTES` or `PROXY_MAX_CAPTURE_BYTES` into any container (compose.yaml environment blocks), so in Docker they have no effect. They are tagged `@native` in `.env.example`. Passing them through would be a compose change — not done, flag only.

---

## 11. Phase 2 — env resolution and preflight

### Files

| File | Holds |
|---|---|
| `install.sh` | Flags, the run order, plan/summary output, writing `.env` and state |
| `scripts/installer/lib.sh` | Output and log, prompts, masking, OS and port detection, atomic write |
| `scripts/installer/env.sh` | `.env.example` and `.env` parsing, precedence, detection, derivation, validation, `PATH_MAP`, the table |
| `scripts/installer/docker.sh` | Docker/Compose probe, preflight, "is this port ours", pgdata check |
| `scripts/installer/native.sh` | Platform support and a prerequisites report (no installs yet) |
| `scripts/installer/tests/run.sh` | 22 tests, plain bash |

The installer runs on **bash 3.2**, macOS's `/bin/bash` (§7). It uses no arrays at all: an empty array under `set -u` is an error before bash 4.4.

### How a value is resolved

For each variable, in `.env.example` order: process env › existing `.env` › `--env-file` › detected › generated › prompt › `.env.example` default. An empty value counts as unset at every level, which matches the services' `required()`. Then:

- **`@derived`** variables are computed in a second pass, from the resolved values. A process-env value still wins. If an existing `.env` value differs, interactive mode asks, and `--yes` takes the derived value and marks it `changed` in the table. One exception: a `PATH_MAP` with the same entries in a different valid order is kept, so re-runs stay quiet.
- **Placeholders.** A `@generated` variable still holding its `.env.example` value counts as unset and is generated. The exception is `POSTGRES_PASSWORD` when the `aiuo_pgdata` volume exists. Postgres only reads that variable when it initialises an empty data directory, so a new value would lock you out. It is kept, with a note to rotate it by hand.
- **Secrets are never regenerated** once set. An optional secret found only in the shell (`ANTHROPIC_API_KEY`) is saved only if you say yes; `--yes` means no.
- **Other-mode variables** (`@native` in Docker mode, and the reverse) are kept as they are in `.env` and not validated.
- **Ports.** A port stays if it is free, or if this project's own container publishes it, which is what a re-run looks like; that check uses container labels. A busy *default* moves to the next free port, never to one another variable already took. A busy port you chose moves only with your yes; under `--yes` it is an error.
- **Code roots.** `CODE_ROOT_1` is required. `--yes` never guesses it, because a wrong root mounts the wrong tree. Interactively, the prompt suggests `~/code`, `~/projects` and the repo's parent (whichever exist), then offers more roots. `CODE_ROOT_3…` share `CODE_ROOT_2`'s tags.
- **Cross-checks,** mirroring the collector's startup (main.ts:31-80, 240): at least one agent with an adapter is enabled, each enabled agent's home exists, the four host ports are distinct, and `PATH_MAP` passes both checks below.

### PATH_MAP

- **Build.** One entry per enabled agent home and per code root, longest host prefix first, so `CODE_ROOT_1=$HOME` can't shadow `~/.claude`. Docker maps onto the compose targets (`/host/agents/*`, `/host/code/rootN`). Native maps each path onto itself (§4).
- **Validate.**
  - A bash port of `PathMapper.parse` (paths.ts:70-121) always runs.
  - The collector's own parser runs as well when `apps/collector/dist/paths.js` and `node` exist.
  - `test_path_map_matches_collector` runs 12 cases through both and asserts the same verdict and **the same message**.

### Writing

- `.env` is written only when the rendered content differs, after a `cp` to `.env.bak.<UTC>`. The write is atomic (temp file beside it, then `mv`), mode 600, values unquoted (F6).
- An unchanged `.env` with loose permissions just gets `chmod 600`, which fixes F3 on first run.
- Keys in the old `.env` that `.env.example` doesn't know are kept and flagged in the table.
- Values that would read back differently are refused, because compose expands `$`, treats ` #` as a comment, and strips quotes. The same applies to control characters and to leading or trailing spaces.
- `.install/state` records mode, phase, OS/arch, compose and node versions, and a timestamp. `.install/install.log` records every message plus the masked table.
- Tests assert that neither the secret nor the DB password appears in the state file, the log or stdout.
- `.env.bak.*` and `.install/` are gitignored. The backups hold the same secrets as `.env`.

### Verified on this machine

- `./install.sh --dry-run --yes --docker`: every value comes from `.env`, except two new active defaults (`PROXY_DEFAULT_UPSTREAM`, `PROXY_MAX_STORED_BODY_BYTES`). The running stack's ports (5434, 4317, 4318, 3000) are recognised as its own. `DATABASE_URL` is kept as "unused in docker mode". Nothing written: no `.env` change, no `.install/`.
- `./install.sh --dry-run --yes --native` exits 2 and names each port as "held by this project's Docker stack — run `docker compose down` before switching".
- Tests: `scripts/installer/tests/run.sh` → 22 passed, under `/bin/bash` 3.2.57. End-to-end tests run `install.sh` against a throwaway checkout (`AGENTPULSE_ROOT`) and HOME, with stub `docker`/`lsof`/`ss`, so they never touch the real `.env`, Docker or ports.
- `shellcheck` 0.11.0 (via `docker run koalaman/shellcheck:stable`) is clean on `install.sh`, `scripts/installer/*.sh`, the tests and `install-hooks.sh`. SC2034 is disabled per file, with the reason: the per-variable globals are read through `${!ref}`.

### Not verified / deviations

- **Linux and WSL paths are untested.** That covers `ss`, the `df` disk check, WSL `/mnt` detection and `systemctl --user`. It has only run on macOS.
- **Optional variables with a default are not prompted for** interactively. They take the default (source `default`) and appear in the confirmation table. Prompting all ~40 on every install seemed worse. The brief reserves defaults for `--yes`; say if you want a "change optional values?" step.
- **Optional `@prompt` variables** (`CODE_ROOT_2…`, `ANTHROPIC_API_KEY`) are asked only on a first install or with `--reconfigure`, so a re-run stays silent.
- **`--reconfigure` has no test yet.**
- `--upgrade`, `--uninstall` and `--purge` exit 1 with "not built yet (Phase 3)". `--with-hooks` and `--no-hooks` are accepted and noted.

---

## 12. Phase 3 — Docker mode

### Flow

| Action | Steps |
|---|---|
| install / re-run | resolve → write `.env` if changed → `compose-override.sh` → `docker compose up -d` → wait for health → check ports → hooks → summary |
| `--upgrade` | as above, but before `up`: if `<project>_pgdata` exists, start postgres if needed and **back up**; then `pull postgres` and `build --pull`. Any failure before `up` exits 1 with "the running stack was not touched" |
| `--uninstall` | `docker compose down`. Keeps the volume, `.env`, `backups/` and the images |
| `--uninstall --purge` | refused with `--yes`. Otherwise: type `delete <project>` → back up → `down -v`. A mismatch deletes nothing and exits 0; a failed backup deletes nothing and exits 1 |

- **One compose wrapper for every call** (`dc`, docker.sh). It passes `-p <project> --project-directory <root> --env-file <root>/.env -f compose.yaml -f compose.override.yaml --profile phase5`.
  - `-f` turns off compose's auto-merge of the override, so the override is named explicitly.
  - The profile adds web, as `make web` does.
  - No compose logic is repeated in the installer.
- **Why `up -d` without `--build`.** It builds images that are missing, recreates only containers whose config changed, and re-runs the one-shot `migrate`. So a re-run of an unchanged stack restarts nothing. Checked with a scratch busybox project: a second `up -d` re-ran the exited one-shot and left the long-running service alone. The real integration run confirms `collector` keeps its `StartedAt` across a re-run.
- **`make` is not called** (F13: not installed here). The installer runs what the targets run:
  - `make uid`: the UID/GID are detected.
  - `make web`: `up -d --profile phase5`.
  - `make backup`: the same `pg_dump -Fc` in the postgres container.
- **Backup.**
  - Written to `backups/<project>-<UTC>.dump`, the same name as `make backup` for project `aiuo`. Mode 600, dir mode 700.
  - Written to a `.partial` file first, and accepted only if it starts with the custom-format magic `PGDMP`. A failed dump never counts as a backup.
  - The user and DB come from `.env`. `make backup` instead reads `$${POSTGRES_USER:-aiuo}` from **make's** environment, which never loads `.env` (Makefile:48). **F15:** `make backup` dumps the wrong database if `POSTGRES_USER`/`POSTGRES_DB` were changed. Flag only.
- **Health** (`AGENTPULSE_HEALTH_TIMEOUT`, default 180 s): postgres container health is `healthy`; migrate is `exited 0` (any other exit fails at once, with its logs); collector, proxy and web answer `GET /healthz` on `127.0.0.1:<host port>`, from the host. The endpoints are server.ts:138, proxy main.ts:95, app/healthz. On timeout it prints the last 50 log lines of each pending service and exits 3.
- **Ports.** `docker compose port <svc> <container port>` must report `127.0.0.1:` for all four. Any other binding is logged as an error, **the offending services are stopped**, and the installer exits 3.
- **Hooks.**
  - The installer runs `scripts/install-hooks.sh --port <COLLECTOR_HOST_PORT> --proxy-port <PROXY_HOST_PORT>` with `ENV_FILE`/`CLAUDE_HOME` set.
  - When is it offered? It's skipped if claude_code is disabled, and skipped if the installed forwarder already posts to this port with this secret. That comparison is done in bash, so the secret is never passed as an argument. A re-run therefore makes no new `settings.json` backup.
  - `--with-hooks` installs and `--no-hooks` skips. Otherwise interactive mode asks (default yes), and `--yes` leaves them alone and prints the command.
  - On uninstall, hooks are removed only with `--with-hooks` or an interactive yes. A leftover forwarder fails silently: curl `--max-time 2`, `|| true` (install-hooks.sh:143-148).
- **State.** `.install/state` records `status=configured | healthy | uninstalled | purged`, `compose_project` and `last_backup`. A failed run leaves `configured`, and a re-run picks up from there, because every step can be repeated safely.
- **Test-only overrides**, documented rather than hidden: `AGENTPULSE_ROOT` (another checkout), `AGENTPULSE_COMPOSE_PROJECT` (another project name), `AGENTPULSE_HEALTH_TIMEOUT`.

### Verified

- `scripts/installer/tests/run.sh`: **33 passed** (bash 3.2). The 11 new tests use a stub `docker` that records every call and answers from control files. They cover:
  - project, override and profile are passed
  - no build on a plain install
  - a health timeout shows logs and exits 3
  - a migrate failure exits 3
  - a `0.0.0.0` binding gets the services stopped and exits 3
  - uninstall never uses `-v`
  - purge is refused under `--yes`
  - a wrong confirmation deletes nothing
  - purge runs backup-then-`down -v`, with the dump at mode 600
  - upgrade runs backup → pull → build → up
  - a failed backup stops the upgrade with no build, no `up` and no partial dump
  - hooks are installed once and left alone on a re-run
- `scripts/installer/tests/docker-integration.sh` against **real Docker** (Compose 5.5.1, macOS arm64), project `apit41259`, ports 55xxx, code roots with spaces in their paths. **All 18 checks passed** (an earlier version of this line said 23, a miscount):
  - install: exit 0, the three `/healthz` answer, root 2 is mounted from the override, no `0.0.0.0` publish, `.env` is mode 600
  - re-run: "No changes", collector not restarted
  - upgrade: healthy, the backup is `PGDMP` and `pg_restore --list` shows `schema_migrations`
  - uninstall: containers gone, volume kept
  - purge: a second backup is taken, then the volume is deleted
  - cleanup: no `apit*` containers or volumes left, and the live `aiuo` stack kept running throughout (`Up 2 hours`)
- On this machine, `./install.sh --dry-run --yes --docker` reports the existing hooks as "already installed and current". The uninstall `--purge` dry run lists confirm → backup → `down -v`.
- shellcheck 0.11.0: clean, including both test scripts.

### Not verified / notes

- Linux Docker Engine is still untested. That covers the `df` disk check, the `usermod -aG docker` hint, and `host-gateway`.
- The installer has **not been run for real on this machine's live stack**. That run would:
  - rewrite `.env`, adding the two proxy defaults, with a backup;
  - generate the override; and
  - recreate `collector`, because the root-2 mount switches from short to long syntax (§9 D3).

  I held back because it restarts your running stack. Say if you want it.

---

## 13. Phase 4 — native mode

### Flow

`preflight + prerequisites` → `choose database` → resolve env → confirm → write `.env` → `database` → (`--upgrade`: backup) → `build` → `migrate` → `services` → `health` → `ports` → hooks → summary.

| Step | What happens | Evidence |
|---|---|---|
| Prerequisites | Node **20**, read from `FROM node:20` in apps/collector/Dockerfile; pnpm **10.18.3** from `packageManager`, or corepack beside node; PostgreSQL **16** binaries (`initdb postgres psql pg_dump pg_isready`) from `pg_config`, Homebrew `postgresql@16`, `/usr/lib/postgresql/16/bin` or `/usr/pgsql-16/bin`. Other majors are refused unless `AGENTPULSE_PG_ANY_MAJOR=1`. A missing piece is offered through brew, apt, dnf or pacman **only with an interactive yes**. `--yes` never installs; it exits 1 with the command to run | native.sh `native_prereqs`, `pkg_command` |
| Database: own (default) | `initdb -U $POSTGRES_USER --pwfile` (password in a mode-600 temp file, removed right after), scram-sha-256, UTF8, en_US.UTF-8 when installed (what the postgres:16 image uses), else C. Cluster data lives in `~/Library/Application Support/<instance>/pgdata` or `$XDG_DATA_HOME/<instance>/pgdata`. Only for a cluster it created, the installer appends `listen_addresses='localhost'`, `unix_socket_directories=''` (no socket at all) and `timezone='UTC'`. Port comes from `-p $POSTGRES_HOST_PORT` in the unit | `native_init_cluster` |
| Database: reuse | Offered when an existing 16 server is reachable as a superuser. That means `AGENTPULSE_PG_ADMIN_URL` (process env only, never written), or this OS user on 127.0.0.1:5432, which is Homebrew's default. It creates a **non-superuser** login role and a database it owns. `btree_gist` (migration 001) is a trusted extension, so the owner can create it. A pre-existing role of the same name is refused. The server's port is fixed into `POSTGRES_HOST_PORT`. The server's configuration is never touched | `native_choose_pg`, `native_db_setup` |
| Read-only dashboard | Nothing to create: it's per connection (§3) | apps/web/src/lib/db.ts:35 |
| Build | `pnpm install --frozen-lockfile`, then `--filter "@agentpulse/collector..."`, `"@agentpulse/proxy..."` and `@agentpulse/web` builds, which is the Dockerfiles' order. `.next/static` is copied beside the standalone server, as apps/web/Dockerfile does. `NEXT_TELEMETRY_DISABLED=1` and `CI=true` are set. A re-run builds only what's missing; `--upgrade` always rebuilds | `native_build` |
| Migrate | `node packages/schema/dist/migrate.js up`, with `DATABASE_URL` passed in the environment | packages/schema/Dockerfile CMD |
| Services | One user unit each: postgres (own mode), collector, proxy, web. systemd: `~/.config/systemd/user/<instance>-<svc>.service` with `EnvironmentFile=.env`. launchd: `~/Library/LaunchAgents/com.<instance>.<svc>.plist` via `service-run.sh`, which reads `.env` with the installer's own parser. Details below. A unit restarts only when its file, the build or `.env` changed | services.sh |
| Bind | `COLLECTOR_BIND_HOST=PROXY_BIND_HOST=127.0.0.1` (derived, D4); web gets `HOSTNAME=127.0.0.1 PORT=$WEB_HOST_PORT` | F2 |
| Health | pg_isready, then `/healthz` on all three. On timeout, the last 50 log lines (journald, or `~/Library/Logs/<instance>/<svc>.log`) and exit 3 | `native_wait_healthy` |
| Ports | Every listener on each port must be loopback (`ss`, or `lsof -Fn`). Any other listener gets that service stopped and removed, then exit 3 | `native_verify_ports` |
| Backup | `pg_dump -Fc` over 127.0.0.1 with `PGPASSWORD` in the environment, into `backups/<instance>-<UTC>.dump`. Same `.partial` + `PGDMP` check as Docker (`backup_write`, lib.sh) | |
| Uninstall / purge | Uninstall removes the units and keeps the cluster, or the database on a reused server. Purge: typed `delete <instance>` → backup → units removed → delete the data dir (own mode; guarded so the path must end in the instance name and contain `PG_VERSION`) or drop the database and role (reuse mode). `--yes` refuses purge | `native_uninstall` |

Unit details:
- Forced values (`TZ=UTC`, `NODE_ENV=production`, the bind variables) go on the command line through `/usr/bin/env`. `EnvironmentFile=` overrides `Environment=`, so this is the only way they're guaranteed to win.
- On launchd, services restart on a crash (`KeepAlive.SuccessfulExit=false`). On systemd, `Restart=on-failure`.
- systemd user units stop at logout unless lingering is on. `loginctl enable-linger` is offered, never assumed.

### Found while building it

- **F16.** Under launchd, **postgres dies at start** with `FATAL: postmaster became multithreaded during startup — HINT: Set the LC_ALL environment variable to a valid locale`. launchd passes no locale. Seen in the first real run, with Homebrew 16.15, and Homebrew's own caveat says the same. The unit now starts postgres through `/usr/bin/env LC_ALL=<locale>`.
- **F17.** In SQL, `rolsuper` concatenated to text is `'true'`, not `'t'`, so the first superuser probe never matched. It now spells out `'t'`/`'f'`. Found by the integration run's reuse pass.
- **F18.** apps/web/Dockerfile doesn't set `NEXT_TELEMETRY_DISABLED`, so `next build` in Docker may send Next.js's anonymous build telemetry. That sits badly with "nothing leaves this machine". Native builds set it. Flag only; the Docker change is yours to make.
- "I'm not sure" §8, now settled:
  - #1: the lockfile is in sync (`pnpm install --frozen-lockfile` in a clean copy: "Done in 32s").
  - #2: the collector boots natively with an identity `PATH_MAP` (integration pass 1).
  - #4: PostgreSQL 16.15 installed with `brew install postgresql@16`, with your approval.
  - #5 is half settled: a native dump restores with `pg_restore --list`; restoring into the Docker image is not tested.
  - **#3 is still open:** which watch mode `auto` picks on native macOS. The logs were removed with the test instance. Settle it with `grep 'watch mode' ~/Library/Logs/agentpulse/collector.log` after a native install.

### Verified

- `scripts/installer/tests/run.sh`: **40 passed** (bash 3.2). The 7 new tests cover:
  - the systemd unit: quoting, `%` escaping, forced env via `/usr/bin/env`, dependency on the cluster, none in reuse mode
  - the launchd plist: XML escaping, and it passes `plutil -lint`
  - `service-run.sh`: spaces kept, quotes stripped, forced `TZ` beats `.env`
  - URL parsing with percent-encoded credentials, and the loopback classifier
  - an existing cluster locking the placeholder password
  - the reused server's port beating `.env`, with no "port busy" error
  - `--yes --native` with no Node exits 1 listing it, and the dry run still plans an identity `PATH_MAP` and 127.0.0.1 bind hosts
- `scripts/installer/tests/native-integration.sh` on **this Mac** (launchd, Node 20.11.1, PostgreSQL 16.15): **all 36 checks passed**. It used an isolated instance `apnt<pid>`, 56xxx ports, a repo copy and code roots with spaces in their paths.
  - Pass 1 (own cluster):
    - install exits 0; all three `/healthz` answer
    - all four ports listen on loopback only (the check now needs at least one listener)
    - `PG_VERSION` exists and there is no `/tmp` socket
    - `schema_migrations` is populated and the dashboard page renders
    - `.env` is mode 600
    - re-run: "No changes", build skipped, collector pid unchanged
    - upgrade: backup restorable, collector restarted
    - uninstall: unit gone, port closed, cluster kept
    - purge: second backup, data dir and postgres unit gone
  - Pass 2 (reuse a throwaway 16 server):
    - install exits 0 with the port fixed to 56432, and no own cluster
    - the role is **not** superuser
    - collector answers and the state file records `pg_mode=reuse`
    - purge drops the database and the role, and the server keeps running
  - Cleanup: no `apnt` LaunchAgents, data dirs or listeners left. The live Docker `aiuo` stack stayed up throughout.
- shellcheck 0.11.0: clean, including all three test scripts.

### Not verified

- **Linux / WSL2 native is written but not run.** That covers:
  - systemd user units, `EnvironmentFile=` with unquoted spaces (F7's claim), `daemon-reload` and `enable --now`
  - journald logs and `loginctl enable-linger`
  - the apt, dnf and pacman package selection. Node 20 is not in Debian 12's or Ubuntu 24.04's default repositories, so those print instructions rather than install.

  Settle it with `scripts/installer/tests/native-integration.sh` on a systemd host.
- Reuse through the **passwordless local probe** (no `AGENTPULSE_PG_ADMIN_URL`) was not exercised. Pass 2 used the URL.
- Switching an existing install between modes (Docker ↔ native) isn't handled. The resolver refuses ports held by the other stack; values such as `OLLAMA_BASE_URL=http://host.docker.internal:11434` carry over as they are.

---

## 14. Phase 5 — polish and a clean-machine run

### Added

- **Make targets** (Makefile), all in `make help`:
  - `make install` → `./install.sh $(ARGS)`
  - `make uninstall` → `./install.sh --uninstall $(ARGS)`
  - `make test-installer`
  - `make shellcheck`: local shellcheck, else `koalaman/shellcheck:stable`
  - `make test` now also runs the installer tests.

  Checked with `make help` and `make -n install ARGS="--native --yes"` in `debian:bookworm-slim`, because this Mac has no `make` (F13).
- **CI: none added.** The repo has no CI configuration (`ls .github .gitlab-ci.yml`: neither exists), and the brief adds a CI step only if one does. `make test-installer` and `make shellcheck` are what a CI job would run.
- **Docs.** "Using it" at the top of this file. The README quickstart now leads with `./install.sh`, with the manual steps kept below it. `docs/map.md`, `docs/operations.md` and `CLAUDE.md` are updated to match.

### Clean-machine run: Ubuntu 24.04 with systemd

A fresh `ubuntu:24.04` container with systemd as PID 1. It ran `--privileged --cgroupns=host` on Docker Desktop, arm64. The installer ran as an unprivileged user (`tester`, uid 1001) with passwordless sudo. Only Node 20 was pre-installed, from the nodejs.org tarball (v20.20.2), because Ubuntu's own `nodejs` is 18. This covers the Linux path that §13 listed as unverified.

| Check | Result |
|---|---|
| Unit tests on bash 5.2.21 and GNU tools | 40 passed |
| Dry run with no apt lists | "apt has no package lists yet. Run: sudo apt-get update — then re-run." This message is new: without lists, apt said "no package is known", which misleads |
| Dry run after `apt-get update` | "Install it with: sudo apt-get install -y postgresql-16" |
| **Interactive install**, answering `y` to that offer | The installer ran the apt install, then initdb, 4 systemd user units, build, migrate, health and ports. Exit 0 |
| Units | `agentpulse-{postgres,collector,proxy,web}.service`, all `active running` |
| Listeners (`ss -ltnH`) | `127.0.0.1:3000 4317 4318 5433` and `[::1]:5433` only |
| Collector journal | `mounts ok`, `database ok`, `watch mode: inotify (configured: auto)`, `hook receiver on 127.0.0.1:4317`. That settles §8 #3 on Linux; macOS native is still unobserved |
| Re-run after a unit change (see F20) | Units rewritten and restarted |
| Second re-run | "No changes to .env.", collector pid unchanged |
| `--uninstall --yes` | 0 units left, `pgdata/PG_VERSION` kept, `status=uninstalled`. The mode was taken from state with no `--native` flag |
| `native-integration.sh` | **All 36 checks passed**: install, re-run, upgrade, uninstall, purge, and the reuse pass. This includes a code root with spaces (`code root one`) through systemd's `EnvironmentFile=`, which settles F7 |

The container and both images it used were removed afterwards.

### Found in the clean-machine run

- **F19.** Arriving through `su`, `sudo -iu` or `docker exec` leaves no `XDG_RUNTIME_DIR`. `systemctl --user` then can't reach a user manager that is running, and native preflight failed with "needs systemd user units". The installer now sets `XDG_RUNTIME_DIR=/run/user/<uid>` when that directory exists, and the error message points at `loginctl enable-linger`.
- **F20.** Every journald line was tagged `env[pid]`, because the command starts with `/usr/bin/env`. Units now set `SyslogIdentifier=<instance>-<svc>`, and lines read `agentpulse-collector[29321]`.
- The integration scripts required a git checkout (`git ls-files` exited 128 in a copied tree). They now fall back to a tar copy that excludes `node_modules`, `dist`, `.next`, `.env*`, `.install`, `backups` and `compose.override.yaml`.

### Re-verified after the Phase 4 and 5 changes

- The Docker integration run again, because `docker_backup` moved into the shared `backup_write` in Phase 4: **all 18 checks passed**. No `apit` leftovers; the live `aiuo` stack stayed up.
- `run.sh`: 40 passed on macOS (bash 3.2.57) and Linux (bash 5.2.21).
- shellcheck 0.11.0: clean.

### Still not verified

- **Docker mode on a Linux Docker Engine.** That covers the `df` disk check, the `usermod -aG docker` hint, and `host-gateway`. Settle it with `scripts/installer/tests/docker-integration.sh` on a Linux host.
- **WSL2**, dnf/pacman package selection, and the reuse probe without `AGENTPULSE_PG_ADMIN_URL`.
- Switching an existing install between Docker and native.
- Running the installer on this machine's live Docker stack (§12). It hasn't been done: it would rewrite `.env` and restart the collector.

### Open flags (no change made; yours to decide)

| # | What |
|---|---|
| F5 | Gemini default: compose `true`, code `false` |
| F14 | Compose passes `AIUO_OPERATOR`, `LOG_LEVEL` and `PROXY_MAX_BODY/CAPTURE_BYTES` to no container |
| F15 | `make backup` reads `POSTGRES_USER`/`POSTGRES_DB` from make's environment, not `.env` |
| F18 | apps/web/Dockerfile doesn't set `NEXT_TELEMETRY_DISABLED` |
