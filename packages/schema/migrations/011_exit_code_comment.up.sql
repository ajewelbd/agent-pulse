-- 011_exit_code_comment — correct a false claim recorded in the schema.
--
-- Migration 005 documented tool_calls.exit_code as:
--
--   'NULL = unknown, not success. Layer 1 transcripts do not record exit
--    codes; only the PostToolUse hook can supply them.'
--
-- The second half is wrong, and was written from assumption rather than
-- inspection. Verified against the schema definitions compiled into the CLI
-- shipped on this machine (claude-code 2.1.278): the Bash tool's declared
-- output schema has seventeen fields — stdout, stderr, interrupted,
-- returnCodeInterpretation, isImage, persistedOutputPath, persistedOutputSize,
-- backgroundTaskId and friends — and NONE of them is an exit status.
-- `tool_response` on a PostToolUse event is exactly that object.
--
-- The exit code is known to the tool internally (it reads .code off the
-- process handle) but is used only to derive returnCodeInterpretation and to
-- set an attribute on an OpenTelemetry span:
--
--   span  claude_code.bash.subprocess
--   attrs exit_code, stdout_bytes, stderr_bytes, interrupted, backgrounded
--
-- So installing the hook would NOT have populated this column. The only route
-- is an OTLP receiver, which this system does not have.
--
-- 005 itself is left untouched: it is applied and checksummed, and rewriting
-- an applied migration is how a checksum contract stops meaning anything. The
-- correction is additive.
--
-- Rollback: 011_exit_code_comment.down.sql
-- Safe in both directions: a COMMENT changes no data and holds no lock beyond
-- the statement itself.

COMMENT ON COLUMN tool_calls.exit_code IS
  'NULL = unknown, NEVER success. Nothing currently capturable records this: Layer 1 transcripts omit it, and the PostToolUse hook does not carry it either (the Bash tool result has stdout/stderr/interrupted but no exit status). The only source is the OpenTelemetry span claude_code.bash.subprocess, attribute exit_code, which needs a receiver this system does not have. See docs/hook-payloads.md.';

COMMENT ON COLUMN tool_calls.duration_source IS
  'How duration_ms was obtained. ''derived'' = wall-clock between the tool_use record and its result, which includes model latency and is an upper bound, not execution time. ''reported'' = measured by the agent. The PostToolUse hook does supply a real measurement (duration_ms, explicitly excluding permission-prompt and hook time), so this is the field hooks genuinely improve — unlike exit_code.';
