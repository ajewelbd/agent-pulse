# Claude Code hook payloads — verified

Source: the schema definitions compiled into the CLI shipped on this machine,
`~/.vscode/extensions/anthropic.claude-code-2.1.278-darwin-arm64/resources/native-binary/claude`,
cross-checked against `claude-code-settings.schema.json` in the same bundle.

This replaces the "unverified, do not guess" note carried since Phase 1. It is
read out of the running implementation, not from documentation or memory.

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

## Where the exit code actually goes

One place: an OpenTelemetry span.

```
span: claude_code.bash.subprocess
attrs: shell.type, command_length, timeout_ms
       exit_code, stdout_bytes, stderr_bytes, interrupted, backgrounded
content attrs: command
```

The relevant env vars are all present in the binary:
`CLAUDE_CODE_ENABLE_TELEMETRY`, `OTEL_EXPORTER_OTLP_ENDPOINT`,
`OTEL_EXPORTER_OTLP_PROTOCOL`, `OTEL_TRACES_EXPORTER`, `OTEL_METRICS_EXPORTER`,
`OTEL_LOGS_EXPORTER`, `OTEL_EXPORTER_OTLP_HEADERS`.

**This is unbuilt.** Capturing it means an OTLP receiver — a Layer 4 — and it
is not in the current system. Until then `tool_calls.exit_code` stays NULL and
the dashboard must keep saying "unknown" rather than 0.

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

## Still not verified

The schema is authoritative for **shape**. What it cannot tell us:

- Whether a non-zero-exit Bash command fires `PostToolUse` or
  `PostToolUseFailure` in practice. The schema strongly implies `PostToolUse`
  (a command that runs and exits 1 has not failed as a *tool*), but that is
  inference, not observation.
- What `returnCodeInterpretation` actually contains, and for which exit codes.
- Whether `duration_ms` is present in practice or usually omitted.

Answering these needs one real session with hooks installed. Nothing above
depends on it: the exit-code finding comes from the output schema itself,
which lists every field the tool can return.
