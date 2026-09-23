# Repo map

Every file in the repo and what it is responsible for. Line counts are
deliberately omitted — they rot the day after they are written.

For *why* things are shaped this way see [architecture.md](architecture.md);
for *how to run it* see [operations.md](operations.md).

---

## Top level

```
compose.yaml          4 services + pgdata volume. Every port bound to 127.0.0.1.
compose.dev.yaml      Dev override: source bind-mounts, hot reload, poll watching.
Makefile              Every workflow. `make help` lists them.
.env.example          Every variable, with the reason each exists.
.dockerignore         Keeps node_modules / dist / .next / .env out of the build context.
pnpm-workspace.yaml   apps/* and packages/*
README.md             Start here.
CLAUDE.md             Instructions for agents working in this repo.
```

`phase-1-format-discovery.md` sits at the root rather than in `docs/` because it
predates the directory and is cited by ingest code comments by that path.

## `packages/schema` — the shared contract

Everything that both the collector and the proxy must agree on.

| File | Responsibility |
|---|---|
| `src/types.ts` | camelCase TypeScript mirror of every table and enum |
| `src/redaction.ts` | The compiled-in pattern set, its version and its hash |
| `src/migrate.ts` | Migration runner: `up` / `down` / `status` / `verify` |
| `src/index.ts` | Re-exports `types` and `redaction` |
| `migrations/NNN_*.up.sql` / `.down.sql` | One transaction each, both directions checksummed |
| `Dockerfile` | The one-shot `migrate` service |

### Migrations

| # | Name | Contents |
|---|---|---|
| 001 | foundation | extensions, enums, `normalize_model_id()` |
| 002 | registry | `agents`, `providers`, `redaction_versions`, `projects` |
| 003 | reference | `model_providers`, `model_pricing` + seeded rates |
| 004 | core | `sessions`, `turns` |
| 005 | activity | `tool_calls`, `file_changes`, `file_change_diffs` |
| 006 | ingest | `raw_events`, `ingest_checkpoints` |
| 007 | indexes | every index |
| 008 | checkpoint_seq | resume seq on checkpoints, so a re-read turn keeps its number |
| 009 | turn_identity | turn identity constraints |
| 010 | proxy | `proxy_requests` and its correlation columns |
| 011 | exit_code_comment | corrects 005's false claim that PostToolUse carries exit codes |
| 012 | exit_code_from_hooks | documents the observed derivation rule from `PostToolUseFailure` |

011 and 012 exist because **an applied migration is never edited**. When one
turns out to state something false, the correction is a new migration.

## `apps/collector` — Layers 1 and 2

| File | Responsibility |
|---|---|
| `src/main.ts` | Entry point: startup assertions → backfill → live tail → reconciler loop |
| `src/config.ts` | Parses and validates the environment once, loudly, before any file is read |
| `src/paths.ts` | `PathMapper` — host ↔ container translation, shadowing detection, `/host/` refusal |
| `src/watcher.ts` | inotify vs poll; `auto` **probes** rather than assuming, and logs which it chose |
| `src/ingest.ts` | The agent-agnostic pipeline: translation, redaction, provider, cost, idempotent writes |
| `src/db.ts` | Every SQL statement the collector runs; `findPricing()` lives here |
| `src/server.ts` | Layer 2 hook receiver on `:4317` + `/healthz` |
| `src/reconciler.ts` | Closes stale partials; correlates proxy calls; applies precedence per field |
| `src/adapters/types.ts` | The `AgentAdapter` contract — `discover()` and `parse()` |
| `src/adapters/claude-code.ts` | The one verified adapter |
| `src/adapters/gemini-cli.ts` | Written, **unverified**, disabled by default |
| `src/paths.test.ts` | Path-translation cases |
| `src/redaction.test.ts` | Regression cases for the two credential leaks found in v1, + version assertion |

### Adding an agent

1. Write `src/adapters/<agent>.ts` implementing `AgentAdapter`.
2. Add one `case` to the registry in `main.ts`.
3. Add the mount, the `PATH_MAP` entry and the enable flag.

No migration, no change to `ingest.ts`. If the transcript format cannot be
determined from the actual machine, **stop there** — a parser written against a
guessed schema is worse than no parser, and an enabled agent with no adapter
logs a warning rather than silently ingesting nothing.

## `apps/proxy` — Layer 3

| File | Responsibility |
|---|---|
| `src/main.ts` | The proxy itself: forward, tee, record best-effort, never break the agent |
| `src/config.ts` | Separate from the collector's on purpose — shared config couples restart cycles |
| `src/providers.ts` | Upstream host → provider. The only *authoritative* attribution rule in the system |
| `src/usage.ts` | Usage extraction. Four shapes: Anthropic/OpenAI × streaming/non-streaming |
| `src/db.ts` | Writes `proxy_requests` |
| `src/usage.test.ts` | Extraction cases for all four shapes |

