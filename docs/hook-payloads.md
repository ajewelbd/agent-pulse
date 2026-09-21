# Claude Code hook payloads — verified

Source: the schema definitions compiled into the CLI shipped on this machine,
`~/.vscode/extensions/anthropic.claude-code-2.1.278-darwin-arm64/resources/native-binary/claude`,
cross-checked against `claude-code-settings.schema.json` in the same bundle.

This replaces the "unverified, do not guess" note carried since Phase 1. It is
read out of the running implementation, not from documentation or memory.

**Since confirmed against live events.** Hooks were installed on 2026-09-21 and
real `PostToolUse` and `PreCompact` payloads captured. Everything below held.
See §"Confirmed against live events" at the end for the observed field sets and
two corrections the live data forced.

---

## The headline: PostToolUse does NOT carry exit codes

**The project claimed, in six places, that installing the `PostToolUse` hook
would supply real shell exit codes. That is false.** The Bash tool's declared
output schema has seventeen fields and none of them is an exit status:

```
stdout                          string    "The standard output of the command"
stderr                          string    "The standard error output of the command"
interrupted                     boolean   "Whether the command was interrupted"
returnCodeInterpretation        string?   "Semantic interpretation for non-error
                                           exit codes with special meaning"
isImage                         boolean?
persistedOutputPath             string?
persistedOutputSize             number?
backgroundTaskId                string?
backgroundedByUser              boolean?
backgroundedByTurnAbort         boolean?
backgroundedToDeliverMessage    boolean?
timedOutAfterMs                 number?
backgroundEndsWithFinalResponse true?
dangerouslyDisableSandbox       boolean?
noOutputExpected                boolean?
structuredContent               block[]?
gitOperation                    object?
```

`tool_response` on a `PostToolUse` event is exactly this object. The exit code
is known internally — the tool builds its result from a process handle whose
`.code` it reads — but `.code` is used only to derive
`returnCodeInterpretation` and to populate a telemetry span. It is not placed
in the returned data.

So `make install-hooks` would have been run, a new session started, and the
exit-code column would still have been empty, with the dashboard still telling
the user to install the hook.

## Where the exit code goes: nowhere

My first pass through the binary said the exit code lands on an OpenTelemetry
span, and recommended building an OTLP receiver to collect it. **That was
wrong too**, and it is worth recording how, because the mistake is the same
shape as the original one: reading a call site and assuming the callee does
what its arguments suggest.

The Bash tool does this when the subprocess resolves:

```js
SGt(To, { exit_code: Ki.code, stdout_bytes: …, stderr_bytes: …,
          interrupted: Ki.interrupted, …})
```

That looks decisive. But `SGt` is:

```js
function SGt(n, e) { return }
```

An empty body. There is exactly **one** definition of `SGt` in the whole
217 MB binary and four call sites, two of them the ones above. The attributes
are computed and thrown away, so `exit_code` never reaches the span, and an
OTLP receiver would collect a span carrying `shell.type`, `command_length` and
`timeout_ms` — and no exit status.

The exit code escapes the Bash tool in exactly two ways in 2.1.278:

1. Into Anthropic's own analytics event
   (`tengu_bash_tool_command_executed`, field `exit_code`), which is not an
   OTLP export and is not user-collectable.
2. Into the span **status message**, and only when the command was
   interrupted: `F8e(To, \`interrupted (exit ${Ki.code})\`)`. `F8e` is real
   (`n.setStatus(…)`). So an OTLP receiver would recover an exit code for
   interrupted commands only, out of a human-readable string.

That was my conclusion for about ten minutes, and it was also wrong — see
"Exit codes are recoverable after all" below. It is right only about OTLP: an
OTLP receiver would not deliver exit codes. The route is hooks, just not the
field everyone assumed.

A Layer 4 OTLP receiver may still be worth building for other signals —
`claude_code.subagent.spawn` carries `agent_id`/`parent_agent_id`, spans carry
real wall-clock durations and `gen_ai.tool.call.id`, and Claude Code exports
token/cost metrics. The relevant env vars are all present
(`CLAUDE_CODE_ENABLE_TELEMETRY`, `OTEL_EXPORTER_OTLP_ENDPOINT`,
`OTEL_EXPORTER_OTLP_PROTOCOL` — `http/json` is supported, so no protobuf
decoding would be needed). But it must not be sold as the fix for exit codes,
because it is not one.

The join key is documented in the payload itself. `prompt_id` on every hook
event is described as:

