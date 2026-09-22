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
  prompt_preview: string | null;
  /** The turn also carried an editor-focus block, stripped from the preview. */
  had_ide_context: boolean;
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
            -- Claude Code prefixes a turn with an editor block when the file
            -- in focus or the selection changed. Verified on 2026-09-22: those
            -- are the only two leading tags in this archive (154 + 53 of 466),
            -- each is closed, and every one carries the real request after it —
            -- so truncating the raw text would show 240 characters of
            -- boilerplate and none of the prompt. Stripped in SQL so the block
            -- is never transferred. ltrim is a separate call because Postgres
            -- takes greediness from the FIRST quantifier, and the non-greedy
            -- .*? would make a trailing [[:space:]]* match nothing.
            left(ltrim(regexp_replace(t.prompt_text,
                   '^<(ide_opened_file|ide_selection)>.*?</\\1>', ''), E' \\t\\r\\n'), 240)
                                                            AS prompt_preview,
            t.prompt_text ~ '^<(ide_opened_file|ide_selection)>' AS had_ide_context,
            (SELECT count(*) FROM tool_calls tc WHERE tc.turn_id = t.id)   AS tool_call_count,
            (SELECT count(*) FROM file_changes fc WHERE fc.turn_id = t.id) AS file_change_count
       FROM turns t
       JOIN projects p ON p.id = t.project_id
       JOIN agents a   ON a.id = t.agent_id
       JOIN sessions s ON s.id = t.session_id
       LEFT JOIN providers pr ON pr.id = t.provider_id
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

export interface FilterOptions {
  projects: { id: string; name: string; path: string }[];
  agents: { id: string; key: string }[];
  providers: { id: string; key: string }[];
  models: { model_normalized: string }[];
  branches: { git_branch: string }[];
  /**
   * Only populated when a session filter is active. Sessions are not offered
   * as a dropdown — there are thousands and none is memorable — but a filter
   * the user cannot see is a filter they cannot undo, so the active one is
   * resolved to its agent-side id for display.
   */
  activeSession: { id: string; external_session_id: string } | null;
}

export async function getFilterOptions(
  projectId?: string,
  sessionId?: string,
): Promise<FilterOptions> {
  const [projects, agents, providers, models, branches, activeSession] = await Promise.all([
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
    sessionId
      ? queryOne<{ id: string; external_session_id: string }>(
          `SELECT id, external_session_id FROM sessions WHERE id = $1::bigint`,
          [sessionId],
        )
      : Promise.resolve(null),
  ]);
  return { projects, agents, providers, models, branches, activeSession };
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

export interface CostBreakdownRow extends Record<string, unknown> {
  input_usd: string;
  cache_read_usd: string;
  cache_write_usd: string;
  output_usd: string;
}

/**
 * What the turn's cost is made of.
 *
 * Recomputed from the SAME `model_pricing` row the turn was priced against
 * (`turns.pricing_id`), not from today's rate — a price change inserts a new
 * row, it does not rewrite what past turns cost, and this must not undo that.
 * Verified on 2026-09-22 that the four components sum exactly to `cost_usd`.
 *
 * Returns null for an unpriced turn. There is no breakdown of a cost that was
 * never computed, and a row of zeroes would read as "cost nothing".
 */
export function getCostBreakdown(turnId: string): Promise<CostBreakdownRow | null> {
  return queryOne<CostBreakdownRow>(
    `SELECT coalesce(t.input_tokens,0)/1e6 * mp.input_usd_per_mtok AS input_usd,
            coalesce(t.cache_read_tokens,0)/1e6
              * coalesce(mp.cache_read_usd_per_mtok, mp.input_usd_per_mtok)      AS cache_read_usd,
            coalesce(t.cache_write_5m_tokens,0)/1e6
              * coalesce(mp.cache_write_5m_usd_per_mtok, mp.input_usd_per_mtok)
            + coalesce(t.cache_write_1h_tokens,0)/1e6
              * coalesce(mp.cache_write_1h_usd_per_mtok, mp.input_usd_per_mtok)  AS cache_write_usd,
            coalesce(t.output_tokens,0)/1e6 * mp.output_usd_per_mtok             AS output_usd
       FROM turns t
       JOIN model_pricing mp ON mp.id = t.pricing_id
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
