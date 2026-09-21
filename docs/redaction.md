# Redaction

Everything written to the database passes through
[redaction.ts](../packages/schema/src/redaction.ts) first — prompt text,
response text, command strings, stdout excerpts, diff bodies, and the proxy's
request and response bodies alike. A pipeline that covers prompts but not
diffs just moves the leak.

This is defence in depth, **not a guarantee**. Regexes cannot recognise a
secret that looks like ordinary text. The database is still sensitive data and
must stay on localhost.

## The versioning contract

Every content row stores the `redaction_version` it was written under, and
`redaction_versions` stores the sha256 of the pattern set for each version.
That is only an audit trail if **one version means one pattern set, forever**.

So:

- Changing `DEFAULT_PATTERNS` requires bumping `Redactor.version`.
- Both the collector and the proxy insert with `ON CONFLICT (version) DO
  NOTHING` and then compare hashes. If a version already in the database has a
  different hash, the service **refuses to start** and names the fix.

It used to be `ON CONFLICT (version) DO UPDATE SET pattern_hash = …`. That
silently rewrote history: edit the patterns, restart, and every row already
stamped with that version now claimed a pattern set which had never been
applied to its content — with no way afterwards to tell which rows were
covered by which.

Verified by planting a conflicting hash:

```
Redaction version 2 is already recorded with pattern hash DIFFERENTHASH,
but the live pattern set hashes to fef30cfd415bea6525aac1e2d394f2cf.
The patterns changed without a version bump — rows written under both would
be indistinguishable. Increment Redactor.version in
packages/schema/src/redaction.ts.
```

There is **no `REDACTION_PATTERNS_FILE`**. `.env.example` used to document one;
nothing read it, so editing the file it named would have changed no behaviour
while looking like it had. The pattern set is compiled in.

## Version 1 → 2: two real leaks

Found by running credentials through the shipped version 1 set. Both are now
regression-tested in
[redaction.test.ts](../apps/collector/src/redaction.test.ts).

**1. `Authorization: Bearer <token>` kept the token.**

The pattern ended in `\S+`, which matched only the word `Bearer`:

```
in:  Authorization: Bearer OPAQUEVALUE1234567890
out: Authorization: [REDACTED:auth_header] OPAQUEVALUE1234567890
```

A pasted curl command or stack trace is the single most likely way a live
credential reaches this pipeline, so this was the worst case in the set. The
auth scheme is now consumed explicitly and the value after it is what gets
replaced.

The same flaw was in `env_assignment`, which runs first: on
`X-Auth-Token: Bearer <token>` it matched the `Token: Bearer` part and
replaced only `Bearer`. Fixed the same way.

**2. JSON-quoted secret fields were not matched at all.**

Both the env and the header patterns expected `KEY: value` or `KEY=value`.
JSON puts a quote between the key and the colon, so neither matched:

```
in:  {"api_key": "OPAQUEVALUE1234567890"}
out: {"api_key": "OPAQUEVALUE1234567890"}
```

This mattered most in the one place bodies are stored verbatim — the proxy
records every request and response body as JSON.

### Effect on existing data

Rows are not rewritten. The distinction is preserved instead:

| `redaction_version` | turns | meaning |
|---|---|---|
| 1 | 426 | written under the leaky pattern set |
| 2 | 22 | written under the fixed one |

Treat version 1 content as possibly containing an auth-header or JSON-field
credential. Re-ingesting from `raw_events` would not help — those rows were
redacted at write time too.

## What is covered

Vendor key formats (Anthropic, OpenAI, GitHub, AWS, Google, Slack), JWTs,
PEM private key blocks, credentials embedded in connection-string URLs,
`KEY=value` / `KEY: value` / `"key": "value"` where the key name contains
SECRET, PASSWORD, TOKEN, API_KEY, ACCESS_KEY, PRIVATE_KEY or CREDENTIAL, and
auth headers in header or JSON form.

Ordinary prose is left alone — `"The authorization flow failed because the
token had expired."` passes through unchanged.

## What is NOT covered

State these plainly rather than implying the pipeline is a filter for
everything:

- **PII.** Email addresses, names, phone numbers and customer records are
  stored as written. The patterns target credentials, not personal data. An
  email in a prompt is in the database in cleartext.
- **Secrets that look like ordinary text.** A password that is a dictionary
  word in a sentence is unrecognisable to a regex.
- **Opaque values under unrecognised key names.** `{"foo": "9f2c…"}` is
  indistinguishable from data.
- **Credentials echoed by an upstream in a response body.** The proxy strips
  credential headers from what it records, but if a provider returned your key
  in its response payload, only the content patterns would catch it.

## Changing the patterns

1. Edit `DEFAULT_PATTERNS` in `packages/schema/src/redaction.ts`.
2. Bump `Redactor.version`.
3. Add the leak you fixed to `apps/collector/src/redaction.test.ts`.
4. `pnpm --filter @aiuo/collector run test` — the version assertion there
   fails deliberately if you forget step 2.
