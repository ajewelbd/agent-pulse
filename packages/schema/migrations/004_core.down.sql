-- Rollback of 004_core.
--
-- DATA LOSS: drops every turn and session. This is the irreversible one —
-- turns hold the ingested history, and re-ingesting requires the original
-- agent transcripts to still exist on the host.
--
-- Back up first:
--   pg_dump -Fc "$DATABASE_URL" > /backups/pre-004-rollback.dump
--
-- Preconditions: 005+ rolled back first (tool_calls and file_changes reference
-- turns). The DROP fails on those FKs otherwise, which is the guard.

DROP TABLE IF EXISTS turns;
DROP TABLE IF EXISTS sessions;
