# Phase 1 — Format Discovery Report

Machine: darwin 25.5.0, user `md.ashrafulalam`. All findings below come from
inspecting this machine on 2026-09-11. Nothing here is from memory; anything I
could not verify is marked **I'm not sure** with the command to run.

---

## 0. Headline

**Only 1 of the 5 target agents is actually installed with usable history.**

| Agent | Installed? | Session transcripts | Verdict |
|---|---|---|---|
| Claude Code | yes — v2.1.201 → 2.1.268 | 31 JSONL files, 25,571 records | **Build against this** |
| Codex CLI | **no** | none | Cannot write an adapter |
| Qwen Code | **no** | none | Cannot write an adapter |
| Cursor CLI | **no** | none | Cannot write an adapter |
| GitHub Copilot CLI | partial — `~/.copilot` exists | **none** (server mode only) | Cannot write an adapter |
| _Gemini CLI (not in scope)_ | yes — `@google/gemini-cli@0.9.0` | 3 JSON session files | Available as a substitute |

Evidence for the four negatives:

```
$ ls -lad ~/.codex ~/.qwen ~/.cursor        # → no such directory
$ ls -a ~ | grep -iE 'codex|qwen|cursor'    # → no matches
$ command -v claude codex qwen cursor-agent copilot gh   # → all empty
```

`~/.copilot` exists but contains only `config.json` (a `firstLaunchAt` stamp),
two IDE `.lock` files, and 8 process logs. Every log says the same thing:

```
[INFO] Starting CLI in server mode (stdio)
[INFO] Starting CLI in stdio mode (Rust JSON-RPC engine)
```

It has only ever been driven by an IDE over JSON-RPC, never run interactively,
and it has written **zero** transcripts, tokens, or tool records.

Note also: Claude Code here runs entirely as the **VSCode extension** —
`entrypoint` is `claude-vscode` on all 25,571 records, and the `claude` binary
is not on `$PATH`. That does not change the log format, but it does mean a
"CLI-only" assumption in the collector would be wrong.

---

## 1. Claude Code — verified in detail

### 1.1 Location and layout

```
~/.claude/projects/<path-slug>/<session-uuid>.jsonl          # main transcript
~/.claude/projects/<path-slug>/<session-uuid>/subagents/*.jsonl   # sub-agents
~/.claude/projects/<path-slug>/<session-uuid>/tool-results/*.txt  # spilled stdout
~/.claude/file-history/<session-uuid>/<hash>@v<n>            # pre-edit file backups
~/.claude/settings.json                                      # hooks live here
```

`<path-slug>` is the absolute project path with `/` and `.` replaced by `-`,
e.g. `/Volumes/Macintosh HD 1/Projects/Atom/atom-otp-service` becomes
`-Volumes-Macintosh-HD-1-Projects-Atom-atom-otp-service`.

**This slug is lossy and must not be used to recover the project path** — a
literal `-` in a directory name is indistinguishable from a separator. Read
`cwd` off any record in the file instead; it carries the true absolute path.

### 1.2 Record types

One JSONL line per record. `type` values observed, with counts from a single
1,810-line session:

| type | count | purpose |
|---|---|---|
| `assistant` | 788 | model output + **usage** |
| `user` | 438 | user prompts **and** tool results |
| `queue-operation` | 123 | prompt queueing |
| `last-prompt` | 100 | resume pointer, rewritten repeatedly |
| `ai-title` | 96 | generated session title |
| `mode` | 90 | plan/normal mode switches |
| `attachment` | 89 | pasted/attached content |
| `file-history-snapshot` | 56 | edit-tracking checkpoint |
| `file-history-delta` | 22 | one file backed up |
| `system` | 8 | model fallback, API errors, retries |

Every message-bearing record carries: `uuid`, `parentUuid`, `sessionId`,
`timestamp` (ISO-8601 UTC, `Z`-suffixed), `cwd`, `gitBranch`, `version`,
`entrypoint`, `isSidechain`, `userType`.

