-- 001_foundation — extensions, closed-set enums, and the model normalizer.
--
-- Rollback: 001_foundation.down.sql (drops the types, the function and the
-- extension). Safe only while no table references them, i.e. after 002-007 are
-- rolled back first.

-- btree_gist lets an EXCLUDE constraint mix equality columns (provider_id,
-- model_normalized) with a range column (the validity period) in one index.
-- Used by model_pricing to make overlapping price rows impossible.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ---------------------------------------------------------------------------
-- Enums.
--
-- Only genuinely closed sets are enums. `agent` and `provider` are NOT enums —
-- they are lookup tables (migration 002), because the spec requires that adding
-- an agent costs "one adapter + one config entry, nothing else". An enum would
-- add "+ one migration" to that list, and Postgres cannot remove an enum label
-- once added, so an enum there would also make migrations irreversible.
-- ---------------------------------------------------------------------------

-- Which capture layer produced a row. Precedence for conflicts is
-- hooks > logs > proxy; the loser is retained in raw_events.
CREATE TYPE capture_layer AS ENUM ('hooks', 'logs', 'proxy', 'reconciler');

-- Provider-reported counts and locally estimated counts must never be summed
-- together silently, so every token row records where its numbers came from.
CREATE TYPE token_source AS ENUM ('provider', 'proxy', 'estimated', 'unknown');

-- Which rule resolved the provider. Mirrors the spec's precedence order.
CREATE TYPE provider_source AS ENUM ('proxy', 'config', 'model_map', 'unknown');

CREATE TYPE turn_status AS ENUM ('complete', 'partial', 'error', 'aborted');

CREATE TYPE change_type AS ENUM ('add', 'modify', 'delete', 'rename');

-- 'uncertain' when the pre-edit blob hash disagrees with what the agent
-- reported (a concurrent human edit), or when git was unusable for the repo.
CREATE TYPE attribution AS ENUM ('agent', 'uncertain');

-- Whether a duration was reported by the agent or derived from timestamps.
-- Claude Code's Layer 1 logs report neither exit codes nor durations for shell
-- commands, so every backfilled row is 'derived' (wall-clock between the
-- tool_use and tool_result records — an upper bound that includes model
-- latency). Kept separate from measured values for the same reason as
-- token_source.
CREATE TYPE duration_source AS ENUM ('reported', 'derived', 'unknown');

-- Whether a turn's cost is real. 'unpriced' means no model_pricing row covered
-- (provider, model, started_at) — the dashboard must render that as "not
-- priced", never as $0.00, or unknown models silently look free.
-- 'free_local' is a genuine zero (Ollama and other local inference).
CREATE TYPE cost_source AS ENUM ('priced', 'unpriced', 'free_local');

-- ---------------------------------------------------------------------------
-- normalize_model_id — raw provider model string → stable comparison key.
--
-- The raw string always survives in model_raw; this only feeds the
-- model_normalized GENERATED columns on sessions and turns.
--
-- MAINTENANCE WARNING: this function is referenced by STORED generated
-- columns. CREATE OR REPLACE does NOT recompute already-stored values, which
-- would leave old rows normalized by the old rules and new rows by the new
-- ones — a silent split. To change normalization, write a new migration that
-- drops and re-adds the generated columns (see docs/schema.md → Changing
-- normalization). Postgres requires IMMUTABLE here, which is also why every
-- step below is a pure regexp/string call.
--
-- Transformations, in order:
--   1. lower + trim
--   2. strip any routing prefix up to the last '/'
--        openrouter  anthropic/claude-opus-5      → claude-opus-5
--        google      models/gemini-2.5-pro        → gemini-2.5-pro
--   3. strip a Bedrock/Vertex region prefix       us.anthropic.…  → anthropic.…
--   4. strip a vendor-namespace prefix            anthropic.claude-…  → claude-…
--   5. strip a Bedrock version suffix             …-v1:0          → …
--   6. strip a trailing date, '-' or '@' form     claude-sonnet-4-5-20250929
--                                                 → claude-sonnet-4-5
--   7. strip a bare ':latest' tag (Ollama)
--
-- Deliberately NOT stripped: Ollama size tags such as ':7b' in
-- 'qwen2.5-coder:7b' — those identify a different set of weights and different
-- economics, so collapsing them would be wrong.
-- ---------------------------------------------------------------------------
CREATE FUNCTION normalize_model_id(raw text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
RETURNS NULL ON NULL INPUT
AS $$
  SELECT nullif(
    regexp_replace(
      regexp_replace(
        regexp_replace(
          regexp_replace(
            regexp_replace(
              regexp_replace(lower(btrim(raw)), '^.*/', ''),
              '^(us|eu|apac|jp|global)\.', ''),
            '^(anthropic|openai|google|meta|mistral|amazon|cohere|ai21|deepseek|qwen|moonshot)\.', ''),
          '-v[0-9]+:[0-9]+$', ''),
        '[@-]20[0-9]{6}$', ''),
      ':latest$', ''),
    '');
$$;

COMMENT ON FUNCTION normalize_model_id(text) IS
  'Normalizes a raw provider model id for grouping/pricing. Referenced by STORED generated columns — changing it requires a column rewrite migration, not CREATE OR REPLACE.';
