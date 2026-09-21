-- 012_exit_code_from_hooks — exit codes ARE recoverable, from hook events.
--
-- This corrects migration 011, which corrected 005. Three passes at the same
-- column, so the reasoning is recorded in full rather than left as another
-- confident sentence someone has to disprove later.
--
--   005 claimed the PostToolUse hook would supply exit codes.  WRONG.
--   011 claimed an OpenTelemetry span attribute would.          WRONG.
--   012 is derived from OBSERVED hook events on this machine.
--
-- Why 011 was wrong: the Bash tool really does call
--   SGt(To, {exit_code: Ki.code, …})
-- but SGt is defined, exactly once in the binary, as `function SGt(n,e){return}`
-- — an empty body. The attributes are computed and discarded.
--
-- What is actually true, from real hook payloads captured on this machine
-- after installing hooks on 2026-09-21:
--
--   bash -c 'exit 42'      -> PostToolUseFailure, error = "Exit code 42\n…"
--   grep (no match, exit 1)-> PostToolUse, tool_response.returnCodeInterpretation
--                             = "No matches found"
--   ordinary success       -> PostToolUse, no returnCodeInterpretation
--
-- So the derivation is:
--
--   PostToolUseFailure, error matching ^Exit code (\d+)  -> exit_code = N   (observed)
--   PostToolUse, no returnCodeInterpretation             -> exit_code = 0   (inferred)
--   PostToolUse, returnCodeInterpretation present        -> non-zero, value
--                                                           NOT stated -> NULL
--
-- The middle rule is inference, not observation: it rests on the tool raising
-- PostToolUseFailure for every genuine non-zero exit, and on
-- returnCodeInterpretation existing precisely to mark "non-error exit code
-- with special meaning" (its own schema description). It held across every
-- observed event, but it is a rule about the agent's behaviour, not a value
-- the agent reported, and duration_source has no equivalent to express that.
--
-- The third bucket stays NULL on purpose. "grep found nothing" is exit 1 in
-- practice, but mapping an interpretation string back to a number would be a
-- per-tool guess, and a guessed exit code is worse than an absent one.
--
-- IMPORTANT SCOPE: this only ever populates tool calls that occurred while
-- hooks were installed. The 8261 historical tool calls have no hook events and
-- stay NULL forever. Backfill is impossible, not merely unimplemented.
--
-- This migration only corrects the column comments; the enrichment pass that
-- writes the values is application code.
--
-- Rollback: 012_exit_code_from_hooks.down.sql — comments only, no data.

COMMENT ON COLUMN tool_calls.exit_code IS
  'NULL = unknown, NEVER success. Populatable only for tool calls captured while Layer 2 hooks were installed: PostToolUseFailure states the code in its error text ("Exit code N"), and a PostToolUse with no returnCodeInterpretation implies 0. A PostToolUse WITH returnCodeInterpretation (e.g. "No matches found") means a non-zero exit whose value the agent does not state — that stays NULL rather than being guessed. Transcripts carry no exit code, so historical rows can never be backfilled. See docs/hook-payloads.md.';

COMMENT ON COLUMN tool_calls.duration_source IS
  'How duration_ms was obtained. ''derived'' = wall-clock between the tool_use record and its result, which includes model latency and is an upper bound, not execution time. ''reported'' = measured, from the hook payload''s duration_ms, which excludes permission-prompt and hook time. Observed present on every hook tool event.';
