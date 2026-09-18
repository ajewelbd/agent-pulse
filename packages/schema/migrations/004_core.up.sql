-- 004_core — sessions and turns.
--
-- Rollback: 004_core.down.sql. Destructive.

-- ---------------------------------------------------------------------------
-- sessions — one agent run against one project.
-- ---------------------------------------------------------------------------
CREATE TABLE sessions (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  agent_id             int NOT NULL REFERENCES agents(id),
  agent_version        text,
  project_id           bigint NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  external_session_id  text NOT NULL,

  -- Session-level provider/model is the opening value only. A session can
  -- switch model mid-flight — verified in real transcripts here, e.g. a
  -- 'model_consent_fallback' event moving claude-fable-5 → claude-sonnet-5
  -- mid-session. The TURN value wins for all reporting; this is context.
  provider_id          int REFERENCES providers(id),
  model_raw            text,
  model_normalized     text GENERATED ALWAYS AS (normalize_model_id(model_raw)) STORED,
  provider_source      provider_source NOT NULL DEFAULT 'unknown',

  started_at           timestamptz,
  ended_at             timestamptz,
  source               capture_layer NOT NULL,

  -- Sub-agents / parallel tasks. Claude Code writes these to a separate
  -- transcript under <session>/subagents/ and flags them isSidechain; 1,153 of
  -- 25,571 records on this machine are sidechain. Modelling them as child
  -- sessions keeps their turns from interleaving into the parent's seq
  -- numbering while still letting the dashboard roll them up.
  parent_session_id    bigint REFERENCES sessions(id) ON DELETE CASCADE,
  is_sidechain         boolean NOT NULL DEFAULT false,

  entrypoint           text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),

  -- Idempotency: re-tailing the same transcript must find the same session.
  CONSTRAINT sessions_external_unique UNIQUE (agent_id, external_session_id),
  CONSTRAINT sessions_period_ordered  CHECK (ended_at IS NULL OR started_at IS NULL OR ended_at >= started_at),
  CONSTRAINT sessions_not_own_parent  CHECK (parent_session_id IS NULL OR parent_session_id <> id)
);

-- These two composite uniques exist only so that turns can carry a
-- denormalized project_id/agent_id with a COMPOSITE foreign key back to the
-- owning session. That makes it structurally impossible for a turn to claim a
-- different project or agent than its session — the usual failure mode of
-- denormalizing for index speed. See the turns FKs below.
ALTER TABLE sessions ADD CONSTRAINT sessions_id_project_unique UNIQUE (id, project_id);
ALTER TABLE sessions ADD CONSTRAINT sessions_id_agent_unique   UNIQUE (id, agent_id);

COMMENT ON COLUMN sessions.model_raw IS
  'Verbatim provider model string. Never collapsed at ingest — model_normalized is generated from it.';

