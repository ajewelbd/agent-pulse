-- Rollback of 007_indexes.
--
-- NON-DESTRUCTIVE: no data is lost, only query performance. The dashboard will
-- still return correct results, via sequential scans and full sorts — expect
-- the turn list and search to become unusably slow on real history, but
-- nothing breaks and nothing needs re-ingesting.
--
-- This is the safe migration to roll back and re-apply while tuning index
-- strategy.
--
-- Indexes backing UNIQUE/PRIMARY KEY/EXCLUDE constraints are owned by those
-- constraints and are not dropped here — they belong to 003-006.

DROP INDEX IF EXISTS model_pricing_lookup_idx;

DROP INDEX IF EXISTS raw_events_ingested_idx;
DROP INDEX IF EXISTS raw_events_session_idx;

DROP INDEX IF EXISTS file_changes_path_idx;
DROP INDEX IF EXISTS file_changes_uncertain_idx;

DROP INDEX IF EXISTS sessions_parent_idx;
DROP INDEX IF EXISTS sessions_project_started_idx;

DROP INDEX IF EXISTS turns_pricing_idx;
DROP INDEX IF EXISTS turns_search_tsv_idx;
DROP INDEX IF EXISTS turns_day_utc_idx;
DROP INDEX IF EXISTS turns_partial_reconcile_idx;
DROP INDEX IF EXISTS turns_project_branch_started_idx;
DROP INDEX IF EXISTS turns_provider_model_started_idx;
DROP INDEX IF EXISTS turns_agent_started_idx;
DROP INDEX IF EXISTS turns_project_started_idx;
DROP INDEX IF EXISTS turns_started_at_idx;
