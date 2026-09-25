# Operations

Running it, keeping it, and every failure mode actually hit so far.

---

## Everyday

Installed with `./install.sh`? Then `./install.sh` re-checks it,
`./install.sh --upgrade` updates it and `./install.sh --uninstall` removes it
(database kept) — in either mode; see [install.md](install.md). The `make`
targets below are the Docker-mode equivalents underneath.

```bash
make up            # postgres + migrate + collector + proxy
make web           # + the dashboard, at http://127.0.0.1:3000
make logs          # follow the collector
make down          # stop. Keeps your data.
```

`make up` rebuilds images. First start runs a **backfill** over all pre-existing
history before the live tail begins, and logs a row count when it finishes.

### Health

```bash
curl -s 127.0.0.1:4317/healthz     # collector
curl -s 127.0.0.1:4318/healthz     # proxy
curl -s 127.0.0.1:3000/healthz     # web — runs a real SELECT, 503 if the DB is unreachable
docker compose ps                  # all four, with health state
```

### Dev mode

```bash
docker compose -f compose.yaml -f compose.dev.yaml up          # source bind-mounts, hot reload
docker compose -f compose.yaml -f compose.dev.yaml --profile phase5 up web
```

Dev forces `WATCH_MODE=poll`, because bind mounts on Docker Desktop do not
deliver inotify events reliably and a watcher misfire looks exactly like an
adapter bug.

---

## Backup and restore

The database is the only copy of anything that has been compacted out of a
transcript. Back it up before anything destructive.

```bash
make backup        # pg_dump -Fc into ./backups/aiuo-<UTC timestamp>.dump
```

Restore (**untested** — nothing has needed restoring yet):

```bash
docker compose exec -T postgres pg_restore -U aiuo -d aiuo --clean --if-exists \
  < backups/aiuo-20260922T120000Z.dump
```

> `docker compose down -v` deletes the `pgdata` volume and **every byte of
> ingested history**. Plain `make down` is the safe form.

## Migrations

```bash
make migrate-status                                   # applied / pending, with drift check
make migrate                                          # apply pending
pnpm --filter @agentpulse/schema migrate verify             # exit 1 if a file changed after apply
pnpm --filter @agentpulse/schema migrate down --to 5 --yes  # roll back to and including 6
```

Rollback cost per migration is tabulated in [schema.md](schema.md). Rolling back
007 (indexes) costs only speed; rolling back 006 loses checkpoints **and** raw
event provenance and forces a full re-ingest.

**Never edit an applied migration.** The runner checksums both `.up.sql` and
`.down.sql` and will refuse to run rather than compound the drift. To correct
something, add a new migration — see 011 and 012.

## Changing prices

Insert a new `model_pricing` row with a new `effective_from`. Do **not** update
the existing row: cost is computed once at ingest and stored, so an update
changes nothing about past turns while making the history unexplainable.

The `EXCLUDE USING gist` constraint will reject a row whose period overlaps an
existing one for the same `(provider, model)` — close the old period by setting
its `effective_to` first.

## Changing redaction patterns

1. Edit `packages/schema/src/redaction.ts`.
2. **Bump `this.version`.** Not optional.
3. Restart the collector and proxy.

Both services refuse to start if a version already in `redaction_versions` has a
different pattern hash — the version stamped on every content row is only an
audit trail if one version means one pattern set forever.

Existing rows are **not** re-redacted. Rows written under an older version stay
as they were; the version column is how you find them.

## Rotating the shared secret

1. New value in `.env`.
2. `docker compose up -d collector`
3. `make install-hooks` — it rewrites the forwarder with the new secret.

## Hooks

```bash
make install-hooks       # idempotent; backs up settings.json first
make uninstall-hooks
```

Hooks take effect **immediately** — `settings.json` is watched, not read once at
session start. Observed on this machine: hooks installed mid-session began
firing within about a minute, in the already-running session.

---

## Failure modes