-- ---------------------------------------------------------------------------
-- turns — one user prompt → one assistant completion. The dashboard row.
-- ---------------------------------------------------------------------------
CREATE TABLE turns (
  id                     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id             bigint NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq                    int NOT NULL,

  -- Denormalized from sessions purely so the turn-list query can filter by
  -- project/agent and sort by started_at from a single composite index,
  -- without joining sessions before the sort. Consistency is guaranteed by the
  -- composite FKs below, not by convention.
  project_id             bigint NOT NULL,
  agent_id               int NOT NULL,

  external_turn_id       text,

  prompt_text            text,
  response_text          text,

  -- Token counts. All nullable: absence means "not reported", which is not the
  -- same as zero and must not be summed as zero.
  input_tokens           bigint,
  output_tokens          bigint,
  cache_read_tokens      bigint,
  cache_write_tokens     bigint,
  -- Split because the two TTLs price differently (1.25x vs 2x input).
  -- cache_write_tokens is the total; these two are its breakdown when the
  -- provider reports it.
  cache_write_5m_tokens  bigint,
  cache_write_1h_tokens  bigint,
  token_source           token_source NOT NULL DEFAULT 'unknown',

  -- Total billable input, for the dashboard. Claude Code reports
  -- input_tokens ≈ 2 on a cache-hit turn with ~13k read and ~19k written —
  -- summing input_tokens alone under-reports by orders of magnitude, so the
  -- honest total is materialized here rather than left to each query.
  total_input_tokens     bigint GENERATED ALWAYS AS (
                           coalesce(input_tokens, 0)
                         + coalesce(cache_read_tokens, 0)
                         + coalesce(cache_write_tokens, 0)
                         ) STORED,

  cost_usd               numeric(14,8),
  cost_source            cost_source NOT NULL DEFAULT 'unpriced',
  -- Which price row produced cost_usd. Kept so a cost can be explained and
  -- audited later; cost itself is never recomputed from it.
  pricing_id             bigint REFERENCES model_pricing(id) ON DELETE SET NULL,

  provider_id            int REFERENCES providers(id),
  model_raw              text,
  model_normalized       text GENERATED ALWAYS AS (normalize_model_id(model_raw)) STORED,
  provider_source        provider_source NOT NULL DEFAULT 'unknown',

  -- Captured per turn, not per session: a checkout mid-session is normal.
  -- git_head_sha and git_dirty are NULL for Claude Code backfill — the
  -- transcript records gitBranch but neither sha nor dirty state.
  git_branch             text,
  git_head_sha           text,
  git_dirty              boolean,

  started_at             timestamptz NOT NULL,
  ended_at               timestamptz,
  duration_ms            bigint GENERATED ALWAYS AS (
                           CASE WHEN ended_at IS NOT NULL
                                THEN (EXTRACT(EPOCH FROM (ended_at - started_at)) * 1000)::bigint
                           END
                         ) STORED,

  status                 turn_status NOT NULL DEFAULT 'partial',
  source                 capture_layer NOT NULL,
  redaction_version      int NOT NULL REFERENCES redaction_versions(version),

  -- Full-text search over prompt + response.
  --
  -- Each field is capped at 512 KB before tokenizing: to_tsvector throws
  -- "string is too long for tsvector" past 1 MB of lexemes, which would turn a
  -- single huge response into a hard INSERT failure and stall the whole tail.
  -- Truncating the INDEX input costs recall on enormous responses only; the
  -- full text is still stored intact in the columns above.
  search_tsv             tsvector GENERATED ALWAYS AS (
                           to_tsvector('english',
                             left(coalesce(prompt_text, ''), 524288) || ' ' ||
                             left(coalesce(response_text, ''), 524288))
                         ) STORED,

  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT turns_session_seq_unique UNIQUE (session_id, seq),
  CONSTRAINT turns_period_ordered     CHECK (ended_at IS NULL OR ended_at >= started_at),
  CONSTRAINT turns_tokens_nonnegative CHECK (
       coalesce(input_tokens, 0)        >= 0
   AND coalesce(output_tokens, 0)       >= 0
   AND coalesce(cache_read_tokens, 0)   >= 0
   AND coalesce(cache_write_tokens, 0)  >= 0
  ),
  -- A priced turn must name the price it used; an unpriced one must not claim
  -- a cost. Prevents the "$0.00 for an unknown model" bug at the schema level.
  CONSTRAINT turns_cost_consistent CHECK (
    (cost_source = 'priced'     AND cost_usd IS NOT NULL AND pricing_id IS NOT NULL)
    OR (cost_source = 'free_local' AND cost_usd = 0)
    OR (cost_source = 'unpriced'   AND cost_usd IS NULL)
  ),

  -- Composite FKs: a turn's project/agent must be its session's project/agent.
  CONSTRAINT turns_session_project_fk FOREIGN KEY (session_id, project_id)
    REFERENCES sessions (id, project_id) ON DELETE CASCADE,
  CONSTRAINT turns_session_agent_fk   FOREIGN KEY (session_id, agent_id)
    REFERENCES sessions (id, agent_id)   ON DELETE CASCADE
);

COMMENT ON COLUMN turns.status IS
  'partial until a terminal event closes the turn. Streaming writes arrive incrementally, so a turn is born partial; the reconciler closes stale partials after a timeout.';
COMMENT ON COLUMN turns.total_input_tokens IS
  'input + cache_read + cache_write. Use this for cost and volume reporting — input_tokens alone is near-zero on cached turns.';