> UUID correlating a user prompt with all subsequent events until the next
> prompt. Same value emitted on OpenTelemetry events as the `prompt.id`
> attribute, so hook output can be joined to OTel events at prompt grain.

So hooks and OTLP are designed to be joined — at prompt grain, not tool grain.
Pinning an exit code to one specific `tool_calls` row would still need the
command text or ordering within the prompt.

---

## What hooks DO deliver

Worth installing on its own merits, just not for exit codes.

### Fields on every hook event

| Field | | Notes |
|---|---|---|
| `session_id` | required | joins to `sessions.external_session_id` |
| `transcript_path` | required | the Layer 1 JSONL this event belongs to |
| `cwd` | required | |
| `prompt_id` | optional | absent until the first user input of the process |
| `permission_mode` | optional | |
| `agent_id` | optional | **present only inside a subagent** — the field to use to tell subagent calls from main-thread ones |
| `agent_type` | optional | e.g. `general-purpose`; also set on the main thread of an `--agent` session |
| `effort.level` | optional | active reasoning effort for the turn |

`agent_id` is directly useful: it is the clean answer to the sub-agent
double-counting question carried since Phase 3.

### PostToolUse

```
hook_event_name  "PostToolUse"
tool_name        string
tool_input       object
tool_response    object          ← the Bash schema above
tool_use_id      string
duration_ms      number?   "Tool execution time in milliseconds.
                            Excludes permission-prompt and hook time."
mcp_server       object?
```

Two real upgrades over Layer 1:

- **`duration_ms` is a measurement.** The collector currently derives duration
  from surrounding transcript timestamps, which includes model latency and is
  an upper bound the UI marks with an asterisk. This is the real execution
  time, explicitly excluding permission-prompt and hook overhead.
- **`tool_use_id` is an exact join key**, replacing heuristic matching between
  hook events and transcript tool calls.

### PostToolUseFailure

```
hook_event_name  "PostToolUseFailure"
tool_name, tool_input, tool_use_id
error            string
is_interrupt     boolean?
duration_ms      number?
mcp_server       object?
```

This is the closest thing to an outcome signal: a tool that failed fires this
instead of `PostToolUse`. It is a **boolean-ish outcome, not an exit code** —
a `grep` that legitimately exits 1 is not a tool failure, so this cannot be
used to synthesise `exit_code`.

### PostToolBatch

```
hook_event_name  "PostToolBatch"
tool_calls       [{ tool_name, tool_input, tool_use_id, tool_response? }]
```

Its own description warns about a concurrency trap worth heeding:

> Fired once after every tool call in a batch has resolved, before the next
> model request. PostToolUse fires per-tool and **may run concurrently for
> parallel tool calls**; PostToolBatch fires exactly once with the full batch.

Concurrent `PostToolUse` hooks mean the receiver must not assume events arrive
in tool order. Sequence numbering has to come from the payload, not arrival
order.

### Other events the installer registers

```
UserPromptSubmit   prompt: string
                   source?: user | sdk | system | loop_wakeup
                          | schedule_wakeup | poll_event
PreCompact         trigger, custom_instructions
PostCompact        trigger, compact_summary
```

`UserPromptSubmit.source` distinguishes a human prompt from an SDK or wakeup
one — which is exactly the distinction the Claude Code adapter currently
derives heuristically in `isHumanPrompt()`.

### All 33 valid event names

From the settings schema enum, so the installer can be checked against it:

```
PreToolUse            PostToolUse           PostToolUseFailure    PostToolBatch
Notification          UserPromptSubmit      UserPromptExpansion   SessionStart
SessionEnd            Stop                  StopFailure           SubagentStart
SubagentStop          PreCompact            PostCompact           PreModelSwitch
PostModelSwitch       PermissionRequest     PermissionDenied      Setup
TeammateIdle          TaskCreated           TaskCompleted         Elicitation
ElicitationResult     ConfigChange          WorktreeCreate        WorktreeRemove
InstructionsLoaded    CwdChanged            FileChanged           DirectoryAdded
MessageDisplay
```

All nine events `scripts/install-hooks.sh` registers are in this list.

### Hook entry options not currently used

The settings schema allows more per-hook control than the installer uses:
`matcher` (tool-name pattern), `if` (permission-rule filter, e.g.
`Bash(git *)`, avoids spawning for non-matching calls), `timeout`, `async`,
`once`, `shell`, and `args` for exec-form spawning without a shell.

