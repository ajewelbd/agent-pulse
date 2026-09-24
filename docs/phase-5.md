# Phase 5 — Dashboard

Read-only Next.js App Router UI over the ingested history, plus the container
work that was missing for the whole stack to actually run from a clean clone.

Verified on 2026-09-21 against a live stack: 445 turns, 22 sessions,
11 projects, 8261 tool calls, 2077 file changes.

---

## 1. What was built

| Route | File | Purpose |
|---|---|---|
| `/` | [page.tsx](../apps/web/src/app/page.tsx) | Turn list, filters, keyset pagination |
| `/turns/[id]` | [page.tsx](../apps/web/src/app/turns/%5Bid%5D/page.tsx) | Full turn: prompt, response, commands, diffs |
| `/aggregates` | [page.tsx](../apps/web/src/app/aggregates/page.tsx) | Cost and token rollups by 6 dimensions |
| `/healthz` | [route.ts](../apps/web/src/app/healthz/route.ts) | `SELECT 1` container healthcheck |

All four are `dynamic = 'force-dynamic'`. Nothing is prerendered, so the image
never bakes query results and never needs a database at build time.

Server components throughout. The only client-side behaviour on the whole
dashboard is native `<details>` and a plain GET `<form>` — no client
JavaScript ships for filtering, expanding diffs or paginating.

### Filter state lives in the URL

Every filter is a query parameter, so every view is linkable and
reproducible. That matters for a tool whose purpose is going back and finding
what happened. Filters: free text, project, agent, provider, model, branch,
date from/to, status.

Free text goes through `websearch_to_tsquery` against the `search_tsv`
generated column — human syntax (`foo OR bar`, quoted phrases, `-exclusions`)
and, unlike `to_tsquery`, it never throws on malformed input. It is a bound
parameter, not interpolated.

---

## 2. Design decisions that carry weight

### Absence is never rendered as zero

[format.ts](../apps/web/src/lib/format.ts) is one rule applied everywhere: a
null token count is "not reported", a null cost is "not priced", a null exit
code is "exit unknown". The schema's CHECK constraints exist to keep those
three distinct from `0`; rendering them as `0` in the UI would undo that work
at the last step.

Concretely, in the current data: 14 turns are unpriced and 8261 of 8261 tool
calls have no exit code. Shown as `$0.00` and `exit 0`, that would read as
"$3718.40 is the complete spend" and "every command in the archive passed".
Both are false.

### The health banner states what the numbers don't know

[HealthBanner.tsx](../apps/web/src/components/HealthBanner.tsx) sits above
both pages and lists the structural gaps, each with the action that closes it:

| Caveat | Current | Fix it says |
|---|---|---|
| Inferred provider | 445 / 445 | Route the agent through the proxy |
| Unpriced turns | 14 | Add rows to `model_pricing` |
| Commands with no exit code | 8261 / 8261 | nothing — see below |
| Turns with no token counts | 14 | — |

A dashboard that renders only what it knows quietly implies it knows
everything. This one says otherwise, up front.

The exit-code row originally read `make install-hooks`. That was wrong — the
hook carries no exit status — and the banner now says so instead of sending
you to a fix that would not have worked. See
[hook-payloads.md](hook-payloads.md).

### Provider attribution is shown with its source

`provider ✓` means the proxy observed the host actually connected to.
`provider?` means it was inferred from the model id prefix — which cannot
distinguish direct traffic from a gateway serving the same model. All 445
turns are currently `?`, because nothing has been routed through the proxy
yet. Cost figures are derived from provider-reported usage and seeded rates;
they are not billing-authoritative, and the aggregates page says so inline.

### Cost is keyed on (provider, model), not model

The aggregates page leads with a provider × model table, because the same
model priced through a gateway is a different rate. Rolling up by model alone
silently merges them.

### Diff bodies are fetched on exactly one page

`listTurns` joins `projects`, `agents` and `providers` and truncates
`prompt_text` to 240 characters **in SQL**. It never touches
`file_change_diffs`. That separate table exists precisely so a list page
cannot drag multi-MB TOASTed values it does not render; only
`/turns/[id]` reads diff bodies, and only for one turn.

Pagination is keyset on `(started_at, id)`, not `OFFSET` — `OFFSET` re-scans
and discards every preceding row, so page 100 costs 100× page 1.

### Diff syntax, not language syntax

[DiffView.tsx](../apps/web/src/components/DiffView.tsx) colours hunk headers,
additions, removals and context. Per-language tokenizing would mean shipping a
highlighter plus a grammar set for every language in the corpus, for a
marginal gain over the `+`/`−` colouring reviewers actually read.

### Markdown rendering cannot inject markup

The response is rendered with `react-markdown` + `remark-gfm`. React escapes
by default and no raw-HTML plugin is enabled, so stored text — which came from
outside — cannot inject markup into the page.

---

## 3. Read-only is enforced, not intended

`apps/web/src/lib/db.ts` sets `default_transaction_read_only=on` in the
connection `options`, so it applies at the server for every statement on every
pooled connection — including ones a future feature adds without reading that
file.

Verified live, inside the running container, using the app's own options
string:

```
transaction_read_only : on
TimeZone              : UTC
reads work            : 445 turns
write refused         : cannot execute CREATE TABLE in a read-only transaction
```

The probe is `CREATE TEMP TABLE`: a temp table is session-local and vanishes
on disconnect, so even had it succeeded it could not have touched a stored
row. The guarantee is demonstrated without putting ingested history at risk.

