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
| 013 | compactions | `compactions` — operator-initiated compactions, with the settings that made each |

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
| `src/server.ts` | Layer 2 hook receiver on `:4317` + `/healthz` + `/v1/compactions` (the dashboard's only write path) |
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

Read-only, and still read-only: the compact panel is the one feature that
produces something to store, and it does not store it — it hands the finished
record to the collector, which owns every write in this system.

Rendering is server components throughout, with one exception: the compact
panel, which POSTs a list of turn ids and gets a context block back. The route
handlers are the five that must return something other than a page: health, the
JSON export, one prompt attachment's bytes, a compaction, and the model list.

| File | Responsibility |
|---|---|
| `src/lib/db.ts` | Lazy read-only pool (`default_transaction_read_only=on`) |
| `src/lib/queries.ts` | **Every** SQL statement the UI runs, in one place |
| `src/lib/format.ts` | Display rules, all enforcing "absence is not zero" |
| `src/lib/attachments.ts` | Recovers what the user attached to a prompt from the stored text |
| `src/lib/attachments.test.ts` | Parser regression cases, every fixture a real stored prompt |
| `src/lib/cost.ts` | Reconstructs the arithmetic behind a turn's cost, and checks it against the stored value |
| `src/lib/cost.test.ts` | Cost-working cases, fixtures taken from real stored turns |
| `src/lib/tokens.ts` | What a token count is made of, and which counts are absent rather than zero |
| `src/lib/tokens.test.ts` | Token-breakdown cases, fixtures taken from real stored turns |
| `src/lib/compact.ts` | Folds a run of turns into one context block — pure, no DB, no network |
| `src/lib/compact.test.ts` | The four ways a block could lie: false zero, false success, silent abridgement, lost provenance |
| `src/lib/compactRef.ts` | A list row reduced to what the compaction tray shows, formatted server-side |
| `src/lib/ollama.ts` | The local-model path — shapes read off a running daemon, not recalled |
| `src/lib/compactionStore.ts` | Hands a finished compaction to the collector to store. Best effort, never silent |
| `src/app/page.tsx` | Turn list: filters, keyset pagination |
| `src/app/turns/[id]/page.tsx` | Turn detail: prompt, attachments, response, commands, diffs |
| `src/app/turns/[id]/export/route.ts` | One turn as JSON, provenance columns included |
| `src/app/turns/[id]/attachment/[idx]/route.ts` | One attached screenshot or document, decoded |
| `src/app/aggregates/page.tsx` | Rollups by day / project / agent / provider / model / branch |
| `src/app/api/compact/route.ts` | Assembles the block from the DB, then optionally asks a model to summarise it |
| `src/app/api/compact/models/route.ts` | Which models can run right now — Anthropic's fixed list, Ollama's discovered |
| `src/app/healthz/route.ts` | `SELECT 1`; 503 on failure |
| `src/app/layout.tsx`, `globals.css`, `not-found.tsx` | Shell and theme |
| `src/components/TurnFilters.tsx` | Plain GET form — filter state lives in the URL, so views are linkable |
| | Sessions are a dropdown, narrowed by project and labelled by date · turns · opening prompt |
| `src/components/CommandTimeline.tsx` | Per-turn command list; NULL exit renders "unknown" |
| `src/components/DiffView.tsx` | Diff-syntax rendering, collapsed by default |
| `src/components/PromptAttachments.tsx` | The rail beside the prompt: screenshots, selection, open file, mentions |
| `src/components/ImagePreview.tsx` | Screenshot thumbnail + full-size preview overlay |
| `src/components/InfoTip.tsx` | The info icon and its panel — portalled, so tables cannot clip it |
| `src/components/CostTip.tsx` | One turn's cost, line by line, on an info icon |
| `src/components/TokenTip.tsx` | What a turn's token counts are made of, on an info icon |
| `src/components/HealthBanner.tsx` | States where the numbers are incomplete, and what to do about each |
| `src/components/Chips.tsx` | Provenance chips — every one exists to make a *known unknown* visible |
| `src/components/CompactSelection.tsx` | The compaction tray: context, sessionStorage, totals that skip unknowns |
| `src/components/CompactPicker.tsx` | Row checkbox and drag handle; the handle carries `draggable`, not the row |
| `src/components/CompactDock.tsx` | The floating dock — resting / armed / drag-over / working |
| `src/components/CompactPanel.tsx` | The panel: tray, what to include, length, model, and the block that comes back |
| `src/components/TurnCompact.tsx` | The detail page's own compact panel, plus that turn's compaction history |

### Compaction

Picking a run of turns and folding them into one block someone can paste into a
new session. Turns go into the tray by checkbox or by dragging a row onto the
floating dock; the panel is where the block is made.

It runs in **two stages, and they must not be confused with each other:**

1. **Assembly** — `lib/compact.ts` builds the block out of the database rows.
   Pure, local, no network, and always runs. This is the product.
2. **Summarisation** — `api/compact/route.ts` optionally hands that block to a
   model, and only when someone presses the button.

If stage 2 is unconfigured, refused, empty or fails, the response still carries
the stage-1 block and a `reason` saying what happened, which the panel prints
above the output. The output header always names which of the two is on screen.
A summary standing in silently for the record — or a record looking like a
summary — would be a claim about a run that nobody could check.

Assembly follows the same rule as the rest of the UI: an unreported token count
is "—", an unpriced turn is "not priced", a missing exit code is "exit unknown".
Every budget that bites is announced in the text (`[clipped — N more
characters]`, `… N more not listed at this length`), because a block that
quietly dropped half a response would be read later as the whole of it.

#### Two providers, and the difference is not cosmetic

| | Anthropic (`ANTHROPIC_API_KEY`) | Ollama (`OLLAMA_BASE_URL`) |
|---|---|---|
| Models | Fixed list in `ANTHROPIC_MODELS` | Discovered from `/api/tags` per request |
| Data | Leaves the machine | Stays on it, unless the model is `:cloud` |
| Cost | Billed per press | Free, slower |

The dropdown groups by provider and the panel states which side of that line
the current choice sits on, because the header pill promises "nothing here
leaves this machine" and summarising is the one step that can break it. An
Ollama `:cloud` model is proxied through ollama.com and is labelled as leaving.

**Ollama truncates silently, and the code is built around that.** It does not
refuse a prompt bigger than the loaded context window — it drops the overflow
and returns HTTP 200 with `done_reason: "stop"`. Measured here on 2026-09-23
(Ollama 0.34.2): 4,600 tokens in, `prompt_eval_count: 258`, a confident wrong
answer out, nothing in the response indicating a problem. So:

- `num_ctx` is always set explicitly from the model's own reported
  `context_length`, never left to the daemon's default.
- `planOllamaContext()` multiplies the char/4 estimate by **1.8** before
  checking the fit. Measured on real blocks, chars/4 undercounts by 1.52–1.58×
  — they are mostly absolute paths, commands and diff punctuation, which
  tokenise densely. A block that still does not fit is refused, not sent.
- `looksTruncated()` is the backstop: a `prompt_eval_count` that reached the
  window means the front was dropped, and the summary is withheld.

#### Compact history (turn detail page)

Each run from a turn's detail page is stored in `compactions`, **with its
settings** — model, provider, length, and which parts went in. Without those the
row is a paragraph with no way to know what it left out.

The write does not happen in the dashboard. `apps/web` POSTs to the collector
(`POST /v1/compactions`, same shared secret as the hooks) and the collector
inserts; the dashboard's pool keeps `default_transaction_read_only=on`. The read
side is `listCompactions()` in queries.ts like everything else.

- **`summarized` is the load-bearing column.** False means `output` IS the
  assembled record; true means a model rewrote it. Every history row is labelled
  "Summary" or "Assembled record" on its face.
- **Unsummarised runs are stored too**, with the reason. A history that kept
  only the successes would misrepresent what the panel has been producing, so a
  CHECK constraint requires a reason whenever `summarized` is false.
- **Saving is best effort and never silent.** A compaction that ran is shown
  whether or not it could be filed; when it could not, the panel says so and
  says why, and the row is not added to the history list.
- **`request_id` is client-generated and unique**, so a retry after a timeout
  costs nothing and one press cannot become two rows.

### The session filter

`sessionId` was always a filter — the detail page's "Open session" set it — but
it was not offered in the bar, on the stated grounds that there are "thousands
of sessions and none is memorable". Measured on 2026-09-23: **25 sessions**,
all with turns. The premise was an assumption, not a count.

It is a dropdown now, narrowed by project exactly as branches are, and grouped
by project when no project is chosen. A session id is a UUID and names nothing
to a person, so each option reads *date · turn count · opening words of the
first prompt* — the editor block stripped, via the shared `IDE_BLOCK_RE` in
queries.ts. Options are capped at `SESSION_OPTION_LIMIT` (200) and the list
says so when it is a prefix.

The active session is pinned into the list even when the project narrowing
would exclude it. Without that, a `defaultValue` matching no option reverts to
"All" and the next submit silently drops a filter the user never touched.

**The `key` on the `<form>` is load-bearing — do not remove it.** Every control
in the bar is uncontrolled and set from `defaultValue`, which React applies
only when an element mounts. A client-side navigation re-renders the form in
place, React reuses the DOM nodes, and the controls stop following the URL:
observed on 2026-09-23 that "Clear all" left the session select reading 76557
with an empty URL, and Back left it empty with `?sessionId=76557` in the URL.
Keying on the query string remounts the form whenever the filters change.

### Showing how a cost was calculated

Every cost on the dashboard carries an info icon that explains it, and what it
explains differs by scope:

| Where | What the panel shows |
|---|---|
| a turn's cost (list row, detail card) | every line of `tokens × rate`, the total, and the rate row it used |
| Spend tile | how many turns on the page were priced, how many were not |
| aggregates cost column / total | that it is `sum(cost_usd)`, and that unpriced turns add nothing |

The per-turn working is computed in `lib/cost.ts`, **not** in SQL. It is a
deliberate second implementation of the collector's `computeCost()`
(`apps/collector/src/ingest.ts`) and has to stay a mirror of it — a NULL rate
contributes 0 rather than falling back to the input rate, and unbucketed cache
writes are billed at the 5m rate. It is in JS floats because `cost_usd` is
`total.toFixed(8)` of a float sum; in SQL numeric the last places would
disagree and the displayed working would look wrong when it was right.

`reconcile()` compares the reconstruction to the stored value and the panel
says so when they differ, rather than showing arithmetic that does not add up.
Checked against every priced turn in this archive on 2026-09-23: 457 of 457
reconcile, largest absolute difference 1.4e-14 against a 1e-8 tolerance.

This replaced a SQL `getCostBreakdown()` that coalesced a NULL cache-read rate
to the input rate. No pricing row in this database has a NULL rate, so it was
correct here and wrong in principle — the collector charges nothing for a rate
it does not have.

### Showing what a token count is made of

The same info-icon treatment as costs, in `lib/tokens.ts` and `TokenTip.tsx`.
The input figure is `turns.total_input_tokens`, a generated column that
migration 004 defines as `coalesce(input_tokens,0) +
coalesce(cache_read_tokens,0) + coalesce(cache_write_tokens,0)`, so the three
parts always reconstruct it. Checked across all 474 turns on 2026-09-23: zero
rows differ.

Two things that column hides, and that this code exists to surface:

- **A turn that reported no usage has 0 there, not NULL.** The `coalesce` in
  the generated column erases the absence, so no null check can catch it —
  `token_source = 'unknown'` is the only signal. All 16 such turns in this
  archive rendered **"0 in"** before this, which is precisely what the "absence
  is not zero" invariant forbids. `tokenCount()` in format.ts renders "—" for
  them and `tokenWorking()` returns null.
- **The 5m/1h cache-write buckets do not always fit inside the cache-write
  total.** Turns 8610 and 17550 report *more* in the buckets than in the total,
  by 2,890 and 1,135 tokens. Both are the provider's own figures, accumulated
  over the turn's assistant messages; neither is corrected here. The panel says
  the two disagree, and which number feeds what: the input total uses the
  reported total, the cost uses the buckets.

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
| change how a cost is explained on screen | `apps/web/src/lib/cost.ts` — **and keep it a mirror of `ingest.ts` → `computeCost()`** |
| change how a token count is explained, or rendered when absent | `apps/web/src/lib/tokens.ts` and `format.ts` → `tokenCount()` |
| change what a compacted block contains, or how it says it abridged something | `apps/web/src/lib/compact.ts` — **and add a case to its test** |
| add an Anthropic model to the compact dropdown | `ANTHROPIC_MODELS` in `apps/web/src/lib/compact.ts` — set `effort`/`fallback` from that model's own docs, not by analogy |
| add an Ollama model to the compact dropdown | `ollama pull <model>` — the panel discovers it; nothing to edit |
| change what a stored compaction records | migration 013 **and** `apps/collector/src/server.ts` → `/v1/compactions` — the validator and the CHECK constraints say the same things on purpose |
| add a third compaction provider | `lib/ollama.ts` as the template, a branch in `api/compact/route.ts`, an entry in `api/compact/models` — **and verify its truncation behaviour before trusting a response** |
| support a new agent | `apps/collector/src/adapters/` |
| change how paths translate | `apps/collector/src/paths.ts` and `PATH_MAP` |
| understand why a turn has no provider | `reconciler.ts` → `applyProviderAttribution()` |
| understand why a turn is unpriced | `ingest.ts` → `computeCost()`, then `model_pricing` |
| add a table or column | a **new** migration — never edit an applied one |
