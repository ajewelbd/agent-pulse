-- Rollback of 014_google_pricing.
--
-- Turns already priced from these rows keep their stored cost_usd (cost is
-- never recomputed), but turns.pricing_id is ON DELETE SET NULL, and a priced
-- turn with no pricing_id violates turns_cost_consistent — so the DELETE fails
-- while any turn still references these rows. That is intended: un-pricing
-- history is a decision to make explicitly, not a side effect of a rollback.
DELETE FROM model_pricing
WHERE source = 'operator:google-2026-09-24';
