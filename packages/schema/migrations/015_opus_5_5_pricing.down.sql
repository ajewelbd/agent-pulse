-- Rollback of 015_opus_5_5_pricing.
--
-- Same rule as 014: a priced turn referencing this row blocks the DELETE via
-- turns_cost_consistent, on purpose. Un-pricing history must be explicit.
DELETE FROM model_pricing
WHERE source = 'skill:claude-api-2026-09-24';
