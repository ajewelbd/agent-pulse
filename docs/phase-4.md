# Phase 4 — Proxy, remaining adapters, reconciliation

## What landed

| Feature | Commit |
|---|---|
| Layer 3 proxy + migration 010 (`proxy_requests`) | `a877eab` |
| Gemini CLI adapter | `f94c13d` |
| Cross-layer reconciler | `c8e6fd5` |

`compose.yaml` now runs four services: `postgres`, `migrate`, `collector`,
`proxy`. Only `web` remains profiled off (`phase5`).

## The four uninstalled agents — still not written

Codex CLI, Qwen Code and Cursor CLI have **no adapter**, and I am not going to
write one. They are not installed, their transcript formats are unverified, and
a parser written against a guessed schema cannot even be run here to find out
it is wrong. The collector logs a warning and ignores them if enabled, rather
than silently ingesting nothing.

Copilot CLI has no adapter for a different reason: it genuinely writes no
transcripts on this machine (8 startup log lines, stdio server mode only). It
is a **Layer 3 agent** — point it at the proxy and its usage is captured
without any Layer 1 adapter at all. That is precisely what the proxy is for.

To unblock the other three: install one, run it once, and send me
`find ~/.codex ~/.qwen ~/.cursor -type f | head -40` plus `head -c 4000` of a
session file.

## Layer 3 proxy

Point an agent at it with its base-URL env var:

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:4318
export OPENAI_BASE_URL=http://127.0.0.1:4318/v1
```

One agent gives you one base-URL variable, so several upstreams are reachable
at once via `/_u/<name>/…` prefixes configured in `PROXY_UPSTREAMS`.

**Provider attribution is the point.** This is the only non-inferential
provider signal in the system: `claude-opus-5` served direct, through
OpenRouter, or through Bedrock is one model string with three different bills.
Layer 1 transcripts record neither the provider nor the resolved base URL, so
everything backfilled from logs is stuck at `provider_source='model_map'`.

**Streaming is not buffered.** Chunks are forwarded to the client the instant
they arrive while a capped copy is teed off for usage extraction. Verified: SSE
chunks arrived spread over ~1s, matching the upstream's emission timing.

**It never breaks the agent.** Recording runs after the response is fully
delivered and cannot throw into the request path; there is no proxy timeout,
because a long agentic completion legitimately runs for many minutes and a
timeout would look like a model failure.

### Usage extraction

The streaming and non-streaming variants report usage in completely different
places, and getting it wrong is silent — it records zeros, which look like a
measurement. Absence is therefore recorded as absence: `reported: false` and
`token_source='unknown'`, never zeros.

| | non-streaming | streaming |
|---|---|---|
| Anthropic | `body.usage` | `message_start` (input/cache) + `message_delta` (output) |
| OpenAI | `body.usage` | final chunk, only if `stream_options.include_usage` |

Two traps, both covered by tests:

- **`message_delta` reports a running total, not an increment.** Summing the
  deltas would multiply the output count.
- **OpenAI reports cached tokens *inside* `prompt_tokens`**, where Anthropic
  reports them as a separate bucket. Without splitting them out,
  `input + cache_read` double-counts.

### Security

The proxy sees every prompt **and** the agent's credentials. Auth headers are
stripped before recording; bodies run the same redaction pipeline as prompts
and diffs.

Verified end to end — an API key in a header, a key inside a prompt body, and a
bearer token all reached the database redacted:

```
header_key_leaked | body_key_leaked | bearer_leaked | redaction_markers
                0 |               0 |             0 |                 2
