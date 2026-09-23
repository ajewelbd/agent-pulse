import { query, queryOne } from './db';

/**
 * Every SQL statement the dashboard runs.
 *
 * Kept in one place so the indexes in migration 007 can be checked against the
 * queries that justify them, rather than scattered through components where
 * that correspondence silently rots.
 */

export interface TurnFilters {
  projectId?: string;
  /** Internal sessions.id — how "Open session" narrows the list to one run. */
  sessionId?: string;
  agentId?: string;
  providerId?: string;
  model?: string;
  branch?: string;
  from?: string;
  to?: string;
  q?: string;
  status?: string;
  /** 'oldest' reverses the list; anything else is newest-first. */
  sort?: string;
  page?: string;
}

/** The ORDER BY the list and the rank query must agree on. */
function orderDir(sort: string | undefined): 'ASC' | 'DESC' {
  return sort === 'oldest' ? 'ASC' : 'DESC';
}

/**
 * The editor-focus block Claude Code prefixes a prompt with.
 *
 * Verified on 2026-09-22: these are the only two leading tags in this archive
 * (207 of 474 turns), each is closed, and every one carries the real request
 * after it — so stripping it leaves the prompt, not nothing. A literal, never
 * user input; it is interpolated into three statements and lives here so they
 * cannot drift apart. `ltrim` is a separate call because Postgres takes
 * greediness from the FIRST quantifier, and the non-greedy `.*?` would make a
 * trailing `[[:space:]]*` match nothing.
 */
const IDE_BLOCK_RE = String.raw`^<(ide_opened_file|ide_selection)>.*?</\1>`;
const STRIP_IDE_BLOCK = (col: string): string =>
  `ltrim(regexp_replace(${col}, '${IDE_BLOCK_RE}', ''), E' \\t\\r\\n')`;

export interface TurnListRow extends Record<string, unknown> {
  id: string;
  seq: number;
  project_name: string;
  project_path: string;
  agent_key: string;
  /** The agent's own session id (a UUID for Claude Code). NOT NULL in the schema. */
  external_session_id: string;
  provider_key: string | null;
  provider_source: string;
  model_raw: string | null;
  model_normalized: string | null;
  git_branch: string | null;
  started_at: Date;
  ended_at: Date | null;
  duration_ms: string | null;
  status: string;
  token_source: string;
  total_input_tokens: string;
  output_tokens: string | null;
  cost_usd: string | null;
  cost_source: string;
  /**
   * The per-token counts and the rates this row was priced at, so the cost
   * cell can show its own working. Every one is NULL on an unpriced turn.
   */
  input_tokens: string | null;
  cache_read_tokens: string | null;
  cache_write_tokens: string | null;
  cache_write_5m_tokens: string | null;
  cache_write_1h_tokens: string | null;
  input_usd_per_mtok: string | null;
  output_usd_per_mtok: string | null;
  cache_read_usd_per_mtok: string | null;
  cache_write_5m_usd_per_mtok: string | null;
  cache_write_1h_usd_per_mtok: string | null;
  rate_source: string | null;
  effective_from: Date | null;
  effective_to: Date | null;
  rate_model: string | null;
  prompt_preview: string | null;
  /**
   * Which editor block the turn carried, stripped from the preview:
   * 'ide_selection', 'ide_opened_file', or null for neither.
   */
  ide_kind: string | null;
  tool_call_count: string;
  file_change_count: string;
}

export const PAGE_SIZE = 25;

/**
 * Build the WHERE clause shared by the list and its count.
 *
 * Parameterised throughout — none of these values is ever interpolated into
 * SQL, including the free-text search, which goes through
 * websearch_to_tsquery as a bound parameter.
 */
function buildWhere(filters: TurnFilters, params: unknown[]): string {
  const clauses: string[] = [];
  const add = (sql: string, value: unknown): void => {
    params.push(value);
    clauses.push(sql.replace('$?', `$${params.length}`));
  };

  if (filters.projectId) add('t.project_id = $?', filters.projectId);
  if (filters.sessionId) add('t.session_id = $?::bigint', filters.sessionId);
  if (filters.agentId) add('t.agent_id = $?', filters.agentId);
  if (filters.providerId) add('t.provider_id = $?', filters.providerId);
  if (filters.model) add('t.model_normalized = $?', filters.model);
  if (filters.branch) add('t.git_branch = $?', filters.branch);
  if (filters.status) add('t.status = $?::turn_status', filters.status);
  if (filters.from) add('t.started_at >= $?::timestamptz', filters.from);
  if (filters.to) add('t.started_at < ($?::timestamptz + interval \'1 day\')', filters.to);
  // websearch_to_tsquery accepts human syntax ("foo OR bar", quoted phrases,
  // -exclusions) and never throws on malformed input, unlike to_tsquery.
  if (filters.q) add('t.search_tsv @@ websearch_to_tsquery(\'english\', $?)', filters.q);

  return clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
}

