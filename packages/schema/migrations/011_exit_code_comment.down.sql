-- Rollback of 011_exit_code_comment.
--
-- NON-DESTRUCTIVE: restores the previous COMMENT text. No data is touched and
-- no index or constraint changes.
--
-- Consequence: the schema goes back to claiming that the PostToolUse hook can
-- supply exit codes, which is not true of claude-code 2.1.278. Roll back only
-- if you are also rolling back to a build that made that claim elsewhere.

COMMENT ON COLUMN tool_calls.exit_code IS
  'NULL = unknown, not success. Layer 1 transcripts do not record exit codes; only the PostToolUse hook can supply them.';

COMMENT ON COLUMN tool_calls.duration_source IS NULL;
