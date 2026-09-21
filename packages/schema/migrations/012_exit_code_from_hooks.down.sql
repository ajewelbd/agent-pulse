-- Rollback of 012_exit_code_from_hooks.
--
-- NON-DESTRUCTIVE: restores migration 011's comment text. No data is touched.
--
-- Consequence: the schema goes back to claiming exit codes are unobtainable
-- except via an OpenTelemetry span attribute, which is false in both halves —
-- the span does not carry it, and hooks do make it recoverable.

COMMENT ON COLUMN tool_calls.exit_code IS
  'NULL = unknown, NEVER success. Nothing currently capturable records this: Layer 1 transcripts omit it, and the PostToolUse hook does not carry it either (the Bash tool result has stdout/stderr/interrupted but no exit status). The only source is the OpenTelemetry span claude_code.bash.subprocess, attribute exit_code, which needs a receiver this system does not have. See docs/hook-payloads.md.';

COMMENT ON COLUMN tool_calls.duration_source IS
  'How duration_ms was obtained. ''derived'' = wall-clock between the tool_use record and its result, which includes model latency and is an upper bound, not execution time. ''reported'' = measured by the agent. The PostToolUse hook does supply a real measurement (duration_ms, explicitly excluding permission-prompt and hook time), so this is the field hooks genuinely improve — unlike exit_code.';
