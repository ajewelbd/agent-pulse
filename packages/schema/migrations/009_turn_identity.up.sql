-- 009_turn_identity — dedupe turns replayed by resumed sessions.
--
-- WHY THIS EXISTS (found running against real transcripts):
--
-- When a session is resumed or its context is compacted, Claude Code
-- re-appends earlier records to the SAME transcript file. Verified in session
-- 10e3cf92: the prompt record uuid bd1bce1e appears at line indexes 2, 1900
-- and 3454 — three copies of one turn, which the tailer faithfully read as
-- three turns at seq 1, 15 and 28.
--
-- seq alone therefore cannot identify a turn: it is a position in the file,
-- and the file repeats itself. The agent's own prompt uuid is the stable
-- identity, so that becomes the idempotency key whenever it is present.
--
-- Partial (WHERE external_turn_id IS NOT NULL) because an adapter for an agent
-- that reports no per-prompt id still has to be able to write turns; those
-- keep falling back to (session_id, seq).
--
-- Consequence, deliberately accepted: seq stays unique but becomes
-- non-contiguous on resumed sessions, because a replayed turn updates its
-- original row and never occupies the later number. seq is an ordering key,
-- not a count — ORDER BY seq is still correct.
--
-- Rollback: 009_turn_identity.down.sql

CREATE UNIQUE INDEX turns_session_external_turn_unique
  ON turns (session_id, external_turn_id)
  WHERE external_turn_id IS NOT NULL;

COMMENT ON INDEX turns_session_external_turn_unique IS
  'Turn identity for agents that report a stable prompt id. Makes re-appended history from a resumed session update the original turn instead of duplicating it.';