The pool is built lazily. `next build` imports every route module to read its
config, so a pool constructed at module scope fails the build — a dashboard
image must be buildable without a database, since the database is a runtime
dependency, not a build one.

---

## 4. Container work this phase had to fix

`compose.yaml` referenced `apps/web/Dockerfile`, which did not exist. Writing
it surfaced four further faults, all of which would have hit anyone cloning
the repo.

**1. No `.dockerignore`.** The whole host `node_modules` was being uploaded
into every build context, including pnpm's symlink farm. Added one.

**2. The collector and proxy images were building against host artifacts.**
Both ran `pnpm --filter @aiuo/<app> run build`, which does not build workspace
*dependencies*. They compiled only because an unignored host-built
`packages/schema/dist` was being copied in. With `.dockerignore` in place they
failed immediately:

```
src/db.ts(6,26): error TS2307: Cannot find module '@aiuo/schema/redaction'
```

Fixed with `--filter "@aiuo/<app>..."` — the trailing `...` selects the
package *and* its workspace dependencies, built in topological order.

**3. Runtime stages copied only the root `node_modules`.** Under pnpm the root
holds the content store (`.pnpm/…`); the *per-package* `node_modules` holds
the symlinks that make `pg` and `@aiuo/schema` resolvable. Copying only the
root produced images that started and then died:

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'pg'
  imported from /app/packages/schema/dist/migrate.js
```

All three runtime stages now copy both.

**4. Hard-coded published host ports.** `5433` was chosen so as "never to
collide with a local postgres on 5432" — and this machine had a native
postgres on 5433. All four published ports are now
`${*_HOST_PORT:-default}`, still bound to `127.0.0.1`. Only the host side
moves; services still reach each other on the compose network at the
container port.

For the Next standalone bundle, `outputFileTracingRoot` is pinned to the
workspace root. Without it, Next traces from `apps/web` and the bundle ships
without the dependencies that live in the root `node_modules` — the image
builds fine and dies at runtime.

Image sizes: web 301 MB, collector 346 MB, proxy 249 MB, migrate 249 MB.

---

## 5. A missing startup assertion

With the stack finally running end to end in Docker, every single transcript
failed:

```
new row for relation "ingest_checkpoints"
violates check constraint "ingest_checkpoints_path_is_host_path"
```

`PATH_MAP` covered the code roots but not the agent home. Checkpoints are
keyed on each transcript's **host** path, and the database rejects `/host/...`
outright — so the collector started clean, reported "mounts ok", and then
failed 100% of transcripts with an error naming a table rather than the
missing config line.

`assertMounts` in [main.ts](../apps/collector/src/main.ts) now checks that
every enabled agent's home is itself covered by `PATH_MAP`, and fails at
startup with the line to add. This is the same principle as the existing mount
assertions: a configuration gap must not degrade to "zero turns found".

`CODE_ROOT_2` was added at the same time, so `/Volumes/Macintosh HD 1/Practice`
is now ingested as well.

After the fix:

```
backfill: claude_code — 476 turns, 9292 tool calls, 2266 file changes
backfill complete: {"projects":11,"sessions":22,"turns":445,
                    "tool_calls":8257,"file_changes":2077,"raw_events":38083}
```

476 scanned, 445 stored — the difference is the resumed-session dedupe from
migration 009 doing its job.

---

## 6. Verification

Live stack, all services healthy:

| Request | Result |
|---|---|
| `/healthz` | 200 `{"ok":true}` |
| `/` | 200, 50 rows, health banner present |
| `/aggregates` | 200, all 6 rollups + provider × model |
| `/?q=postgres` | 200, narrowed result set |
| `/?status=complete` | 200 |
| `/turns/8644` | 200, 51 collapsible sections, `@@` hunks, "exit unknown" |
| `/turns/999999999` | 404 |
| `/turns/abc` | 404 (non-numeric id rejected before the query) |

Read-only enforcement: verified above.

Run it:

```sh
make web          # full stack incl. dashboard → http://127.0.0.1:3000
make web-dev      # dashboard with hot reload
```

---

## 7. Still open

These are reported, not fixed, and none blocks the dashboard.

1. **No exit codes anywhere** — 8261 / 8261, and **the hook will not fix
   this**. Corrected after reading the shipped CLI's own schema: the Bash
   tool's result has stdout, stderr and interrupted but no exit status, so
   `PostToolUse.tool_response` carries no exit status, and neither does the
   OpenTelemetry span (the function that would set the attribute has an empty
   body). Hooks are now installed, and exit codes turn out to be recoverable
   from `PostToolUseFailure.error` — but only for calls captured from now on.
   These 8261 predate hooks and can never be backfilled. See
   [hook-payloads.md](hook-payloads.md).
2. **Proxy correlation is untested against live agent traffic.** Nothing has
   been routed through `127.0.0.1:4318` yet, which is why all 445 turns show
   an inferred provider.
3. **Cost totals are unaudited.** $3718.40 across 445 turns is derived from
   provider-reported usage and the seeded rates in migration 003. It has not
   been checked against a real invoice, and 14 turns are excluded as unpriced.
4. **Only Claude Code has real data.** The Gemini adapter is implemented and
   contract-tested but disabled; the other four target agents are not
   installed on this machine (see
   [phase-1-format-discovery.md](../phase-1-format-discovery.md)).
   *Update 2026-09-24:* Gemini CLI is now verified and enabled in compose; see
   the update note in [phase-4.md](phase-4.md#gemini-cli-adapter).
