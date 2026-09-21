/**
 * Proxy persistence. Writes a proxy_requests row plus a raw_events row per
 * observation, both idempotent on a content-derived external id.
 */
import pg from 'pg';
import { Redactor } from '@aiuo/schema/redaction';
import type { ExtractedUsage } from './usage.js';

const { Pool } = pg;

export interface RecordInput {
  externalId: string;
  upstreamHost: string;
  upstreamUrl: string;
  method: string;
  path: string;
  providerKey: string;
  modelRaw: string | null;
  isStreaming: boolean;
  statusCode: number | null;
  errorMessage: string | null;
  usage: ExtractedUsage;
  isLocal: boolean;
  providerRequestId: string | null;
  startedAt: Date;
  endedAt: Date;
  redactionVersion: number;
  rawPayload: unknown;
}

export class ProxyDb {
  private readonly pool: pg.Pool;
  private readonly providerIds = new Map<string, number>();

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 4 });
  }

  async connectWithRetry(maxAttempts = 10): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const client = await this.pool.connect();
        await client.query("SET TIME ZONE 'UTC'");
        client.release();
        return;
      } catch (error) {
        lastError = error;
        const delay = Math.min(1000 * 2 ** (attempt - 1), 10_000);
        process.stderr.write(`postgres not ready (${attempt}/${maxAttempts}), retrying in ${delay}ms\n`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    throw new Error(`Could not reach postgres: ${String(lastError)}`);
  }

  async end(): Promise<void> {
    await this.pool.end();
  }

  /**
   * DO NOTHING, never DO UPDATE — see the collector's copy for the reasoning.
   * Overwriting an existing version's hash rewrites history for every row
   * already stamped with it, so a mismatch is a startup error instead.
   */
  async registerRedactionVersion(version: number, hash: string, count: number): Promise<void> {
    await this.pool.query(
      `INSERT INTO redaction_versions (version, pattern_hash, pattern_count, description)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (version) DO NOTHING`,
      [version, hash, count, `proxy pattern set ${hash}`],
    );
    const { rows } = await this.pool.query<{ pattern_hash: string }>(
      `SELECT pattern_hash FROM redaction_versions WHERE version = $1`,
      [version],
    );
    const stored = rows[0]?.pattern_hash;
    if (stored !== undefined && stored !== hash) {
      throw new Error(
        `Redaction version ${version} is already recorded with pattern hash ${stored}, ` +
          `but the live pattern set hashes to ${hash}. The patterns changed without a ` +
          `version bump — rows written under both would be indistinguishable. ` +
          `Increment Redactor.version in packages/schema/src/redaction.ts.`,
      );
    }
  }

  private async providerId(key: string): Promise<number> {
    const cached = this.providerIds.get(key);
    if (cached !== undefined) return cached;
    const { rows } = await this.pool.query<{ id: number }>(
      `INSERT INTO providers (key, display_name) VALUES ($1,$1)
       ON CONFLICT (key) DO UPDATE SET key = EXCLUDED.key RETURNING id`,
      [key],
    );
    const id = rows[0]!.id;
    this.providerIds.set(key, id);
    return id;
  }

  /**
   * Price a proxy observation.
   *
   * Same rule as the collector: keyed on (provider, model), computed once and
   * stored, never recomputed. Local inference is a genuine zero, which is why
   * 'free_local' exists and is not conflated with 'unpriced'.
   */
  private async priceIt(
    providerId: number,
    modelNormalized: string | null,
    usage: ExtractedUsage,
    at: Date,
    isLocal: boolean,
  ): Promise<{ costUsd: string | null; costSource: string; pricingId: string | null }> {
    if (isLocal) return { costUsd: '0', costSource: 'free_local', pricingId: null };
    if (modelNormalized === null || !usage.reported) {
      return { costUsd: null, costSource: 'unpriced', pricingId: null };
    }
    const { rows } = await this.pool.query(
      `SELECT id, input_usd_per_mtok, output_usd_per_mtok, cache_read_usd_per_mtok,
              cache_write_5m_usd_per_mtok, cache_write_1h_usd_per_mtok
       FROM model_pricing
       WHERE provider_id = $1 AND model_normalized = $2
         AND effective_from <= $3 AND (effective_to IS NULL OR effective_to > $3)
       LIMIT 1`,
      [providerId, modelNormalized, at],
    );
    const p = rows[0];
    if (!p) return { costUsd: null, costSource: 'unpriced', pricingId: null };

    const per = (tokens: number | null, rate: unknown): number =>
      tokens === null || rate === null ? 0 : (tokens / 1_000_000) * Number(rate);

    const split = (usage.cacheWrite5mTokens ?? 0) + (usage.cacheWrite1hTokens ?? 0);
    const unsplit = Math.max(0, (usage.cacheWriteTokens ?? 0) - split);

    const total =
      per(usage.inputTokens, p.input_usd_per_mtok) +
      per(usage.outputTokens, p.output_usd_per_mtok) +
      per(usage.cacheReadTokens, p.cache_read_usd_per_mtok) +
      per(usage.cacheWrite5mTokens, p.cache_write_5m_usd_per_mtok) +
      per(usage.cacheWrite1hTokens, p.cache_write_1h_usd_per_mtok) +
      per(unsplit, p.cache_write_5m_usd_per_mtok);

    return { costUsd: total.toFixed(8), costSource: 'priced', pricingId: String(p.id) };
  }

  /** Mirror of normalize_model_id() in SQL, needed here for the pricing probe. */
  private normalizeModel(raw: string | null): string | null {
    if (raw === null) return null;
    let s = raw.trim().toLowerCase();
    s = s.replace(/^.*\//, '');
    s = s.replace(/^(us|eu|apac|jp|global)\./, '');
    s = s.replace(/^(anthropic|openai|google|meta|mistral|amazon|cohere|ai21|deepseek|qwen|moonshot)\./, '');
    s = s.replace(/-v[0-9]+:[0-9]+$/, '');
    s = s.replace(/[@-]20[0-9]{6}$/, '');
    s = s.replace(/:latest$/, '');
    return s === '' ? null : s;
  }

  async recordRequest(input: RecordInput): Promise<void> {
    const providerId = await this.providerId(input.providerKey);
    const modelNormalized = this.normalizeModel(input.modelRaw);
    const price = await this.priceIt(
      providerId, modelNormalized, input.usage, input.startedAt, input.isLocal,
    );

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      await client.query(
        `INSERT INTO proxy_requests (
           external_id, upstream_host, upstream_url, method, path, provider_id,
           model_raw, is_streaming, status_code, error_message,
           input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
           cache_write_5m_tokens, cache_write_1h_tokens, token_source,
           cost_usd, cost_source, pricing_id, provider_request_id,
           started_at, ended_at, match_method, redaction_version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
                 $17::token_source,$18,$19::cost_source,$20,$21,$22,$23,'pending',$24)
         ON CONFLICT (external_id) DO NOTHING`,
        [
          input.externalId, input.upstreamHost, input.upstreamUrl, input.method, input.path, providerId,
          input.modelRaw, input.isStreaming, input.statusCode, input.errorMessage,
          input.usage.inputTokens, input.usage.outputTokens,
          input.usage.cacheReadTokens, input.usage.cacheWriteTokens,
          input.usage.cacheWrite5mTokens, input.usage.cacheWrite1hTokens,
          // 'unknown' rather than 'proxy' when nothing was reported: recording
          // a source implies a measurement exists.
          input.usage.reported ? 'proxy' : 'unknown',
          price.costUsd, price.costSource, price.pricingId, input.providerRequestId,
          input.startedAt, input.endedAt, input.redactionVersion,
        ],
      );

      await client.query(
        `INSERT INTO raw_events (source, external_id, layer, payload, occurred_at)
         VALUES ($1,$2,'proxy'::capture_layer,$3::jsonb,$4)
         ON CONFLICT (source, external_id) DO NOTHING`,
        [
          'proxy',
          input.externalId,
          JSON.stringify(input.rawPayload, Redactor.jsonSafeReplacer),
          input.startedAt,
        ],
      );

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
