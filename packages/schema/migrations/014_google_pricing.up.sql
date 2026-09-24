-- 014_google_pricing — first Gemini rates, so Gemini CLI turns can be priced.
--
-- SOURCE. Rates supplied by the operator on 2026-09-24 as Google's standard
-- (non-batch, non-priority) pay-as-you-go prices "as of September 2026", USD
-- per million tokens. NOT independently checked against Google's pricing page
-- or an invoice from this machine — `source` says so, so nobody mistakes these
-- for verified rates.
--
-- WHAT IS DELIBERATELY LEFT OUT, and why each omission is safe today:
--
--   * Long-context tier (>200k prompt tokens per request) for the Pro models.
--     model_pricing holds one rate per period, not tiers. Checked on this
--     machine: across every ~/.gemini/tmp session the largest single request
--     is 48,499 input tokens, so no recorded turn is affected. A future >200k
--     request would be under-billed at the standard rate — a known gap, not a
--     silent one.
--   * Batch (0.5x) and priority (1.8x). Gemini CLI sends interactive standard
--     requests; neither applies.
--   * Cache writes. Gemini reports no cache-write bucket and its implicit
--     caching has no write charge, so cache_write_* stays NULL. Explicit
--     context-cache storage ($/GB-hour) is not a per-token rate.
--
-- CACHED INPUT. Gemini's `tokens.input` INCLUDES `tokens.cached` (observed:
-- total = input + output + thoughts + tool, with cached non-zero). The adapter
-- stores the uncached remainder as input_tokens so each token is billed once,
-- at either the input or the cache-read rate.
--
-- effective_from = epoch, following the 003 precedent: this is the first known
-- price, and the gemini-2.5-pro turns on record (2025-09/10) predate it. They
-- will be priced at these September 2026 rates.
--
-- gemini-3.7-flash and gemini-3.8-flash are promotional "through Dec 31, 2026",
-- so their rows close then. Turns after that are 'unpriced' until a new row is
-- inserted — better than silently billing the promotional rate forever.
INSERT INTO model_pricing (
  provider_id, model_normalized,
  input_usd_per_mtok, output_usd_per_mtok, cache_read_usd_per_mtok,
  effective_from, effective_to, source
)
SELECT p.id, v.model, v.inp, v.outp, v.cread,
       'epoch'::timestamptz, v.until, 'operator:google-2026-09-24'
FROM (VALUES
  ('gemini-3.1-pro-preview', 2.00, 12.00, 0.200, NULL::timestamptz),
  ('gemini-2.5-pro',         1.25, 10.00, 0.125, NULL),
  ('gemini-3.8-flash',       0.75,  3.75, 0.075, '2027-01-01T00:00:00Z'),
  ('gemini-3.7-flash',       0.75,  3.75, 0.075, '2027-01-01T00:00:00Z'),
  ('gemini-3.6-flash',       1.50,  7.50, 0.150, NULL),
  ('gemini-3.5-flash',       1.50,  9.00, 0.150, NULL),
  ('gemini-2.5-flash',       0.30,  2.50, 0.030, NULL),
  ('gemini-3.5-flash-lite',  0.30,  2.50, 0.030, NULL),
  ('gemini-3.1-flash-lite',  0.25,  1.50, 0.025, NULL),
  ('gemini-2.5-flash-lite',  0.10,  0.40, 0.010, NULL)
) AS v(model, inp, outp, cread, until)
CROSS JOIN providers p
WHERE p.key = 'google';