```

The redaction pipeline moved to `packages/schema`, which already owns the
`redaction_versions` contract. Duplicating a security-critical pattern set
across two services would let them drift while both claim the same version
hash.

## Gemini CLI adapter

Included to show the adapter contract actually generalises — it is the only
*other* agent here with a verifiable format, and it differs from Claude Code in
three structural ways, none of which required changing the interface:

1. **Whole-document JSON, rewritten in place**, not append-only NDJSON. Byte
   offsets cannot mean "parse from here", so the document is parsed in full
   each pass; idempotency comes from the message id. A rewrite caught mid-flight
   leaves invalid JSON, so the checkpoint deliberately does not advance.
2. **The project path is hashed.** `projectHash` is sha256 of the absolute
   path — verified, 4 of 5 hashes on this machine resolve to real directories
   (the 5th is a deleted project). Being one-way, the adapter builds a reverse
   index by hashing the configured code roots, using **host** paths because
   that is what the agent hashed. An unresolvable hash is skipped, never
   guessed.
3. **No tool calls and no file changes exist in the chat files at all**, so
   dashboard columns 6 and 7 are genuinely empty for this agent rather than
   missing through a parser gap.

Result against the real `~/.gemini`: **13 turns, 2 projects, tokens captured,
projects resolved by hash**, cost correctly `unpriced` (no Gemini rates seeded
— NULL, not $0.00).

*Flagged assumption:* Gemini reports `thoughts` separately from `output`; both
are folded into `output_tokens` as model-generated tokens. This affects no cost
today precisely because Gemini is unpriced.

## Reconciler

Correlates proxy observations to turns on `(model, time window)` with a
2-minute grace, because nothing in an Anthropic or OpenAI request carries a
session id. The method used is recorded per row (`model_time_window` /
`ambiguous` / `no_candidate` / `pending`) so a heuristic match is never
mistaken for a certain one.

**Precedence is applied field by field, not wholesale.** The layers do not
disagree about the same facts:

- **provider — the proxy wins unconditionally**, despite being the lowest
  precedence layer. It observed the host connected to; the log never had that
  fact to be overridden. Restricted to turns still at `model_map`/`unknown`.
- **tokens — the proxy fills gaps only.** Where the log reported provider
  counts, they stand. Wholesale "last layer wins" would replace
  provider-reported counts with proxy-observed ones and make the two
  indistinguishable afterwards.

Cost is **not** recomputed on gap-fill: pricing an old turn at today's rates is
exactly what "computed at ingest, never recomputed retroactively" forbids.

### Verified behaviour

| Case | Setup | Result |
|---|---|---|
| Unique match, wrong inference | Turn inferred `anthropic` from `claude-opus-5`; proxy observed `openrouter.ai` | provider → **openrouter**, `provider_source='proxy'`; log's token counts untouched |
| Ambiguous | Two turns on `claude-sonnet-5` overlapping one call | `match_method='ambiguous'`, unmatched, both turns keep `model_map` |
| Token gap-fill | Turn with `token_source='unknown'`; two proxy calls in window | summed to 300/50/20, `token_source='proxy'` |

## Verification

| Check | Result |
|---|---|
| Proxy: non-streaming usage extraction | input/output/cache/5m all correct |
| Proxy: streaming passthrough | chunks progressive over ~1s, not buffered |
| Proxy: `message_delta` running total | 99, not 1+5+99 summed |
| Proxy: credential leakage | 0 / 0 / 0 |
| Proxy: `provider_request_id` captured | `req_fake_12345` |
| Collector: both adapters | claude_code 442 turns + gemini_cli 13 turns, 13 projects |
| Reconciler: 3 cases | all correct |
| Unit tests | collector 14/14, proxy 17/17 |
| `pnpm -r typecheck` | clean |
| `docker compose config` | valid, 4 services |

One test caught a real bug worth recording: **Vertex regional endpoints
hyphen-join the region into a single DNS label**
(`us-central1-aiplatform.googleapis.com`), so strict label-boundary matching
missed them and they fell through to plain `google` — a different price list.
Hyphen matching is now opt-in per rule, because a blanket version would make
`evil-anthropic.com` resolve to `anthropic`.

## Still open

1. **The `PostToolUse` hook payload.** Unchanged from Phase 3, and still the
   single highest-value unknown: it is the only route to real shell exit codes.
   `make install-hooks`, start a **new** session, run a command, then send me
   `SELECT payload FROM raw_events WHERE layer='hooks' LIMIT 3;`.
2. **Proxy correlation** — now verified end to end; see below. Still not
   exercised by a real agent pointed at `ANTHROPIC_BASE_URL`, which is the one
   remaining gap.
3. **Sub-agent token double-counting** (carried from Phase 3): sidechain
   sessions have their own turns while the parent's summary reports the same
   totals. The parent summary is in `raw_events` only, so nothing is wrong
   today — but Phase 5 aggregates must not sum both.
4. **Cost figures remain derived, not billing-authoritative.**

## Next: Phase 5 — dashboard

Turn list (filters + full-text search, no diff bodies), turn detail (rendered
markdown, command timeline, collapsible diffs), and aggregates.

---

# Addendum — end-to-end proxy verification (2026-09-21)

Run against a throwaway database and a mock upstream given the Docker network
alias `api.anthropic.com`, so host-based provider attribution ran for real
rather than being stubbed. The live stack and its 445 turns were untouched;
all test containers and the test database were dropped afterwards.

## Passthrough — the proxy must never break the agent

| Case | Result |
|---|---|
| Non-streaming 200 | forwarded intact, usage extracted |
| SSE stream | 5 events, client received `message_stop` — teed, not buffered |
| Upstream 429 | status and error body passed through unchanged |
| Credentials | forwarded upstream (agent works), `[REDACTED]` in storage |
| `/_u/<name>` routing | 200 |
| Unknown `/_u/` name | 502 naming the fix |
| Unreachable upstream | 502 to the agent, proxy stayed up, failure recorded |

## Usage extraction

| | input | output | cache read | 5m write | 1h write |
|---|---|---|---|---|---|
| non-streaming | 1200 | 340 | 45000 | 800 | 0 |
| streaming | 500 | **777** | 12000 | 1500 | 500 |

The streaming output figure is the one that matters: `message_delta` carries a
**running total**, not an increment, and 777 is the final value rather than a
sum with the `message_start` value of 1. Requests with no usage block were
recorded `token_source='unknown'` with NULL counts — absence, not zero.

`/_u/openrouter` was recorded as `anthropic` because the alias pointed at
`api.anthropic.com`. That is correct by design: the **host** is the fact, the
route label is not.

## Correlation and precedence

Seeded two turns in the same window, then ran the real `Reconciler`:

| turn | before | after | check |
|---|---|---|---|
| A | `model_map`, tokens 999/111 from logs | `proxy`, **tokens still 999/111** | provider wins, tokens fill gaps only |
| B | `unknown`, no tokens | `proxy`, tokens 500/777/12000 | the gap-fill case Layer 3 exists for |

Turn A is the important row. Wholesale "last layer wins" would have replaced
provider-reported counts with proxy-observed ones and made the two
indistinguishable; it did not.

All four `match_method` states were exercised:

- `model_time_window` — unique candidate, matched.
- `ambiguous` — a second turn on the same model in the same window made 4
  observations ambiguous. All were left unattributed and the new turn stayed
  `unknown`/`unknown`. **It refused to guess**, which is the point: a wrong
  attribution is indistinguishable from a right one afterwards.
- `no_candidate` — an observation backdated past the 30-minute grace was
  abandoned.
- `pending` — held while a turn could still appear.

Running the reconciler twice returned all zeros the second time — idempotent.

## What this run also found

Two leaks in the redaction pattern set, fixed and version-bumped to 2. See
[redaction.md](redaction.md).