### 1.3 Does it record the provider? — **No.**

There is no `provider`, `base_url`, `api_host`, or equivalent field anywhere in
25,571 records. Only the model string:

```json
"model": "claude-opus-4-8"
```

Models observed across all transcripts:

| model | records |
|---|---|
| `claude-opus-5` | 8,011 |
| `claude-opus-4-8` | 4,185 |
| `claude-fable-5` | 782 |
| `claude-sonnet-5` | 660 |
| `<synthetic>` | 15 |

`<synthetic>` is Claude Code's own placeholder for locally-generated messages
(errors, interrupts). **It must be excluded from cost computation** — it maps
to no real model and has no real usage.

→ Provider resolution for this agent falls to `config` or `model_map`.
Per the spec's precedence rules, `provider_source` will be `model_map` for all
backfilled history, since no base URL was recorded at the time.

### 1.4 Does it record the resolved base URL? — **No.**

Not in the transcript. `~/.claude/settings.json` contains only `permissions`,
`model`, and `effortLevel` — no base URL. `~/.claude/session-env/<uuid>/` exists
as a directory per session but is **empty** on this machine, so it is not a
usable source either.

→ Base URL is only obtainable live, via Layer 3 (proxy) or a `SessionStart`
hook that captures `ANTHROPIC_BASE_URL`. Historical sessions cannot be
attributed beyond `model_map`.

### 1.5 Token counts — **fully provider-reported.** This is the strong point.

Verbatim from an `assistant` record:

```json
"usage": {
  "input_tokens": 2,
  "cache_creation_input_tokens": 19422,
  "cache_read_input_tokens": 12959,
  "output_tokens": 553,
  "server_tool_use": { "web_search_requests": 0, "web_fetch_requests": 0 },
  "service_tier": "standard",
  "cache_creation": {
    "ephemeral_1h_input_tokens": 19422,
    "ephemeral_5m_input_tokens": 0
  },
  "inference_geo": "not_available",
  "iterations": [ { "input_tokens": 2, "output_tokens": 553, ... } ],
  "speed": "standard"
}
```

Maps cleanly onto the schema: `input_tokens` → `input_tokens`,
`cache_read_input_tokens` → `cache_read_tokens`,
`cache_creation_input_tokens` → `cache_write_tokens`,
`output_tokens` → `output_tokens`. `token_source = 'provider'`.

Three things to handle that are **not** obvious:

1. **`input_tokens` is near-zero on cached turns** (here: 2). The real prompt
   cost is `input + cache_read + cache_write`. Summing only `input_tokens`
   across the dashboard would under-report by orders of magnitude.
2. **`cache_creation` splits 5m vs 1h ephemeral tokens, which price
   differently.** The spec keys cost on `(provider, model)`; for Anthropic it
   also needs the TTL bucket. I'd add `cache_write_5m_tokens` /
   `cache_write_1h_tokens` to `turns` rather than collapsing them.
3. **`iterations[]` is a per-request breakdown.** The top-level figures are the
   totals; do not also sum `iterations` or you double-count.

One turn produces **many** `assistant` records (one per tool round-trip). Turn
totals are the sum over all assistant records between two user prompts.

### 1.6 Executed shell commands — **exit code and duration are MISSING.**

This is the single biggest gap. Across all 31 transcripts I found **3,822**
Bash-style results. The union of every key any of them ever carries:

```
backgroundCwdHint, backgroundTaskId, dangerouslyDisableSandbox, gitOperation,
interrupted, isImage, noOutputExpected, persistedOutputPath,
persistedOutputSize, returnCodeInterpretation, staleReadFileStateHint,
stderr, stdout, timedOutAfterMs
```

There is **no `exitCode` and no `durationMs`**. A typical result:

```json
{ "stdout": "...", "stderr": "", "interrupted": false,
  "isImage": false, "noOutputExpected": false }
```

