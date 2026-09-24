-- 015_opus_5_5_pricing — rates for claude-opus-5-5, so its turns can be priced.
--
-- WHY. Claude Code started reporting model claude-opus-5-5 on 2026-09-24 and
-- 003 has no row for it, so every such turn was correctly 'unpriced'.
--
-- SOURCE. Anthropic first-party rates from the claude-api skill's model table
-- (cached 2026-06-24), read 2026-09-24: $4 input, $20 output, $0.20 cache read
-- per million tokens. Cache writes are not listed there; they are derived from
-- the documented multipliers 003 uses (5m write = 1.25x input, 1h write = 2x
-- input). The model is marked "launching" in that table, so recheck these
-- against the pricing page — `source` says where they came from.
--
-- effective_from = epoch, following 003: this is the first known price and
-- no turn on this model predates it.
INSERT INTO model_pricing (
  provider_id, model_normalized,
  input_usd_per_mtok, output_usd_per_mtok,
  cache_read_usd_per_mtok, cache_write_5m_usd_per_mtok, cache_write_1h_usd_per_mtok,
  effective_from, source
)
SELECT p.id, 'claude-opus-5-5', 4.00, 20.00, 0.20, 5.00, 8.00,
       'epoch'::timestamptz, 'skill:claude-api-2026-09-24'
FROM providers p
WHERE p.key = 'anthropic';
