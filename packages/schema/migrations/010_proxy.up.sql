-- 010_proxy — Layer 3 observations.
--
-- The proxy sees something no transcript can: the API host actually connected
-- to. That makes it the only authoritative source for provider attribution
-- (precedence proxy > config > model_map > unknown), and the only source of
-- token counts for agents whose logs omit them entirely — Copilot CLI writes
-- no transcripts at all on this machine.
--
-- These live in their own table rather than only in raw_events because they
-- have to be *correlated* to turns, and correlation over JSONB means a
-- sequential scan and a functional index for every field you match on.
--
-- Rollback: 010_proxy.down.sql

CREATE TABLE proxy_requests (
  id                     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  -- Idempotency, exactly as for raw_events: replaying a recording must not
  -- duplicate it. Content-derived by the proxy.
  external_id            text NOT NULL,

  -- The authoritative provider signal. upstream_host is what we actually
  -- connected to, not what the model id implies.
  upstream_host          text NOT NULL,
  upstream_url           text NOT NULL,
  method                 text NOT NULL,
  path                   text NOT NULL,
  provider_id            int REFERENCES providers(id),
  agent_id               int REFERENCES agents(id),

  model_raw              text,
  model_normalized       text GENERATED ALWAYS AS (normalize_model_id(model_raw)) STORED,

  is_streaming           boolean NOT NULL DEFAULT false,
  status_code            int,
  error_message          text,

  -- Provider-reported, hence token_source defaults to 'proxy' rather than
  -- 'provider': it is first-hand, but observed in transit rather than read
  -- back from the agent's own accounting. Keeping them distinguishable is the
  -- point of the enum.
  input_tokens           bigint,
  output_tokens          bigint,
  cache_read_tokens      bigint,
  cache_write_tokens     bigint,
  cache_write_5m_tokens  bigint,
  cache_write_1h_tokens  bigint,
  token_source           token_source NOT NULL DEFAULT 'proxy',

  cost_usd               numeric(14,8),
  cost_source            cost_source NOT NULL DEFAULT 'unpriced',
  pricing_id             bigint REFERENCES model_pricing(id) ON DELETE SET NULL,

  -- The provider's own request id when it returns one (Anthropic's
  -- `request-id` header). Gives a hard join key against a provider invoice or
  -- support ticket, which nothing else in this schema can offer.
  provider_request_id    text,

  started_at             timestamptz NOT NULL,
  ended_at               timestamptz,
  duration_ms            bigint GENERATED ALWAYS AS (
                           CASE WHEN ended_at IS NOT NULL
                                THEN (EXTRACT(EPOCH FROM (ended_at - started_at)) * 1000)::bigint
                           END
                         ) STORED,

  -- Correlation to a turn. NULL means "not yet matched" or "no match found" —
  -- distinguished by match_method, so an unmatchable observation is never
  -- silently indistinguishable from an unprocessed one.
  matched_turn_id        bigint REFERENCES turns(id) ON DELETE SET NULL,
  match_method           text,

  redaction_version      int NOT NULL REFERENCES redaction_versions(version),
  created_at             timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT proxy_requests_external_unique UNIQUE (external_id),
  CONSTRAINT proxy_requests_period_ordered CHECK (ended_at IS NULL OR ended_at >= started_at),
  CONSTRAINT proxy_requests_cost_consistent CHECK (
    (cost_source = 'priced'     AND cost_usd IS NOT NULL AND pricing_id IS NOT NULL)
    OR (cost_source = 'free_local' AND cost_usd = 0)
    OR (cost_source = 'unpriced'   AND cost_usd IS NULL)
  )
);

COMMENT ON COLUMN proxy_requests.upstream_host IS
  'The API host actually connected to. Authoritative for provider attribution — a model id cannot distinguish direct from gateway traffic.';
COMMENT ON COLUMN proxy_requests.match_method IS
  'How matched_turn_id was decided, or why it is NULL: model_time_window | ambiguous | no_candidate | pending.';

-- The reconciler's working set: observations not yet matched to a turn.
-- Partial, because once the backlog is drained this index is nearly empty
-- while the table keeps growing.
CREATE INDEX proxy_requests_unmatched_idx
  ON proxy_requests (started_at)
  WHERE matched_turn_id IS NULL AND match_method IS DISTINCT FROM 'no_candidate';

-- Correlation probe: find observations in a turn's time window for its model.
CREATE INDEX proxy_requests_model_started_idx
  ON proxy_requests (model_normalized, started_at);

-- Aggregates and retention sweeps.
CREATE INDEX proxy_requests_started_idx ON proxy_requests (started_at);
