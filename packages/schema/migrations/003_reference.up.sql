-- 003_reference — model→provider inference map and the pricing table.
--
-- Both are reference data. model_providers is consulted only when Layer 3 and
-- config resolution have both failed; model_pricing is read once at ingest to
-- stamp turns.cost_usd and is never used to recompute cost retroactively.
--
-- Rollback: 003_reference.down.sql.

-- ---------------------------------------------------------------------------
-- model_providers — longest-prefix inference of provider from a model id.
--
-- This is the weakest rule in the precedence chain (proxy > config >
-- model_map > unknown) and is wrong by construction for gateways: a request
-- for 'claude-opus-5' through OpenRouter or Bedrock is not Anthropic-direct,
-- and no amount of prefix matching can tell. Rows resolved this way are
-- stamped provider_source='model_map' so the dashboard can show them as
-- inferred rather than known.
-- ---------------------------------------------------------------------------
CREATE TABLE model_providers (
  id               int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  model_id_prefix  text NOT NULL UNIQUE,
  provider_id      int NOT NULL REFERENCES providers(id),
  notes            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT model_providers_prefix_lower CHECK (model_id_prefix = lower(model_id_prefix))
);

COMMENT ON TABLE model_providers IS
  'Prefix→provider inference, matched longest-prefix-first against turns.model_normalized. Used only when proxy and config resolution both failed.';

INSERT INTO model_providers (model_id_prefix, provider_id, notes)
SELECT v.prefix, p.id, v.notes
FROM (VALUES
  ('claude-',   'anthropic', 'Direct Anthropic API. Wrong if routed via Bedrock/Vertex/OpenRouter — those are only distinguishable at Layer 3.'),
  ('gpt-',      'openai',    NULL),
  ('o1',        'openai',    NULL),
  ('o3',        'openai',    NULL),
  ('o4',        'openai',    NULL),
  ('gemini-',   'google',    NULL),
  ('qwen',      'dashscope', 'Qwen weights are also served by OpenRouter and local Ollama; DashScope is only the most common case, not a certainty.'),
  ('deepseek-', 'openrouter', 'Most commonly reached through a gateway rather than direct.'),
  ('llama',     'ollama',    'Assumed local. Also served by Bedrock and OpenRouter.'),
  ('mistral',   'ollama',    'Assumed local. Also served by Bedrock and OpenRouter.'),
  ('codestral', 'ollama',    NULL),
  ('copilot',   'github-copilot', NULL)
) AS v(prefix, provider_key, notes)
JOIN providers p ON p.key = v.provider_key;

-- ---------------------------------------------------------------------------
-- model_pricing — rates keyed on (provider, model), with a validity period.
--
-- Keyed on the PAIR, not the model alone: the same model id priced through
-- OpenRouter, Bedrock or direct differs, so a model-only key would quietly
-- bill gateway traffic at direct rates.
--
-- Cost is computed at ingest from the row valid at the turn's started_at and
-- stored on the turn, together with the pricing row id that produced it. A
-- later price change therefore never rewrites history — it inserts a new row
-- with a new effective_from and closes the previous one.
-- ---------------------------------------------------------------------------
CREATE TABLE model_pricing (
  id                           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider_id                  int NOT NULL REFERENCES providers(id),
  model_normalized             text NOT NULL,

  input_usd_per_mtok           numeric(12,6) NOT NULL,
  output_usd_per_mtok          numeric(12,6) NOT NULL,
  -- Anthropic bills cache writes at 1.25x input for the 5-minute TTL and 2x
  -- for the 1-hour TTL, and cache reads at 0.1x input. Claude Code's usage
  -- payload reports the two TTL buckets separately
  -- (usage.cache_creation.ephemeral_5m_input_tokens / _1h_), so keeping them
  -- as separate rates is the difference between a correct bill and a ~60%
  -- error on cache-heavy sessions. Verified against the Anthropic pricing
  -- reference on 2026-09-11.
  cache_read_usd_per_mtok      numeric(12,6),
  cache_write_5m_usd_per_mtok  numeric(12,6),
  cache_write_1h_usd_per_mtok  numeric(12,6),

  effective_from               timestamptz NOT NULL,
  effective_to                 timestamptz,
  source                       text NOT NULL DEFAULT 'seed',
  created_at                   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT model_pricing_period_ordered
    CHECK (effective_to IS NULL OR effective_to > effective_from),
  CONSTRAINT model_pricing_rates_nonnegative
    CHECK (input_usd_per_mtok >= 0 AND output_usd_per_mtok >= 0),

  -- Two overlapping price rows for one (provider, model) would make cost
  -- lookup ambiguous and silently non-deterministic. Make it unrepresentable.
  CONSTRAINT model_pricing_no_overlap EXCLUDE USING gist (
    provider_id      WITH =,
    model_normalized WITH =,
    tstzrange(effective_from, effective_to) WITH &&
  )
);

COMMENT ON TABLE model_pricing IS
  'Rates per (provider, model, period). Read once at ingest; turns.cost_usd is never recomputed from it retroactively.';

-- Seed: Anthropic first-party rates, USD per million tokens, verified
-- 2026-09-11. Cache rates derived from the documented multipliers
-- (5m write = 1.25x input, 1h write = 2x input, read = 0.1x input) except
-- claude-fable-5-1, whose cache reads are 0.025x ($0.25/MTok).
--
-- effective_from is set to epoch deliberately: this is the first known price
-- and backfilled history predates any price we recorded. When a rate changes,
-- do NOT edit these rows — close them with effective_to and insert new ones.
INSERT INTO model_pricing (
  provider_id, model_normalized,
  input_usd_per_mtok, output_usd_per_mtok,
  cache_read_usd_per_mtok, cache_write_5m_usd_per_mtok, cache_write_1h_usd_per_mtok,
  effective_from, source
)
SELECT p.id, v.model, v.inp, v.outp, v.cread, v.c5m, v.c1h,
       'epoch'::timestamptz, 'seed:anthropic-2026-09-11'
FROM (VALUES
  ('claude-opus-5',    5.00,  25.00, 0.50, 6.25,  10.00),
  ('claude-opus-4-8',  5.00,  25.00, 0.50, 6.25,  10.00),
  ('claude-opus-4-7',  5.00,  25.00, 0.50, 6.25,  10.00),
  ('claude-opus-4-6',  5.00,  25.00, 0.50, 6.25,  10.00),
  ('claude-sonnet-5',  2.00,  10.00, 0.20, 2.50,   4.00),
  ('claude-sonnet-4-6',3.00,  15.00, 0.30, 3.75,   6.00),
  ('claude-haiku-4-5', 1.00,   5.00, 0.10, 1.25,   2.00),
  ('claude-fable-5',  10.00,  50.00, 1.00, 12.50, 20.00),
  ('claude-fable-5-1',10.00,  50.00, 0.25, 12.50, 20.00)
) AS v(model, inp, outp, cread, c5m, c1h)
CROSS JOIN providers p
WHERE p.key = 'anthropic';

-- NOTE: no seed rows for openai / google / dashscope / openrouter / ollama.
-- Ollama is genuinely free at the point of use (local inference), and I have
-- not verified current third-party rates on this machine. A missing price row
-- makes turns.cost_usd NULL and turns.cost_source 'unpriced' — which the
-- dashboard must render as "not priced", never as $0.00. Silently pricing an
-- unknown model at zero is the failure mode this omission exists to prevent.