The one exception: **backgrounded** commands report an exit code, but only as
prose inside a `<task-notification>` block in the following user message —

```
<summary>Background command "Rebuild fluentd image..." completed (exit code 0)</summary>
```

— which is parseable but fragile, and covers a small minority of commands.

Consequences for the design:

- `tool_calls.exit_code` is **NULL for all backfilled history**. The column
  must be nullable and the dashboard must render "unknown", not "0".
- Duration can be *derived* as `tool_result.timestamp − tool_use.timestamp`.
  That is wall-clock including model latency around the call, so it is an
  upper bound. Store it in `duration_ms` but add a `duration_source` enum
  (`measured|derived`) so the two are never silently mixed — same reasoning the
  spec already applies to `token_source`.
- **This is the concrete justification for Layer 2 hooks.** A `PostToolUse`
  hook is the only way to get real exit codes going forward.

`stdout` is also spilled to `tool-results/<id>.txt` when large, referenced by
`persistedOutputPath` — the adapter should read that file rather than truncate,
then apply the 8KB cap at insert.

The `command` string itself is in the `tool_use` block, not the result:

```json
{ "type": "tool_use", "id": "toolu_01U8...", "name": "Read",
  "input": { "file_path": "..." }, "caller": { "type": "direct" } }
```

Linkage is `tool_use.id` → `tool_result.tool_use_id`. The `tool_result` block
lives inside a record of `type: "user"` — so **`type: "user"` does not mean
"human prompt"**. An adapter that treats it that way will invent hundreds of
phantom turns. Real user prompts have `message.content` as a plain string (or a
content array with no `tool_result` block) and carry `promptSource`/`origin`.

### 1.7 Edit payloads — **yes, full old/new content. Excellent.**

`Edit` results:

```json
{ "filePath": "...", "oldString": "...", "newString": "...",
  "originalFile": "<entire file before the edit>",
  "structuredPatch": [...], "replaceAll": false, "userModified": false }
```

`Write` results:

```json
{ "type": "create", "filePath": "...", "content": "<full new content>",
  "originalFile": "...", "structuredPatch": [...], "userModified": false }
```

`structuredPatch` is already a hunk list — exactly what's needed for
`file_change_diffs.unified_diff`:

```json
[ { "oldStart": 6, "oldLines": 12, "newStart": 6, "newLines": 16,
    "lines": [ "   build-essential \\", "-RUN gem install excon ...",
               "+# Install Ruby gems pinned to ..." ] } ]
```

So for Claude Code the spec's "prefer agent-reported edit payloads over git" is
fully achievable from Layer 1 alone — no git gap-fill needed, correct even in a
dirty tree and for untracked files. `lines_added`/`lines_removed` come from
counting `+`/`-` prefixes in `lines`.

Two useful extras:
- `userModified: true` flags that the human touched the file between read and
  write → map to `attribution = 'uncertain'`.
- `~/.claude/file-history/<session>/<hash>@v<n>` holds the actual pre-edit file
  bytes, giving a real `blob_hash_before` without touching the repo.

### 1.8 Git context — per record, as the spec wants

`gitBranch` is on every record (`"feature/otp-service-security-improvements"`).
**There is no HEAD sha and no dirty flag** in the transcript — those must come
from a hook or from git gap-fill. `git_head_sha` and `git_dirty` will be NULL
for all backfilled history.

### 1.9 Mid-session model switches — confirmed, and recorded explicitly

```json
{ "type": "system", "subtype": "model_consent_fallback",
  "content": "Switched to Sonnet 5 for this session · Fable 5 requires usage credits",
  "originalModel": "claude-fable-5", "fallbackModel": "claude-sonnet-5",
  "level": "warning", "persistedAsDefault": false }
```

This validates the spec's "turn value wins over session value" rule with real
data. Each `assistant` record carries its own `model`, so per-turn attribution
works without needing to interpret this event — but the event is worth storing
in `raw_events` for provenance.

