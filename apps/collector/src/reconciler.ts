/**
 * Cross-layer reconciliation.
 *
 * Two jobs, both about layers disagreeing or one layer knowing something the
 * others cannot:
 *
 *  1. Close turns left 'partial' by a stream that never terminated.
 *
 *  2. Correlate Layer 3 proxy observations to turns, then apply the precedence
 *     rule (hooks > logs > proxy) FIELD BY FIELD rather than wholesale:
 *
 *       - provider: the proxy WINS unconditionally. It observed the host
 *         actually connected to; logs can only infer from a model id, and that
 *         inference cannot tell direct traffic from a gateway. This is the one
 *         place a lower-precedence layer overrides a higher one, because it is
 *         not a disagreement about the same fact — the log never had this fact.
 *
 *       - tokens: the proxy FILLS ONLY GAPS. When the log already reported
 *         provider counts they win, per precedence. When it reported none
 *         (token_source='unknown'), the proxy's numbers are the only ones there
 *         are — which is the entire reason Layer 3 exists for agents whose logs
 *         omit usage.
 *
 * Wholesale "last layer wins" would silently replace provider-reported token
 * counts with proxy-observed ones and make the two indistinguishable.
 */
import type pg from 'pg';
import type { Db } from './db.js';

/**
 * How long after a turn's last recorded activity a proxy call may still be
 * considered part of it. Turn end times come from the transcript's final
 * record, which can lag the actual HTTP call.
 */
const MATCH_GRACE = "interval '2 minutes'";

/**
 * Do not declare "no candidate" too early — the proxy records an observation
 * as soon as the response completes, but the tailer may not have flushed the
 * corresponding turn yet.
 */
const GIVE_UP_AFTER = "interval '30 minutes'";

export interface ReconcileStats {
  matched: number;
  ambiguous: number;
  abandoned: number;
  providersUpgraded: number;
  tokensFilled: number;
  partialsClosed: number;
}

export class Reconciler {
  constructor(private readonly db: Db) {}

  async run(stalePartialMs: number): Promise<ReconcileStats> {
    const stats: ReconcileStats = {
      matched: 0, ambiguous: 0, abandoned: 0,
      providersUpgraded: 0, tokensFilled: 0, partialsClosed: 0,
    };

    stats.partialsClosed = await this.db.reconcileStalePartials(stalePartialMs);

    await this.db.withTransaction(async (client) => {
      await this.matchProxyRequests(client, stats);
      await this.applyProviderAttribution(client, stats);
      await this.fillMissingTokens(client, stats);
    });

    return stats;
  }

  /**
   * Correlate on (model, time window).
   *
   * Nothing in an Anthropic or OpenAI request carries a session id, so this is
   * necessarily a heuristic — which is why the method is recorded per row.
   * A window containing two turns on the same model is marked 'ambiguous' and
   * left unmatched: a wrong attribution is worse than none, and it would be
   * indistinguishable from a right one afterwards.
   */
  private async matchProxyRequests(client: pg.PoolClient, stats: ReconcileStats): Promise<void> {
    const { rows } = await client.query<{ matched: string; ambiguous: string }>(
      `WITH candidate AS (
         SELECT pr.id AS proxy_id,
                t.id  AS turn_id,
                count(*) OVER (PARTITION BY pr.id) AS n
         FROM proxy_requests pr
         JOIN turns t
           ON t.model_normalized = pr.model_normalized
          AND pr.started_at >= t.started_at
          AND pr.started_at <= COALESCE(t.ended_at, t.started_at) + ${MATCH_GRACE}
         WHERE pr.match_method = 'pending'
       ),
       unique_match AS (
         UPDATE proxy_requests pr
            SET matched_turn_id = c.turn_id, match_method = 'model_time_window'
           FROM candidate c
          WHERE pr.id = c.proxy_id AND c.n = 1
          RETURNING pr.id
       ),
       ambiguous AS (
         UPDATE proxy_requests pr
            SET match_method = 'ambiguous'
           FROM (SELECT DISTINCT proxy_id FROM candidate WHERE n > 1) a
          WHERE pr.id = a.proxy_id
          RETURNING pr.id
       )
       SELECT (SELECT count(*) FROM unique_match) AS matched,
              (SELECT count(*) FROM ambiguous)    AS ambiguous`,
    );
    stats.matched = Number(rows[0]?.matched ?? 0);
    stats.ambiguous = Number(rows[0]?.ambiguous ?? 0);

    // Give up on observations old enough that their turn should have appeared
    // by now, so the unmatched index stays small and the distinction between
    // "not processed" and "no match exists" survives.
    const { rowCount } = await client.query(
      `UPDATE proxy_requests
          SET match_method = 'no_candidate'
        WHERE match_method = 'pending'
          AND started_at < now() - ${GIVE_UP_AFTER}`,
    );
    stats.abandoned = rowCount ?? 0;
  }

  /**
   * The proxy's provider wins. Restricted to turns whose provider was inferred
   * (model_map) or unknown — a turn already attributed by the proxy, or by a
   * higher-precedence config resolution, is left alone.
   */
  private async applyProviderAttribution(client: pg.PoolClient, stats: ReconcileStats): Promise<void> {
    const { rowCount } = await client.query(
      `UPDATE turns t
          SET provider_id = pr.provider_id,
              provider_source = 'proxy',
              updated_at = now()
         FROM proxy_requests pr
        WHERE pr.matched_turn_id = t.id
          AND pr.provider_id IS NOT NULL
          AND t.provider_source IN ('model_map', 'unknown')`,
    );
    stats.providersUpgraded = rowCount ?? 0;
  }

  /**
   * Fill token counts ONLY where the log reported none.
   *
   * Several proxy calls can map to one turn (an agentic turn makes many
   * requests), so they are summed. token_source becomes 'proxy' so these are
   * never silently mixed with provider-reported counts in an aggregate.
   *
   * Cost is deliberately NOT recomputed here: it is computed once at ingest
   * and stored, and back-filling tokens for a turn that had none means it was
   * 'unpriced' anyway. Pricing it now would use today's rates for an old turn,
   * which is exactly what "never recomputed retroactively" forbids.
   */
  private async fillMissingTokens(client: pg.PoolClient, stats: ReconcileStats): Promise<void> {
    const { rowCount } = await client.query(
      `WITH summed AS (
         SELECT matched_turn_id AS turn_id,
                sum(input_tokens)          AS input_tokens,
                sum(output_tokens)         AS output_tokens,
                sum(cache_read_tokens)     AS cache_read_tokens,
                sum(cache_write_tokens)    AS cache_write_tokens,
                sum(cache_write_5m_tokens) AS cache_write_5m_tokens,
                sum(cache_write_1h_tokens) AS cache_write_1h_tokens
           FROM proxy_requests
          WHERE matched_turn_id IS NOT NULL
            AND token_source = 'proxy'
          GROUP BY matched_turn_id
       )
       UPDATE turns t
          SET input_tokens          = s.input_tokens,
              output_tokens         = s.output_tokens,
              cache_read_tokens     = s.cache_read_tokens,
              cache_write_tokens    = s.cache_write_tokens,
              cache_write_5m_tokens = s.cache_write_5m_tokens,
              cache_write_1h_tokens = s.cache_write_1h_tokens,
              token_source          = 'proxy',
              updated_at            = now()
         FROM summed s
        WHERE t.id = s.turn_id
          AND t.token_source = 'unknown'`,
    );
    stats.tokensFilled = rowCount ?? 0;
  }
}