`args` is the security-relevant one: with it, `command` is spawned directly and
placeholders are substituted per element, so paths containing quotes, `$` or
backticks never reach a shell parser.

---

## Confirmed against live events

Hooks installed 2026-09-21; payloads below are real, captured from this
machine, not synthetic.

**`tool_response` contains exactly five fields**, across every observed
`PostToolUse`:

```
interrupted   isImage   noOutputExpected   stderr   stdout
```

No exit code. A scan of every captured hook payload for `exit_?code`
(case-insensitive) returns **zero** matches. The finding read from the schema
is confirmed by observation.

Observed top-level fields, with the number of events carrying each:

```
cwd 5   hook_event_name 5   prompt_id 5   scratchpad_dir 5
session_id 5   transcript_path 5
duration_ms 4   effort 4   permission_mode 4
tool_input 4   tool_name 4   tool_response 4   tool_use_id 4
custom_instructions 1   trigger 1        (these two from PreCompact)
```

`duration_ms` is present on every tool event, not optional in practice — one
observed value was 1158 ms. `tool_use_id` likewise (`toolu_011nRsDe5tjx…`), so
the exact-join-key plan is sound. `effort` arrived as `{"level":"high"}`.

### Two corrections the live data forced

**1. `scratchpad_dir` is not in the compiled schema.** It appears on every
observed event, carrying the session's scratchpad path. Reading the schema
alone would have missed it — a reminder that the schema is a lower bound on
what actually arrives, which is exactly why the receiver stores payloads
verbatim instead of projecting them into columns.

**2. Hooks take effect immediately, NOT at session start.** The installer, and
the Phase 3 notes, said settings.json is read only at session start and cited
a probe that did not fire. That is wrong: hooks installed mid-session began
firing within about a minute, in the session that was already running. The
event enum includes `ConfigChange`, which is consistent with settings being
watched rather than read once. The earlier probe presumably failed for another
reason.

`agent_id` was absent throughout, consistent with its documented meaning — all
observed events came from the main thread, not a subagent.

## Exit codes are recoverable after all

Found by installing hooks and running deliberate probes, after three earlier
conclusions about this column were wrong. Observed, on this machine:

| Command | Event fired | What carries the code |
|---|---|---|
| `bash -c 'exit 42'` | **PostToolUseFailure** | `error` = `"Exit code 42\n…"` |
| `grep` with no match (exit 1) | PostToolUse | `tool_response.returnCodeInterpretation` = `"No matches found"` |
| ordinary success | PostToolUse | neither field present |

So the exit code is never a numeric field — but for *failing* commands it is
stated verbatim at the start of the `error` string, which is a reliable parse.

### The derivation rule

```
PostToolUseFailure, error =~ ^Exit code (\d+)   -> exit_code = N   OBSERVED
PostToolUse, no returnCodeInterpretation        -> exit_code = 0   INFERRED
PostToolUse, returnCodeInterpretation present   -> non-zero, value
                                                   not stated -> NULL
```

The middle rule is inference, not observation. It rests on the tool raising
`PostToolUseFailure` for every genuine non-zero exit, and on
`returnCodeInterpretation` existing precisely to mark a "non-error exit code
with special meaning" — its own schema description. It held across every
observed event, but it is a claim about the agent's behaviour rather than a
value the agent reported, and it should be labelled as such wherever it is
surfaced.

The third bucket stays NULL deliberately. `grep` finding nothing is exit 1 in
practice, but recovering that number would mean mapping interpretation strings
to codes per tool — a guess, and a guessed exit code is worse than an absent
one.

### What this does not fix

**The 8261 historical tool calls stay NULL forever.** They predate hooks, and
transcripts never carried the code. This is not a backfill that has yet to be
run; it is impossible. Only tool calls captured while hooks are installed can
ever have an exit code.

The enrichment pass that applies this rule is application code and is **not
yet written**. Hook events are being captured verbatim in `raw_events` in the
meantime, so nothing is lost by the delay.

## Still not verified

- Whether a non-zero-exit Bash command fires `PostToolUse` or
  `PostToolUseFailure`. The schema implies `PostToolUse` (a command that runs
  and exits 1 has not failed as a *tool*), and no `PostToolUseFailure` has been
  observed yet. Still inference.
- What `returnCodeInterpretation` contains, and for which exit codes. It has
  not appeared in any observed `tool_response`.
- `agent_id` / `agent_type` in practice, which needs a subagent invocation.

None of these affects the exit-code conclusion, which is now confirmed from
both the schema and live data.