### 1.10 Sub-agents — separate files, plus a summary record

Sub-agent turns are written to `<session>/subagents/agent-<id>.jsonl`, and
`isSidechain: true` appears on 1,153 of 25,571 records. The parent gets a
summary result:

```json
{ "status": "completed", "agentId": "...", "agentType": "...",
  "prompt": "...", "resolvedModel": "...", "usage": {...},
  "totalTokens": ..., "totalDurationMs": ..., "totalToolUseCount": ... }
```

Note `totalDurationMs` exists here but not on individual Bash calls.
Sub-agent tokens are reported **both** in the sub-agent's own file and in the
parent's summary — ingesting both double-counts. I'd ingest the sub-agent file
as the source of truth and store the parent summary in `raw_events` only.

### 1.11 Hooks — 33 events available (authoritative)

Read from the schema shipped with the installed extension,
`~/.vscode/extensions/anthropic.claude-code-2.1.268-darwin-arm64/claude-code-settings.schema.json`:

```
PreToolUse, PostToolUse, PostToolUseFailure, PostToolBatch, Notification,
UserPromptSubmit, UserPromptExpansion, SessionStart, SessionEnd, Stop,
StopFailure, SubagentStart, SubagentStop, PreCompact, PostCompact,
PreModelSwitch, PostModelSwitch, PermissionRequest, PermissionDenied, Setup,
TeammateIdle, TaskCreated, TaskCompleted, Elicitation, ElicitationResult,
ConfigChange, WorktreeCreate, WorktreeRemove, InstructionsLoaded, CwdChanged,
FileChanged, DirectoryAdded, MessageDisplay
```

Hook entries support `matcher`, `if` (permission-rule filter, e.g.
`Bash(git *)`), `command`, `args` (exec form, no shell — the safe choice for a
collector hook), and `shell`.