/** 1-based, clamped. A junk `?page=` must land on page 1, never throw. */
export function readPage(value: string | undefined, pageCount: number): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) return 1;
  return Math.min(n, Math.max(1, pageCount));
}

/**
 * The turn list.
 *
 * NOTE what is absent: no join to file_change_diffs, and no select of any diff
 * body. That is the whole reason diffs live in their own table — a list page
 * must never drag multi-MB TOASTed values it does not render.
 *
 * prompt_text is truncated in SQL rather than in JS, so a 500 KB prompt is
 * never transferred just to show 200 characters of it.
 *
 * OFFSET, not keyset. Keyset is the cheaper shape, but it can only step to an
 * adjacent page, and the list needs to jump to an arbitrary numbered one. The
 * cost is bounded: the sort is over the filtered set, and at the current 466
 * turns the deepest page plans at 2.3 ms (EXPLAIN ANALYZE, 2026-09-22). Worth
 * revisiting if this archive reaches six figures.
 */
export async function listTurns(
  filters: TurnFilters,
  offset: number,
): Promise<TurnListRow[]> {
  const params: unknown[] = [];
  const where = buildWhere(filters, params);
  // Not user input: orderDir collapses everything to one of two literals.
  const dir = orderDir(filters.sort);

  params.push(PAGE_SIZE, offset);

  return query<TurnListRow>(
    `SELECT t.id, t.seq,
            p.name AS project_name, p.path AS project_path,
            a.key AS agent_key, s.external_session_id,
            pr.key AS provider_key, t.provider_source,
            t.model_raw, t.model_normalized, t.git_branch,
            t.started_at, t.ended_at, t.duration_ms, t.status,
            t.token_source, t.total_input_tokens, t.output_tokens,
            t.cost_usd, t.cost_source,
            -- The working behind the cost cell. Joining model_pricing on the
            -- turn's own pricing_id is a primary-key lookup into a 9-row
            -- table: the whole list query plans at 0.4 ms with it
            -- (EXPLAIN ANALYZE, 2026-09-23). Nothing here is TOASTed.
            t.input_tokens, t.cache_read_tokens, t.cache_write_tokens,
            t.cache_write_5m_tokens, t.cache_write_1h_tokens,
            mp.input_usd_per_mtok, mp.output_usd_per_mtok, mp.cache_read_usd_per_mtok,
            mp.cache_write_5m_usd_per_mtok, mp.cache_write_1h_usd_per_mtok,
            mp.source AS rate_source, mp.effective_from, mp.effective_to,
            mp.model_normalized AS rate_model,
            -- Truncating the raw text would show 240 characters of editor
            -- boilerplate and none of the prompt, so the block is stripped in
            -- SQL — it is never transferred. See IDE_BLOCK_RE.
            left(${STRIP_IDE_BLOCK('t.prompt_text')}, 240)   AS prompt_preview,
            -- Which block it was, not merely that there was one: a selection
            -- is something the user made, an open file is something the editor
            -- sent on its own. Same regex as the strip above, so the badge and
            -- the preview can never disagree.
            --
            -- Screenshots are NOT counted here. They live only in the raw
            -- event's payload, and counting them per row detoasts every prompt
            -- payload on the page: 276 ms for 25 rows against 2.3 ms as it
            -- stands (EXPLAIN ANALYZE, 2026-09-22). They are shown on the turn
            -- detail page, which fetches one turn deliberately.
            substring(t.prompt_text from '^<(ide_opened_file|ide_selection)>') AS ide_kind,
            (SELECT count(*) FROM tool_calls tc WHERE tc.turn_id = t.id)   AS tool_call_count,
            (SELECT count(*) FROM file_changes fc WHERE fc.turn_id = t.id) AS file_change_count
       FROM turns t
       JOIN projects p ON p.id = t.project_id
       JOIN agents a   ON a.id = t.agent_id
       JOIN sessions s ON s.id = t.session_id
       LEFT JOIN providers pr ON pr.id = t.provider_id
       LEFT JOIN model_pricing mp ON mp.id = t.pricing_id
       ${where}
      ORDER BY t.started_at ${dir}, t.id ${dir}
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
}

export async function countTurns(filters: TurnFilters): Promise<number> {
  const params: unknown[] = [];
  const where = buildWhere(filters, params);
  const row = await queryOne<{ n: string }>(
    `SELECT count(*) AS n FROM turns t ${where}`,
    params,
  );
  return Number(row?.n ?? 0);
}

// ---------------------------------------------------------------------------
// Filter option lists
// ---------------------------------------------------------------------------

export interface SessionOption extends Record<string, unknown> {
  id: string;
  external_session_id: string;
  started_at: Date;
  project_name: string;
  turns: string;
  /** Opening words of the session's first prompt, editor block stripped. */
  first_prompt: string | null;
}

/** Enough sessions to pick from; past this the dropdown is the wrong tool. */
export const SESSION_OPTION_LIMIT = 200;

export interface FilterOptions {
  projects: { id: string; name: string; path: string }[];
  agents: { id: string; key: string }[];
  providers: { id: string; key: string }[];
  models: { model_normalized: string }[];
  branches: { git_branch: string }[];
  /**
   * Sessions, newest first, narrowed to the chosen project. A session id is a
   * UUID and identifies nothing to a human, so each option carries the date,
   * the turn count and the opening words of its first prompt — that is what
   * someone actually remembers a session by.
   */
  sessions: SessionOption[];
  /** True when more sessions exist than the dropdown lists. */
  sessionsTruncated: boolean;
  /**
   * The active session filter, resolved for display.
   *
   * Still needed alongside `sessions`: the list narrows by project, so a
   * session filter set from a turn in another project would not appear in it,
   * and a filter the user cannot see is a filter they cannot undo.
   */
  activeSession: SessionOption | null;
}

/** The SELECT list `sessionOptions()` and `activeSession` must agree on. */
const SESSION_OPTION_COLUMNS = `
  s.id, s.external_session_id, s.started_at, p.name AS project_name,
  (SELECT count(*) FROM turns t WHERE t.session_id = s.id) AS turns,
  fp.first_prompt`;

const SESSION_OPTION_FROM = `
  FROM sessions s
  JOIN projects p ON p.id = s.project_id
  -- The first prompt is what a session is remembered by. LATERAL with
  -- ORDER BY seq LIMIT 1 is an index walk, not a scan of the session.
  LEFT JOIN LATERAL (
    SELECT left(${STRIP_IDE_BLOCK('t2.prompt_text')}, 70) AS first_prompt
      FROM turns t2 WHERE t2.session_id = s.id ORDER BY t2.seq LIMIT 1
  ) fp ON true`;

export async function getFilterOptions(
  projectId?: string,
  sessionId?: string,
): Promise<FilterOptions> {
  const [projects, agents, providers, models, branches, sessions, activeSession] = await Promise.all([
    query<{ id: string; name: string; path: string }>(
      `SELECT p.id, p.name, p.path FROM projects p
        WHERE EXISTS (SELECT 1 FROM turns t WHERE t.project_id = p.id)
        ORDER BY p.name`,
    ),
    query<{ id: string; key: string }>(
      `SELECT a.id, a.key FROM agents a
        WHERE EXISTS (SELECT 1 FROM turns t WHERE t.agent_id = a.id) ORDER BY a.key`,
    ),
    query<{ id: string; key: string }>(
      `SELECT pr.id, pr.key FROM providers pr
        WHERE EXISTS (SELECT 1 FROM turns t WHERE t.provider_id = pr.id) ORDER BY pr.key`,
    ),
    query<{ model_normalized: string }>(
      `SELECT DISTINCT model_normalized FROM turns
        WHERE model_normalized IS NOT NULL ORDER BY model_normalized`,
    ),
    // Branch names are only meaningful within a project ("main" spans repos),
    // so the list narrows once a project is chosen.
    query<{ git_branch: string }>(
      `SELECT DISTINCT git_branch FROM turns
        WHERE git_branch IS NOT NULL AND ($1::bigint IS NULL OR project_id = $1::bigint)
        ORDER BY git_branch`,
      [projectId ?? null],
    ),
    // Narrowed by project, like branches: a session belongs to exactly one,
    // and an unnarrowed list mixes unrelated work. Only sessions that actually
    // produced a turn are offered — an empty one filters to an empty page.
    // One more than the limit is fetched so the bar can say it is truncated
    // rather than silently showing a prefix.
    query<SessionOption>(
      `SELECT ${SESSION_OPTION_COLUMNS}
         ${SESSION_OPTION_FROM}
        WHERE ($1::bigint IS NULL OR s.project_id = $1::bigint)
          AND EXISTS (SELECT 1 FROM turns t WHERE t.session_id = s.id)
        ORDER BY s.started_at DESC
        LIMIT ${SESSION_OPTION_LIMIT + 1}`,
      [projectId ?? null],
    ),
    sessionId
      ? queryOne<SessionOption>(
          `SELECT ${SESSION_OPTION_COLUMNS} ${SESSION_OPTION_FROM} WHERE s.id = $1::bigint`,
          [sessionId],
        )
      : Promise.resolve(null),
  ]);

  return {
    projects,
    agents,
    providers,
    models,
    branches,
    sessions: sessions.slice(0, SESSION_OPTION_LIMIT),
    sessionsTruncated: sessions.length > SESSION_OPTION_LIMIT,
    activeSession,
  };
}

// ---------------------------------------------------------------------------
// Turn detail
// ---------------------------------------------------------------------------

export interface TurnDetail extends Record<string, unknown> {
  id: string;
  seq: number;
  session_id: string;
  project_name: string;
  project_path: string;
  agent_key: string;
  agent_version: string | null;
  provider_key: string | null;
  provider_source: string;
  model_raw: string | null;
  model_normalized: string | null;
  git_branch: string | null;
  git_head_sha: string | null;
  git_dirty: boolean | null;
  started_at: Date;
  ended_at: Date | null;
  duration_ms: string | null;
  status: string;
  source: string;
  token_source: string;
  input_tokens: string | null;
  output_tokens: string | null;
  cache_read_tokens: string | null;
  cache_write_tokens: string | null;
  cache_write_5m_tokens: string | null;
  cache_write_1h_tokens: string | null;
  total_input_tokens: string;
  cost_usd: string | null;
  cost_source: string;
  prompt_text: string | null;
  response_text: string | null;
  redaction_version: number;
  external_session_id: string;
  /** The agent's own id for this turn — the handle that survives a re-import. */
  external_turn_id: string | null;
}

export function getTurn(id: string): Promise<TurnDetail | null> {
  return queryOne<TurnDetail>(
    `SELECT t.*, p.name AS project_name, p.path AS project_path,
            a.key AS agent_key, s.agent_version, s.external_session_id,
            pr.key AS provider_key
       FROM turns t
       JOIN projects p ON p.id = t.project_id
       JOIN sessions s ON s.id = t.session_id
       JOIN agents a   ON a.id = t.agent_id
       LEFT JOIN providers pr ON pr.id = t.provider_id
      WHERE t.id = $1::bigint`,
    [id],
  );
}

export interface PromptMediaRow extends Record<string, unknown> {
  /** 0-based position in the prompt record's content array — the route's handle. */
  idx: number;
  block_type: 'image' | 'document';
  media_type: string | null;
  source_type: string | null;
  /** Decoded size, as an int4 (so `number`). NULL when nothing inline — not 0. */
  byte_size: number | null;
}

/**
 * The binary blocks the user attached to a prompt — screenshots and documents.
 *
 * These are the one thing a turn carries that `prompt_text` does not: they are
 * content blocks on the prompt record, so the only copy is the raw event. The
 * join is on `sessions.external_session_id || ':' || turns.external_turn_id`,
 * which is exactly how the collector builds `raw_events.external_id` for a log
 * record (adapters/claude-code.ts → recordExternalId). Verified on 2026-09-22:
 * it matches all 15 image-carrying turns and the one document-carrying turn in
 * this archive, with no misses.
 *
 * Metadata only — the base64 itself is never selected here. A single prompt in
 * this archive carries a 4.9 MB PDF, and the detail page renders a card for it,
 * not its bytes. Those come one at a time from `getPromptMediaBlock()`.
 *
 * This is deliberately NOT done on the list page. Counting these per row costs
 * a full detoast of every prompt payload: measured 276 ms for 25 rows against
 * 2.3 ms for the list as it stands (EXPLAIN ANALYZE, 2026-09-22). That is the
 * same rule that keeps diff bodies out of list queries.
 */
export function getPromptMedia(turnId: string): Promise<PromptMediaRow[]> {
  return query<PromptMediaRow>(
    `SELECT (b.idx - 1)::int                       AS idx,
            b.block->>'type'                       AS block_type,
            b.block->'source'->>'media_type'       AS media_type,
            b.block->'source'->>'type'             AS source_type,
            -- Exact decoded length from the base64 length, without decoding
            -- megabytes to print a size. Verified against
            -- octet_length(decode(...)) on every block in this archive.
            CASE WHEN b.block->'source'->>'data' IS NULL THEN NULL
                 ELSE length(b.block->'source'->>'data') / 4 * 3
                      - (length(b.block->'source'->>'data')
                         - length(rtrim(b.block->'source'->>'data', '=')))
            END                                    AS byte_size
       FROM turns t
       JOIN sessions s ON s.id = t.session_id
       JOIN raw_events re
         ON re.agent_id = t.agent_id
        AND re.layer = 'logs'
        AND re.session_external_id = s.external_session_id
        AND re.external_id = s.external_session_id || ':' || t.external_turn_id
       CROSS JOIN LATERAL jsonb_array_elements(
            -- The guard is inside the argument, not in WHERE: a LATERAL
            -- function is not ordered after the filter, and
            -- jsonb_array_elements raises on a non-array.
            CASE WHEN jsonb_typeof(re.payload->'message'->'content') = 'array'
                 THEN re.payload->'message'->'content' ELSE '[]'::jsonb END
       ) WITH ORDINALITY AS b(block, idx)
      WHERE t.id = $1::bigint
        AND t.external_turn_id IS NOT NULL
        AND b.block->>'type' IN ('image', 'document')
      ORDER BY b.idx`,
    [turnId],
  );
}

export interface PromptMediaBlock extends Record<string, unknown> {
  block_type: string;
  media_type: string | null;
  source_type: string | null;
  /** Base64, as the agent recorded it. NULL for a block with no inline data. */
  data: string | null;
}

/**
 * One attached block's bytes, for the preview route.
 *
 * Fetched by index so the page can render a thumbnail per attachment without
 * any of them travelling with the page itself.
 */
export function getPromptMediaBlock(turnId: string, idx: number): Promise<PromptMediaBlock | null> {
  return queryOne<PromptMediaBlock>(
    `SELECT b.block->>'type'                 AS block_type,
            b.block->'source'->>'media_type' AS media_type,
            b.block->'source'->>'type'       AS source_type,
            b.block->'source'->>'data'       AS data
       FROM turns t
       JOIN sessions s ON s.id = t.session_id
       JOIN raw_events re
         ON re.agent_id = t.agent_id
        AND re.layer = 'logs'
        AND re.session_external_id = s.external_session_id
        AND re.external_id = s.external_session_id || ':' || t.external_turn_id
       CROSS JOIN LATERAL jsonb_array_elements(
            CASE WHEN jsonb_typeof(re.payload->'message'->'content') = 'array'
                 THEN re.payload->'message'->'content' ELSE '[]'::jsonb END
       ) WITH ORDINALITY AS b(block, idx)
      WHERE t.id = $1::bigint
        AND t.external_turn_id IS NOT NULL
        AND b.idx - 1 = $2::int
        AND b.block->>'type' IN ('image', 'document')`,
    [turnId, idx],
  );
}

export interface CostInputsRow extends Record<string, unknown> {
  input_tokens: string | null;
  output_tokens: string | null;
  cache_read_tokens: string | null;
  cache_write_tokens: string | null;
  cache_write_5m_tokens: string | null;
  cache_write_1h_tokens: string | null;
  input_usd_per_mtok: string | null;
  output_usd_per_mtok: string | null;
  cache_read_usd_per_mtok: string | null;
  cache_write_5m_usd_per_mtok: string | null;
  cache_write_1h_usd_per_mtok: string | null;
  effective_from: Date;
  effective_to: Date | null;
  rate_source: string;
  rate_model: string;
  rate_provider: string;
}

/**
 * The inputs to a turn's cost: its token counts and the rates it was priced at.
 *
 * The arithmetic itself is NOT done here. It lives in lib/cost.ts, in JS
 * floats, because that is what the collector ran — `cost_usd` is
 * `total.toFixed(8)` of a float sum, so reproducing it in SQL numeric would
 * disagree in the last places and make the displayed working look wrong when
 * it was right.
 *
 * The rate comes from the SAME `model_pricing` row the turn was priced against
 * (`turns.pricing_id`), never from today's rate. A price change inserts a new
 * pricing row; it does not rewrite what past turns cost, and a breakdown
 * computed at today's rate would silently undo that.
 *
 * Returns null for an unpriced turn — the join to `model_pricing` finds
 * nothing. There is no working to show for a sum that was never computed, and
 * a table of zeroes would read as "this turn cost nothing".
 */
export function getCostInputs(turnId: string): Promise<CostInputsRow | null> {
  return queryOne<CostInputsRow>(
    `SELECT t.input_tokens, t.output_tokens, t.cache_read_tokens, t.cache_write_tokens,
            t.cache_write_5m_tokens, t.cache_write_1h_tokens,
            mp.input_usd_per_mtok, mp.output_usd_per_mtok, mp.cache_read_usd_per_mtok,
            mp.cache_write_5m_usd_per_mtok, mp.cache_write_1h_usd_per_mtok,
            mp.effective_from, mp.effective_to,
            mp.source           AS rate_source,
            mp.model_normalized AS rate_model,
            prp.key             AS rate_provider
       FROM turns t
       JOIN model_pricing mp ON mp.id = t.pricing_id
       JOIN providers prp     ON prp.id = mp.provider_id
      WHERE t.id = $1::bigint`,
    [turnId],
  );
}

export interface SessionSummary extends Record<string, unknown> {
  turn_count: string;
  max_seq: number;
  /** NULL when every turn in the session is unpriced — not zero. */
  session_cost_usd: string | null;
  unpriced_turns: string;
}

/**
 * Session-level context for one turn's detail page.
 *
 * Exists so the cost card can say "32% of this session" — a turn's absolute
 * cost means little without the session it sits in. The share is only shown
 * when no turn in the session is unpriced, because a denominator that silently
 * omits turns inflates every share computed from it.
 */
export function getSessionSummary(sessionId: string): Promise<SessionSummary | null> {
  return queryOne<SessionSummary>(
    `SELECT count(*)                                           AS turn_count,
            max(seq)                                           AS max_seq,
            sum(cost_usd)                                      AS session_cost_usd,
            count(*) FILTER (WHERE cost_source = 'unpriced')    AS unpriced_turns
       FROM turns WHERE session_id = $1::bigint`,
    [sessionId],
  );
}

export interface NeighbourTurn extends Record<string, unknown> {
  id: string;
  seq: number;
  cost_usd: string | null;
  cost_source: string;
  duration_ms: string | null;
}

/**
 * The turns either side of this one *within its session*, which is the
 * sequence a reader is actually following — not the global time order, where
 * the neighbour is usually an unrelated project.
 */
export async function getTurnNeighbours(
  sessionId: string,
  seq: number,
): Promise<{ prev: NeighbourTurn | null; next: NeighbourTurn | null }> {
  const [prev, next] = await Promise.all([
    queryOne<NeighbourTurn>(
      `SELECT id, seq, cost_usd, cost_source, duration_ms FROM turns
        WHERE session_id = $1::bigint AND seq < $2 ORDER BY seq DESC LIMIT 1`,
      [sessionId, seq],
    ),
    queryOne<NeighbourTurn>(
      `SELECT id, seq, cost_usd, cost_source, duration_ms FROM turns
        WHERE session_id = $1::bigint AND seq > $2 ORDER BY seq ASC LIMIT 1`,
      [sessionId, seq],
    ),
  ]);
  return { prev, next };
}

/**
 * This turn's 1-based position in the filtered, newest-first list.
 *
 * Counts the rows that sort ahead of it under the same ORDER BY the list uses,
 * so "4 of 464" on the detail page means the same thing as row 4 on the list.
 * Returns null when the turn is not in the filter at all — arriving from a
 * stale link, say — rather than claiming a position it does not hold.
 */
export async function getTurnRank(
  filters: TurnFilters,
  turn: { id: string; started_at: Date },
): Promise<number | null> {
  const params: unknown[] = [];
  const where = buildWhere(filters, params);
  params.push(turn.started_at, turn.id);
  const pair = `($${params.length - 1}::timestamptz, $${params.length}::bigint)`;
  const self = `(t.started_at, t.id) = ${pair}`;
  // "Ahead" follows the list's own direction: newest-first puts later turns first.
  const ahead = `(t.started_at, t.id) ${orderDir(filters.sort) === 'DESC' ? '>' : '<'} ${pair}`;

  const row = await queryOne<{ ahead: string; present: string }>(
    `SELECT count(*) FILTER (WHERE ${ahead}) AS ahead,
            count(*) FILTER (WHERE ${self})  AS present
       FROM turns t ${where}`,
    params,
  );
  if (!row || Number(row.present) === 0) return null;
  return Number(row.ahead) + 1;
}

export interface ToolCallRow extends Record<string, unknown> {
  id: string;
  seq: number;
  tool_name: string;
  command: string | null;
  cwd: string | null;
  exit_code: number | null;
  stdout_excerpt: string | null;
  stdout_bytes_total: string | null;
  stdout_truncated: boolean;
  duration_ms: string | null;
  duration_source: string;
  started_at: Date | null;
  interrupted: boolean;
  is_background: boolean;
}

export function getToolCalls(turnId: string): Promise<ToolCallRow[]> {
  return query<ToolCallRow>(
    `SELECT id, seq, tool_name, command, cwd, exit_code, stdout_excerpt,
            stdout_bytes_total, stdout_truncated, duration_ms, duration_source,
            started_at, interrupted, is_background
       FROM tool_calls WHERE turn_id = $1::bigint ORDER BY seq`,
    [turnId],
  );
}

export interface FileChangeRow extends Record<string, unknown> {
  id: string;
  seq: number;
  path: string;
  old_path: string | null;
  change_type: string;
  lines_added: number | null;
  lines_removed: number | null;
  is_binary: boolean;
  is_truncated: boolean;
  attribution: string;
  unified_diff: string | null;
  byte_size: string | null;
}

/**
 * Turn detail is the ONLY place diff bodies are fetched, and only for one
 * turn's worth.
 */
export function getFileChanges(turnId: string): Promise<FileChangeRow[]> {
  return query<FileChangeRow>(
    `SELECT fc.id, fc.seq, fc.path, fc.old_path, fc.change_type,
            fc.lines_added, fc.lines_removed, fc.is_binary, fc.is_truncated,
            fc.attribution, d.unified_diff, d.byte_size
       FROM file_changes fc
       LEFT JOIN file_change_diffs d ON d.file_change_id = fc.id
      WHERE fc.turn_id = $1::bigint
      ORDER BY fc.seq`,
    [turnId],
  );
}

// ---------------------------------------------------------------------------
// Aggregates
// ---------------------------------------------------------------------------

export interface AggregateRow extends Record<string, unknown> {
  label: string;
  turns: string;
  input_tokens: string;
  output_tokens: string;
  cost_usd: string | null;
  unpriced_turns: string;
}

/**
 * Aggregates by an arbitrary dimension.
 *
 * `dimension` is NOT user input — it is matched against a fixed allowlist, so
 * the interpolation below cannot become an injection point.
 *
 * unpriced_turns is surfaced alongside every total because a cost figure that
 * silently omits unpriced turns understates spend, and the dashboard must show
 * that rather than imply completeness.
 */
const DIMENSIONS: Record<string, string> = {
  day: "to_char(date_trunc('day', t.started_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD')",
  project: 'p.name',
  agent: 'a.key',
  provider: "coalesce(pr.key, 'unknown')",
  model: "coalesce(t.model_normalized, 'unknown')",
  branch: "coalesce(t.git_branch, '(detached or none)')",
};

export async function aggregateBy(
  dimension: keyof typeof DIMENSIONS,
  filters: TurnFilters,
): Promise<AggregateRow[]> {
  const expr = DIMENSIONS[dimension];
  if (!expr) throw new Error(`unknown aggregate dimension: ${String(dimension)}`);
  const params: unknown[] = [];
  const where = buildWhere(filters, params);

  return query<AggregateRow>(
    `SELECT ${expr} AS label,
            count(*)                        AS turns,
            sum(t.total_input_tokens)       AS input_tokens,
            sum(coalesce(t.output_tokens,0)) AS output_tokens,
            sum(t.cost_usd)                 AS cost_usd,
            count(*) FILTER (WHERE t.cost_source = 'unpriced') AS unpriced_turns
       FROM turns t
       JOIN projects p ON p.id = t.project_id
       JOIN agents a   ON a.id = t.agent_id
       LEFT JOIN providers pr ON pr.id = t.provider_id
       ${where}
      GROUP BY 1
      ORDER BY ${dimension === 'day' ? '1 DESC' : 'sum(t.cost_usd) DESC NULLS LAST'}
      LIMIT 200`,
    params,
  );
}

export interface ProviderModelRow extends Record<string, unknown> {
  provider_key: string;
  model_normalized: string;
  provider_source: string;
  turns: string;
  input_tokens: string;
  output_tokens: string;
  cost_usd: string | null;
  unpriced_turns: string;
}

export async function providerModelBreakdown(filters: TurnFilters): Promise<ProviderModelRow[]> {
  const params: unknown[] = [];
  const where = buildWhere(filters, params);
  return query<ProviderModelRow>(
    `SELECT coalesce(pr.key, 'unknown')           AS provider_key,
            coalesce(t.model_normalized, 'unknown') AS model_normalized,
            t.provider_source,
            count(*)                              AS turns,
            sum(t.total_input_tokens)             AS input_tokens,
            sum(coalesce(t.output_tokens,0))      AS output_tokens,
            sum(t.cost_usd)                       AS cost_usd,
            count(*) FILTER (WHERE t.cost_source = 'unpriced') AS unpriced_turns
       FROM turns t
       LEFT JOIN providers pr ON pr.id = t.provider_id
       ${where}
      GROUP BY 1,2,3
      ORDER BY sum(t.cost_usd) DESC NULLS LAST`,
    params,
  );
}

// ---------------------------------------------------------------------------
// Compaction material
// ---------------------------------------------------------------------------

/**
 * The most turns one compaction may fold.
 *
 * Not a performance limit — it is the point past which the assembled block is
 * larger than any context it would be pasted into, so the request is refused
 * rather than silently clipped to something misleading.
 */
export const COMPACT_TURN_LIMIT = 40;

export interface CompactTurnRow extends Record<string, unknown> {
  id: string;
  seq: number;
  started_at: Date;
  status: string;
  project_name: string;
  agent_key: string;
  git_branch: string | null;
  model_raw: string | null;
  external_session_id: string;
  prompt_text: string | null;
  response_text: string | null;
  token_source: string;
  total_input_tokens: string;
  output_tokens: string | null;
  cost_usd: string | null;
  cost_source: string;
  duration_ms: string | null;
}

/**
 * Whole turns, for the compact panel.
 *
 * Unlike the list this DOES select `prompt_text` and `response_text` in full —
 * folding a run of turns into a context block is precisely a request for their
 * content, so truncating in SQL would defeat it. The bound is the id list:
 * COMPACT_TURN_LIMIT turns the user picked by hand, not a page of a filter.
 *
 * `= ANY($1::bigint[])` rather than an IN list built by hand: one bound
 * parameter, so a hostile id can no more reach the planner than a filter value
 * can. The caller has already checked each id is digits.
 */
export function getCompactTurns(ids: string[]): Promise<CompactTurnRow[]> {
  return query<CompactTurnRow>(
    `SELECT t.id, t.seq, t.started_at, t.status,
            p.name AS project_name, a.key AS agent_key,
            t.git_branch, t.model_raw, s.external_session_id,
            t.prompt_text, t.response_text,
            t.token_source, t.total_input_tokens, t.output_tokens,
            t.cost_usd, t.cost_source, t.duration_ms
       FROM turns t
       JOIN projects p ON p.id = t.project_id
       JOIN agents a   ON a.id = t.agent_id
       JOIN sessions s ON s.id = t.session_id
      WHERE t.id = ANY($1::bigint[])`,
    [ids],
  );
}

export interface CompactCommandRow extends Record<string, unknown> {
  turn_id: string;
  seq: number;
  tool_name: string;
  command: string | null;
  exit_code: number | null;
  duration_ms: string | null;
  interrupted: boolean;
}

export function getCompactCommands(ids: string[]): Promise<CompactCommandRow[]> {
  return query<CompactCommandRow>(
    `SELECT turn_id, seq, tool_name, command, exit_code, duration_ms, interrupted
       FROM tool_calls
      WHERE turn_id = ANY($1::bigint[])
      ORDER BY turn_id, seq`,
    [ids],
  );
}

export interface CompactFileRow extends Record<string, unknown> {
  turn_id: string;
  seq: number;
  path: string;
  change_type: string;
  lines_added: number | null;
  lines_removed: number | null;
  is_binary: boolean;
  unified_diff: string | null;
}

/**
 * File changes for the compact panel, with diff bodies only if asked.
 *
 * The join to `file_change_diffs` is behind `withDiffs` for the reason that
 * table exists at all: a diff body is a multi-MB TOASTed value, and dragging
 * forty turns' worth of them to render a path list would be the exact mistake
 * the split was made to prevent. The panel's "Diffs" toggle is what turns it
 * on, and it is off by default.
 */
export function getCompactFiles(ids: string[], withDiffs: boolean): Promise<CompactFileRow[]> {
  const diffSelect = withDiffs ? 'd.unified_diff' : 'NULL::text AS unified_diff';
  const diffJoin = withDiffs ? 'LEFT JOIN file_change_diffs d ON d.file_change_id = fc.id' : '';
  return query<CompactFileRow>(
    `SELECT fc.turn_id, fc.seq, fc.path, fc.change_type,
            fc.lines_added, fc.lines_removed, fc.is_binary, ${diffSelect}
       FROM file_changes fc
       ${diffJoin}
      WHERE fc.turn_id = ANY($1::bigint[])
      ORDER BY fc.turn_id, fc.seq`,
    [ids],
  );
}

/**
 * Data-quality banner for the dashboard.
 *
 * Surfaces the things the pipeline genuinely does not know, rather than
 * letting the UI imply completeness it does not have.
 */
export interface HealthRow extends Record<string, unknown> {
  total_turns: string;
  unpriced_turns: string;
  unknown_token_turns: string;
  inferred_provider_turns: string;
  partial_turns: string;
  uncertain_file_changes: string;
  tool_calls_total: string;
  tool_calls_with_exit_code: string;
  failed_no_project: string;
}

export function getHealth(): Promise<HealthRow | null> {
  return queryOne<HealthRow>(
    `SELECT (SELECT count(*) FROM turns)                                            AS total_turns,
            (SELECT count(*) FROM turns WHERE cost_source = 'unpriced')             AS unpriced_turns,
            (SELECT count(*) FROM turns WHERE token_source = 'unknown')             AS unknown_token_turns,
            (SELECT count(*) FROM turns WHERE provider_source IN ('model_map','unknown')) AS inferred_provider_turns,
            (SELECT count(*) FROM turns WHERE status = 'partial')                   AS partial_turns,
            (SELECT count(*) FROM file_changes WHERE attribution = 'uncertain')     AS uncertain_file_changes,
            (SELECT count(*) FROM tool_calls)                                       AS tool_calls_total,
            (SELECT count(*) FROM tool_calls WHERE exit_code IS NOT NULL)           AS tool_calls_with_exit_code,
            (SELECT count(*) FROM raw_events WHERE project_path IS NULL AND layer = 'logs') AS failed_no_project`,
  );
}
