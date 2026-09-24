# AgentPulse

Local-first observability for CLI coding agents. Every interaction with an agent
— prompt, response, command run, file changed, tokens spent — is recorded to a
PostgreSQL database on this machine and browsable in a read-only dashboard.

**Nothing leaves the machine.** There is no telemetry, no upload, no account.
Every published port is bound to `127.0.0.1`.

---

## What it records

| | |
|---|---|
| **Turns** | prompt, response, model, tokens, cost, git branch + SHA, duration, status |
| **Commands** | tool name, command line, cwd, stdout excerpt, duration, exit code¹ |
| **File changes** | path, change type, lines ±, unified diff, attribution confidence |
| **Raw events** | the verbatim source record behind every row, for replay and audit |
| **Proxy calls** | upstream host, model, provider-reported usage — when Layer 3 is in use |

¹ Exit codes are only obtainable from hooks, and the pass that extracts them is
not written yet. See [Known gaps](#known-gaps).

## How it captures

Three independent layers, because no single one sees everything:

| Layer | Mechanism | Sees | Needs |
|---|---|---|---|
| **1 — logs** | tails the agent's own transcript files, read-only | full history, retroactively | nothing |
| **2 — hooks** | the agent POSTs events to the collector | measured durations, exact tool ids, subagent ids | `make install-hooks` |
| **3 — proxy** | a local reverse proxy in front of the model API | the real upstream host, usage for agents whose logs omit it | one env var |

Layer 1 alone gives you a complete, working dashboard. 2 and 3 add precision.
Full detail in [docs/architecture.md](docs/architecture.md).

---

## Requirements

- Docker with Compose v2
- Node 20+ and pnpm 10 — only for running things outside containers
- An agent that writes transcripts. Claude Code and Gemini CLI are verified.
  Gemini is on by default under compose; set `AGENT_GEMINI_CLI_ENABLED=false`
  if `~/.gemini` does not exist.

## Quickstart

```bash
cp .env.example .env
```

Then edit `.env`. Four values have no safe default and startup fails without them:

```bash
POSTGRES_PASSWORD=...              # anything, it never leaves this machine
COLLECTOR_SHARED_SECRET=...        # openssl rand -hex 32
CODE_ROOT_1=/absolute/path/to/your/code
CODE_ROOT_2=/another/path          # or delete that mount line in compose.yaml
```

`PATH_MAP` is the one that trips people up. It maps host paths to the container
paths they are mounted at, and it **must include the agent's home directory**,
not just your code roots:

```bash
CLAUDE_HOME=/Users/you/.claude
PATH_MAP=/Users/you/.claude:/host/agents/claude,/absolute/path/to/your/code:/host/code/root1,/another/path:/host/code/root2
```

Then:

```bash
make uid          # prints HOST_UID/HOST_GID — put them in .env
make up           # postgres + migrations + collector + proxy
make web          # dashboard at http://127.0.0.1:3000
```

The collector backfills all pre-existing history on first start, then tails.
`make logs` follows it.

### Optional: hooks and proxy

```bash
make install-hooks     # edits ~/.claude/settings.json; backs it up; prints the uninstall
export ANTHROPIC_BASE_URL=http://127.0.0.1:4318   # in the shell you launch the agent from
```

Neither is required. `make uninstall-hooks` reverses the first; unsetting the
variable reverses the second.

## Ports

All bound to `127.0.0.1`, all overridable in `.env` when something collides.

| Service | Default host port | Health |
|---|---|---|
| postgres | 5433 | `pg_isready` |
| collector | 4317 | `/healthz` |
| proxy | 4318 | `/healthz` |
| web | 3000 | `/healthz` |

## Common commands

```bash
make help              # every target, with descriptions
make down              # stop. Keeps your data.
make backup            # pg_dump into ./backups
make migrate-status    # applied / pending migrations
make typecheck         # every package
make test              # unit tests
```

---

## Security

This database is one of the most sensitive things on the machine: it holds every
prompt you ever typed, including whatever secrets those prompts contained.

- **Everything is bound to `127.0.0.1`.** Never change that to `0.0.0.0`.
  Docker's publish rules write their own firewall entries that bypass the host
  firewall — a bare `4317:4317` would expose your whole prompt history to the LAN.
- **All host mounts are read-only.** The collector cannot write to your repos or
  to an agent's config directory.
- **The hook endpoint requires a shared secret.** Without it any local process
  could post fabricated history — or read yours back.
- **Redaction runs before insert**, over prompts, responses, command output,
  diff bodies and proxy request bodies alike. The proxy additionally strips
  credential headers before anything is recorded. See [docs/redaction.md](docs/redaction.md).
- **Redaction is not PII removal.** It catches credential shapes. It does not
  catch names, addresses or anything else about people.
- `docker compose down -v` **deletes every byte of ingested history.** Plain
  `make down` is the safe form. Take a `make backup` first.

## Design rules

These are load-bearing, not style preferences. They are why the numbers can be
trusted:

- **Absence is not zero.** A missing token count renders as "—", a missing cost
  as "not priced", a missing exit code as "unknown" — never as 0, $0.00 or
  success. The schema's CHECK constraints enforce this and the UI must not undo it.
- **Cost is computed once at ingest and stored.** A price change inserts a new
  pricing row; it never rewrites what past turns cost.
- **Provenance is recorded per fact**, not per row: which layer supplied it,
  whether tokens were provider-reported or proxy-observed, whether a duration
  was measured or derived, whether a provider was observed or inferred.
- **Never break the agent.** The proxy sits in the path of every model call, so
  every recording step is best-effort and happens after the bytes are delivered.
  The hook script always exits 0.
- **Nothing is inferred from memory.** Every log path, payload shape and rate in
  here was read off this machine and the source is cited in the doc that records it.

## Known gaps

Stated plainly because the dashboard's own banner states them too:

| Gap | Effect |
|---|---|
| Hook enrichment pass not written | Exit codes, measured durations and subagent ids are captured in `raw_events` but not folded into `tool_calls` yet |
| Proxy has never carried real traffic | Every turn's provider is **inferred** from the model id, which cannot distinguish direct from gateway traffic |
| Costs never checked against an invoice | Anthropic rates are from a pricing page, Gemini rates were supplied by the operator; treat totals as derived, not billing-authoritative |
| Unpriced turns are excluded from totals | Cost totals **understate** spend rather than being wrong |
| Two agents verified | Claude Code and Gemini CLI. Codex, Qwen, Cursor and Copilot have no adapter |
| Git gap-fill not built | Branch comes from the transcript; HEAD sha and dirty flag are always empty |
| No retention / hard-delete | History only grows; delete by hand if needed (`make backup` first) |
| Layer 4 (OTLP receiver) not built | — |

## Documentation

| Doc | What's in it |
|---|---|
| [docs/architecture.md](docs/architecture.md) | How the pieces fit, and why each decision went the way it did |
| [docs/map.md](docs/map.md) | Every file in the repo and what it's responsible for |
| [docs/operations.md](docs/operations.md) | Running it, backing it up, and every failure mode hit so far |
| [docs/schema.md](docs/schema.md) | Tables, constraints, and per-migration rollback cost |
| [docs/redaction.md](docs/redaction.md) | What is redacted, what is not, and the versioning contract |
| [docs/hook-payloads.md](docs/hook-payloads.md) | The verified Claude Code hook payload reference |
| [docs/phase-3.md](docs/phase-3.md), [4](docs/phase-4.md), [5](docs/phase-5.md) | Build logs with verification results |
| [phase-1-format-discovery.md](phase-1-format-discovery.md) | The original format investigation on this machine |
| [docs/requirements/](docs/requirements/) | The original specification |