Every one of these has actually happened here.

### Startup fails: "`<agent>` is mounted but has no PATH_MAP entry"

`PATH_MAP` must cover the **agent's home directory**, not just your code roots.
Checkpoints are keyed on the transcript's host path and the database rejects
`/host/...` outright, so without that entry every single transcript fails to
checkpoint.

```bash
PATH_MAP=/Users/you/.claude:/host/agents/claude,/your/code:/host/code/root1
```

The symptom before the assertion existed was every transcript failing
`ingest_checkpoints_path_is_host_path` — a constraint name that points at the
table rather than the missing config line.

### Startup fails: "PATH_MAP maps X → Y, but Y is not mounted"

Add the bind mount in `compose.yaml`, or remove the `PATH_MAP` entry. This is
deliberate: a missing mount must never degrade to "zero turns found", which is
invisible — the collector runs, logs nothing alarming, and the dashboard is
simply empty forever.

### Startup fails: "PATH_MAP entry N is shadowed by entry M"

First match wins, so a shorter earlier prefix makes a later entry dead. List the
more specific prefix first.

### Startup fails on redaction version

A version already in the database has a different pattern hash. Either restore
the patterns to what that version was, or bump `version` to a new number.

### Port already allocated

Something on this machine already holds the port — a native Postgres on 5433 is
the common one. Change the **host** side in `.env`; the container side does not
move and services still reach each other on the compose network.

```bash
POSTGRES_HOST_PORT=5434
```

### Git inside the collector: "detected dubious ownership"

`HOST_UID` / `HOST_GID` do not match your host user. Every git-based gap fill
then silently returns nothing.

```bash
make uid      # prints the correct values for .env
```

Rebuild after changing them — they are build args, not runtime env.

### `ERR_MODULE_NOT_FOUND: Cannot find package 'pg'`

A runtime image stage copied only the root `node_modules`. pnpm puts the real
store in `node_modules/.pnpm` at the root *and* per-package symlink directories;
a runtime stage needs both.

### `TS2307: Cannot find module '@agentpulse/schema/redaction'` during a build

The workspace dependency was not built first. Use the trailing `...`, which
includes workspace dependencies in topological order:

```bash
pnpm --filter "@agentpulse/collector..." run build
```

### `next build` fails with no `DATABASE_URL`

It shouldn't any more — the pool is lazy, because `next build` imports every
route module. If it returns, something created a pool at module scope.

### Docker build uploads gigabytes of context

`.dockerignore` is missing or has stopped covering `node_modules`.

### The collector logs "N TRANSCRIPT(S) FAILED"

One transcript hit an error and was skipped; the path is on stderr. Everything
else was ingested. This is by design — one transaction per transcript, so a
poisoned file cannot take down the pass. An earlier version scoped the
transaction per *pass* and silently ingested 134 turns instead of 442.

### The dashboard is empty

In order:

1. `docker compose ps` — is the collector running?
2. `make logs` — did the backfill report a count?
3. Do your `PATH_MAP` entries actually cover where your projects live?
4. Is `AGENT_CLAUDE_CODE_ENABLED=true`?

### Everything shows an inferred provider

Expected until the proxy actually carries traffic. Layer 1 transcripts record no
provider, so log-only history can never rise above `model_map` (inference from
the model id). Route an agent through the proxy for observed attribution:

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:4318
```

### `make: command not found` (macOS)

No Xcode command line tools. Either `xcode-select --install`, or run the
underlying commands directly — `make help` shows what each target does,
`./install.sh` needs no `make` at all, and `scripts/install-hooks.sh` runs
standalone.

---

## Known gaps in the tooling itself

- `make test` runs the collector's and the dashboard's tests. The proxy's
  `usage.test.ts` is still not in that target; run it with
  `pnpm --filter @agentpulse/proxy run test`.
- Restore has never been exercised.
- There is no automated check that seeded prices still match the provider's
  published rates.
