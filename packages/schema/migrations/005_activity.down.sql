-- Rollback of 005_activity.
--
-- DATA LOSS: drops every recorded command and file change, including all diff
-- bodies. Turns survive, so the dashboard would still list turns but show them
-- with no commands and no file changes — a partially-populated UI rather than
-- an obviously broken one. Roll back 004 too if you want a clean state.
--
-- Back up first:
--   pg_dump -Fc -t tool_calls -t file_changes -t file_change_diffs \
--     "$DATABASE_URL" > /backups/activity.dump
--
-- Order matters: diffs reference file_changes, file_changes reference
-- tool_calls.

DROP TABLE IF EXISTS file_change_diffs;
DROP TABLE IF EXISTS file_changes;
DROP TABLE IF EXISTS tool_calls;