## `apps/web` — the dashboard

Read-only. Rendering is server components throughout; no client data fetching.
The only route handlers are the three that must return something other than a
page — health, the JSON export, and one prompt attachment's bytes.

| File | Responsibility |
|---|---|
| `src/lib/db.ts` | Lazy read-only pool (`default_transaction_read_only=on`) |
| `src/lib/queries.ts` | **Every** SQL statement the UI runs, in one place |
| `src/lib/format.ts` | Display rules, all enforcing "absence is not zero" |
| `src/lib/attachments.ts` | Recovers what the user attached to a prompt from the stored text |
| `src/lib/attachments.test.ts` | Parser regression cases, every fixture a real stored prompt |
| `src/app/page.tsx` | Turn list: filters, keyset pagination |
| `src/app/turns/[id]/page.tsx` | Turn detail: prompt, attachments, response, commands, diffs |
| `src/app/turns/[id]/export/route.ts` | One turn as JSON, provenance columns included |
| `src/app/turns/[id]/attachment/[idx]/route.ts` | One attached screenshot or document, decoded |
| `src/app/aggregates/page.tsx` | Rollups by day / project / agent / provider / model / branch |
| `src/app/healthz/route.ts` | `SELECT 1`; 503 on failure |
| `src/app/layout.tsx`, `globals.css`, `not-found.tsx` | Shell and theme |
| `src/components/TurnFilters.tsx` | Plain GET form — filter state lives in the URL, so views are linkable |
| `src/components/CommandTimeline.tsx` | Per-turn command list; NULL exit renders "unknown" |
| `src/components/DiffView.tsx` | Diff-syntax rendering, collapsed by default |
| `src/components/PromptAttachments.tsx` | The rail beside the prompt: screenshots, selection, open file, mentions |
| `src/components/ImagePreview.tsx` | Screenshot thumbnail + full-size preview overlay |
| `src/components/HealthBanner.tsx` | States where the numbers are incomplete, and what to do about each |
| `src/components/Chips.tsx` | Provenance chips — every one exists to make a *known unknown* visible |

### Prompt attachments

What the user sent with a prompt is not one thing, and it is not stored in one
place:

| Kind | Where it lives | How it is recovered |
|---|---|---|
| editor selection (path + line range + text) | inside `turns.prompt_text` | `parsePrompt()` |
| file open in the editor | inside `turns.prompt_text` | `parsePrompt()` |
| `@path` mention | inside `turns.prompt_text` | `parsePrompt()`, heuristic |
| screenshot / document | only in `raw_events.payload` | `getPromptMedia()` |

The text kinds are parsed from `prompt_text` rather than re-read from
`raw_events` **because `prompt_text` is redacted and the raw payload is not**.
Going back to the payload for them would route unredacted content to the page.

Screenshots have no redacted copy, so they can only come from the raw event.
They are shown on the turn detail page and never counted on the list: doing so
detoasts every prompt payload on the page — 276 ms for 25 rows against 2.3 ms
(EXPLAIN ANALYZE, 2026-09-22). Same rule that keeps diff bodies out of lists.

## `scripts`

| File | Responsibility |
|---|---|
| `install-hooks.sh` | Registers 9 hook events in `~/.claude/settings.json`. Idempotent, backs up, self-uninstalling, never touches your shell rc |

## `docs`

| File | Contents |
|---|---|
| `architecture.md` | How it fits together and why |
| `map.md` | This file |
| `operations.md` | Running, backup/restore, every failure mode hit so far |
| `schema.md` | Tables, constraints, per-migration rollback cost (written at Phase 2) |
| `redaction.md` | Coverage, the versioning contract, what is explicitly *not* covered |
| `hook-payloads.md` | The verified Claude Code hook payload reference |
| `phase-3.md` / `phase-4.md` / `phase-5.md` | Build logs with verification results |
| `requirements/` | The original specification (4 files) |

---

## Where to look when…

| You want to | Go to |
|---|---|
| change what a turn's cost is | `ingest.ts` → `computeCost()`, and the rates in migration 003 |
| add or fix a redaction pattern | `packages/schema/src/redaction.ts` — **and bump `version`** |
| change what the dashboard queries | `apps/web/src/lib/queries.ts`, nowhere else |
| change how prompt attachments are recognised | `apps/web/src/lib/attachments.ts` — **and add a case to its test** |
| support a new agent | `apps/collector/src/adapters/` |
| change how paths translate | `apps/collector/src/paths.ts` and `PATH_MAP` |
| understand why a turn has no provider | `reconciler.ts` → `applyProviderAttribution()` |
| understand why a turn is unpriced | `ingest.ts` → `computeCost()`, then `model_pricing` |
| add a table or column | a **new** migration — never edit an applied one |
