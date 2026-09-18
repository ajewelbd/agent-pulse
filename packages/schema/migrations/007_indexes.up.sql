-- 007_indexes — every index, with the query it exists for and the plan problem
-- it prevents.
--
-- Kept in one migration so index strategy can be reviewed, rolled back and
-- re-tuned as a unit without touching table definitions or data.
--
-- Rollback: 007_indexes.down.sql — non-destructive, drops indexes only.
--
-- Note on what is NOT here: every UNIQUE constraint already creates a btree.
-- turns(session_id, seq), tool_calls(turn_id, seq), file_changes(turn_id, seq),
-- raw_events(source, external_id) and sessions(agent_id, external_session_id)
-- are therefore already indexed and are not repeated below.

-- ===========================================================================
-- TURN LIST — the main dashboard query.
--
--   SELECT … FROM turns
--   WHERE  started_at BETWEEN $1 AND $2      -- always present
--     [AND project_id = $3] [AND agent_id = $4]
--     [AND provider_id = $5] [AND model_normalized = $6] [AND git_branch = $7]
--   ORDER BY started_at DESC
--   LIMIT 50;
--
-- Plan concern: without a leading-column match on the filter plus started_at
-- in the index, Postgres sorts the whole filtered set before applying LIMIT.
-- On a year of history that is a multi-second sort for a page of 50 rows.
-- Each index below lets the planner walk the btree backwards and stop at 50.
-- ===========================================================================

-- Unfiltered timeline, and the fallback when only a date range is given.
CREATE INDEX turns_started_at_idx ON turns (started_at DESC);

-- Project timeline. The composite ordering matters: (project_id, started_at
-- DESC) serves both the equality filter and the sort; (started_at, project_id)
-- would serve only the sort and re-scan every project.
CREATE INDEX turns_project_started_idx ON turns (project_id, started_at DESC);

CREATE INDEX turns_agent_started_idx ON turns (agent_id, started_at DESC);

-- Provider × model breakdown on the aggregates page, and the model filter on
-- the list. Leading provider_id because "all Anthropic spend" is a real query
-- while "all claude-opus-5 across every provider" is the rarer one — and the
-- prefix (provider_id) alone still serves the former.
CREATE INDEX turns_provider_model_started_idx
  ON turns (provider_id, model_normalized, started_at DESC);

-- Branch filter is always scoped to a project in the UI — a bare branch name
-- like 'main' is meaningless across repos — so project_id leads.
CREATE INDEX turns_project_branch_started_idx
  ON turns (project_id, git_branch, started_at DESC)
  WHERE git_branch IS NOT NULL;

-- RECONCILER: closes turns left 'partial' by a stream that never terminated.
--
--   SELECT id FROM turns WHERE status = 'partial' AND started_at < now() - $1;
--
-- Partial index rather than a full one on status: 'complete' will be ~99% of
-- rows, so an index over all statuses is mostly dead weight that still has to
-- be maintained on every insert. This one stays tiny and shrinks as turns
-- close.
CREATE INDEX turns_partial_reconcile_idx
  ON turns (started_at)
  WHERE status = 'partial';

-- AGGREGATES BY DAY: tokens and cost per day / project / agent.
--
--   SELECT date_trunc('day', started_at AT TIME ZONE 'UTC'), sum(cost_usd) …
--   GROUP BY 1;
--
-- The AT TIME ZONE 'UTC' is not cosmetic: date_trunc on a bare timestamptz is
-- STABLE (it depends on the session TimeZone) and cannot be indexed. Fixing
-- the zone makes the expression IMMUTABLE and indexable — and everything is
-- stored UTC anyway, so it changes no results.
CREATE INDEX turns_day_utc_idx
  ON turns ((date_trunc('day', started_at AT TIME ZONE 'UTC')));

-- FULL-TEXT SEARCH over prompt + response.
--
--   WHERE search_tsv @@ websearch_to_tsquery('english', $1)
--
-- GIN, not GiST: GIN is slower to update but far faster to search, and this
-- table is written once per turn and searched interactively.
-- fastupdate stays on (default) so ingest is not blocked by index maintenance;
-- the pending list is flushed by autovacuum.
CREATE INDEX turns_search_tsv_idx ON turns USING gin (search_tsv);

-- Cost attribution audits ("which turns used the price row I just corrected?").
CREATE INDEX turns_pricing_idx ON turns (pricing_id) WHERE pricing_id IS NOT NULL;

-- ===========================================================================
-- SESSIONS
-- ===========================================================================

-- Session list for a project, newest first.
CREATE INDEX sessions_project_started_idx ON sessions (project_id, started_at DESC);

-- Rolling sub-agent sessions up under their parent on the turn detail page.
CREATE INDEX sessions_parent_idx ON sessions (parent_session_id)
  WHERE parent_session_id IS NOT NULL;

-- ===========================================================================
-- TURN DETAIL — commands and file changes for one turn.
--
-- Both are already covered by their UNIQUE (turn_id, seq) constraints, which
-- is exactly the access pattern (equality on turn_id, ordered by seq). No
-- extra index needed; noted here so the omission reads as deliberate.
-- ===========================================================================

-- Dashboard warning banner: "N file changes in this range could not be
-- confidently attributed to the agent." Partial, because 'agent' is the
-- overwhelming majority and is never the thing being searched for.
CREATE INDEX file_changes_uncertain_idx ON file_changes (turn_id)
  WHERE attribution = 'uncertain';

-- "History of this file" — not a v1 dashboard feature, but the index is cheap
-- and the query is the obvious next request. text_pattern_ops so that prefix
-- matching on a directory (path LIKE '/Users/x/repo/src/%') can use it; the
-- default opclass cannot serve LIKE under a non-C collation.
CREATE INDEX file_changes_path_idx ON file_changes (path text_pattern_ops);

-- ===========================================================================
-- RAW EVENTS
-- ===========================================================================

-- Replay and re-derive for one session.
CREATE INDEX raw_events_session_idx ON raw_events (agent_id, session_external_id)
  WHERE session_external_id IS NOT NULL;

-- Retention sweeps by date range. raw_events has no FK to projects, so the
-- cascade that cleans the derived tables does not touch it — it must be
-- deleted on its own, by this index.
CREATE INDEX raw_events_ingested_idx ON raw_events (ingested_at);

-- Deliberately NO GIN index on raw_events.payload. It would roughly double the
-- write cost of the hottest insert path in the system to serve ad-hoc JSON
-- queries that are not a v1 feature — replay reads by session or by date, both
-- covered above. Add one only when a real query needs it.

-- ===========================================================================
-- REFERENCE
-- ===========================================================================

-- Pricing lookup at ingest: exact (provider, model) then the row whose period
-- covers the turn's timestamp. The EXCLUDE constraint in 003 already built a
-- GiST index over (provider_id, model_normalized, period) which serves this,
-- but a plain btree on the equality pair is cheaper for the common exact-match
-- probe and lets the planner avoid GiST entirely when only one row matches.
CREATE INDEX model_pricing_lookup_idx
  ON model_pricing (provider_id, model_normalized, effective_from DESC);