The ones that matter here: `PostToolUse` (exit codes), `UserPromptSubmit` (turn
start), `Stop` (turn end), `SessionStart` (base URL capture), `PreCompact` /
`PostCompact` (the spec's compaction edge case), `PreModelSwitch` /
`PostModelSwitch` (model changes).

**I'm not sure** of the exact JSON payload `PostToolUse` writes to a hook's
stdin — specifically whether it includes the Bash exit code, which is the whole
reason for using it. The schema defines the config shape, not the payload.

To settle it, run this and then any Bash command in a Claude Code session:

```bash
mkdir -p /tmp/hookprobe
cat > /tmp/hookprobe/dump.sh <<'EOF'
#!/bin/bash
cat >> /tmp/hookprobe/payloads.ndjson
echo >> /tmp/hookprobe/payloads.ndjson
EOF
chmod +x /tmp/hookprobe/dump.sh
```

then add to `~/.claude/settings.json`:

```json
"hooks": {
  "PostToolUse": [
    { "matcher": "Bash",
      "hooks": [ { "type": "command", "command": "/tmp/hookprobe/dump.sh" } ] }
  ]
}
```

and send me `cat /tmp/hookprobe/payloads.ndjson`. I'll build the Layer 2
adapter against the real payload rather than guessing.

---

## 2. Codex CLI, Qwen Code, Cursor CLI — not installed

No directories, no binaries, no transcripts. I will not write parsers for
these. Guessing a schema is exactly what the spec forbids, and a parser written
against a guess can't even be tested here.

If you want them in v1, install and run each once, then send me:

```bash
ls -la ~/.codex ~/.qwen ~/.cursor 2>/dev/null
find ~/.codex ~/.qwen ~/.cursor -type f \( -name '*.json*' -o -name '*.log' \) 2>/dev/null | head -40
```

plus one full record from each (`head -c 4000 <a session file>`).

---

## 3. GitHub Copilot CLI — installed, but produces nothing ingestible

`~/.copilot/` holds only:

- `config.json` — `{"firstLaunchAt": "2026-07-28T02:52:21.642Z"}`
- `ide/*.lock` — two IDE session locks
- `logs/process-*.log` — 8 files, each ~5 lines of startup INFO

No prompts, no responses, no tokens, no tool calls, no model names. Every
invocation was `server mode (stdio)` driven by an IDE.

**I'm not sure** whether the standalone `@github/copilot` CLI writes session
history elsewhere when run interactively — this machine has never run it that
way, so there is nothing to inspect. To find out, run it once interactively and
send me:

```bash
find ~/.copilot -newermt '-10 minutes' -type f
ls -la ~/.copilot
```

Until then, Copilot CLI is **Layer 3 only** — the proxy would be the sole
source of turns for it.

---

## 4. Gemini CLI — not in scope, but it's the one other real option

`@google/gemini-cli@0.9.0` is installed globally and has real history at
`~/.gemini/tmp/<projectHash>/chats/session-<ts>-<id>.json` (plus a flat
`logs.json` of prompts per project).

```json
{ "sessionId": "...", "projectHash": "...", "startTime": "...",
  "lastUpdated": "...", "messages": [ ... ] }
```

Messages are `type: "user"` or `type: "gemini"`, and the assistant ones carry
both model and tokens:

```json
{ "type": "gemini", "model": "gemini-2.5-pro",
  "tokens": { "input": 8629, "output": 51, "cached": 0,
              "thoughts": 250, "tool": 0, "total": 8930 } }
```

Trade-offs vs. the spec's requirements:

- Good: provider-reported tokens, explicit model, cached-token count.
- Bad: **no tool-call records and no edit payloads at all** in the chat files —
  columns 6 and 7 of the dashboard would be empty.
- Bad: `projectHash` is a SHA-256 of the project path, i.e. **one-way**. Project
  resolution needs a hash→path index built by hashing your known code roots.
- Note: `tokens.thoughts` is a Gemini-specific bucket with no equivalent in the
  spec's schema; it'd need its own column or it silently vanishes from totals.

---

## 5. What I recommend, and the decision I need from you

The architecture in the spec is sound and I don't want to change it. But four of
five adapters have nothing to be written against, so Phase 3's "one adapter
end-to-end" can only mean Claude Code.

My recommendation: **build the full pipeline against Claude Code now** — it is
the richest of the six by a wide margin (full usage, full edit payloads,
per-record git branch, 33 hook events, 25,571 records of real backfill data to
test against). Keep the adapter interface pluggable exactly as specified so the
others drop in unchanged once their formats are known.

Three things I need from you before Phase 2:

1. **Scope** — build Claude Code only for now, or install the missing agents
   first so I can inspect them? (Gemini CLI could stand in as a second adapter
   to prove the interface generalises, but it has no tool/diff data.)
2. **The `PostToolUse` payload** — run the hook probe in §1.11 and send me the
   output. Exit codes for shell commands depend on it, and it's the one thing I
   can't determine by reading files.
3. **Code roots** — which directories should be mounted read-only as
   `/host/code/...`? I can see `/Volumes/Macintosh HD 1/Projects/Atom` and
   `/Volumes/Macintosh HD 1/Practice` in the transcripts; confirm the full list,
   since a missing mount must fail loudly at startup rather than yield zero
   turns.

Answer those and I'll move to Phase 2 (schema + reversible migrations).

---

## Appendix — commands used

```bash
ls -lad ~/.claude ~/.codex ~/.qwen ~/.cursor ~/.copilot
find ~/.claude/projects -name '*.jsonl' | wc -l          # 31
command -v claude codex qwen cursor-agent copilot gh     # all empty
npm ls -g --depth=0
grep -h 'Starting CLI' ~/.copilot/logs/*.log | sort | uniq -c
python3 -c "..."   # record-type census, usage dump, toolUseResult key union
```

Record counts: 25,571 total across 31 files; 3,822 Bash-style results; 1,153
sidechain records; 37 distinct Claude Code versions (2.1.201 → 2.1.268).
