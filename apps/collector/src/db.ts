/**
 * Database access. Every write here is idempotent: re-running the collector
 * over the same logs must be a no-op, so nothing uses a bare INSERT where a
 * conflict is possible.
 */
import pg from 'pg';
import { Redactor } from '@aiuo/schema/redaction';

const { Pool } = pg;

export interface PricingRow {
  id: string;
  inputUsdPerMtok: number;
  outputUsdPerMtok: number;
  cacheReadUsdPerMtok: number | null;
  cacheWrite5mUsdPerMtok: number | null;
  cacheWrite1hUsdPerMtok: number | null;
}

export class Db {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 4 });
  }

  /**
   * Retry with backoff rather than crash-loop. The compose healthcheck gates
   * startup, but a healthy Postgres can still refuse connections for a beat
   * during recovery, and a crash-looping collector loses its file watches
   * every time.
   */
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

  async withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /** Assert the schema exists — a collector against an unmigrated database
   *  should say so, not fail later with a confusing "relation does not exist". */
  async assertSchemaReady(): Promise<void> {
    const { rows } = await this.pool.query<{ present: boolean }>(
      `SELECT count(*) = 5 AS present FROM pg_tables
       WHERE schemaname = 'public'
         AND tablename IN ('projects','sessions','turns','tool_calls','raw_events')`,
    );
    if (!rows[0]?.present) {
      throw new Error(
        'Database schema is missing or incomplete. Run the migrate service first ' +
          '(docker compose run --rm migrate, or pnpm --filter @aiuo/schema migrate up).',
      );
    }
  }

  async getAgentId(key: string): Promise<number> {
    const { rows } = await this.pool.query<{ id: number }>(
      `INSERT INTO agents (key, display_name) VALUES ($1, $1)
       ON CONFLICT (key) DO UPDATE SET key = EXCLUDED.key
       RETURNING id`,
      [key],
    );
    return rows[0]!.id;
  }

  async getProviderId(key: string): Promise<number> {
    const { rows } = await this.pool.query<{ id: number }>(
      `INSERT INTO providers (key, display_name) VALUES ($1, $1)
       ON CONFLICT (key) DO UPDATE SET key = EXCLUDED.key
       RETURNING id`,
      [key],
    );
    return rows[0]!.id;
  }

  /** Register the live pattern set so every row's redaction_version resolves. */
  async registerRedactionVersion(
    version: number,
    patternHash: string,
    patternCount: number,
  ): Promise<void> {
    // DO NOTHING, never DO UPDATE. Overwriting the hash of an existing version
    // rewrites history: every row already stamped with it would then claim a
    // pattern set that was never applied to its content. If the patterns
    // changed, the version must change — so a mismatch is a startup error, not
    // something to paper over.
    await this.pool.query(
      `INSERT INTO redaction_versions (version, pattern_hash, pattern_count, description)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (version) DO NOTHING`,
      [version, patternHash, patternCount, `collector pattern set ${patternHash}`],
    );
    await this.assertRedactionVersionMatches(version, patternHash);
  }

  /**
   * Refuse to run if this version already exists under a different pattern set.
   *
   * Without this, editing DEFAULT_PATTERNS and forgetting to bump the version
   * is invisible: new rows and old rows both say "version N" while having been
   * written by two different pattern sets, and there is no way afterwards to
   * tell which content was covered by which.
   */
  private async assertRedactionVersionMatches(version: number, patternHash: string): Promise<void> {
    const { rows } = await this.pool.query<{ pattern_hash: string }>(
      `SELECT pattern_hash FROM redaction_versions WHERE version = $1`,
      [version],
    );
    const stored = rows[0]?.pattern_hash;
    if (stored !== undefined && stored !== patternHash) {
      throw new Error(
        `Redaction version ${version} is already recorded with pattern hash ${stored}, ` +
          `but the live pattern set hashes to ${patternHash}. The patterns changed without ` +
          `a version bump — rows written under both would be indistinguishable. ` +
          `Increment Redactor.version in packages/schema/src/redaction.ts.`,
      );
    }
  }

  /** Resolve provider by longest matching model prefix (the weakest rule). */
  async inferProvider(modelNormalized: string): Promise<number | null> {
    const { rows } = await this.pool.query<{ provider_id: number }>(
      `SELECT provider_id FROM model_providers
       WHERE $1 LIKE model_id_prefix || '%'
       ORDER BY length(model_id_prefix) DESC
       LIMIT 1`,
      [modelNormalized],
    );
    return rows[0]?.provider_id ?? null;
  }

  async findPricing(
    providerId: number,
    modelNormalized: string,
    at: Date,
  ): Promise<PricingRow | null> {
    const { rows } = await this.pool.query(
      `SELECT id, input_usd_per_mtok, output_usd_per_mtok,
              cache_read_usd_per_mtok, cache_write_5m_usd_per_mtok, cache_write_1h_usd_per_mtok
       FROM model_pricing
       WHERE provider_id = $1 AND model_normalized = $2
         AND effective_from <= $3 AND (effective_to IS NULL OR effective_to > $3)
       LIMIT 1`,
      [providerId, modelNormalized, at],
    );
    const r = rows[0];
    if (!r) return null;
    return {
      id: String(r.id),
      inputUsdPerMtok: Number(r.input_usd_per_mtok),
      outputUsdPerMtok: Number(r.output_usd_per_mtok),
      cacheReadUsdPerMtok: r.cache_read_usd_per_mtok === null ? null : Number(r.cache_read_usd_per_mtok),
      cacheWrite5mUsdPerMtok: r.cache_write_5m_usd_per_mtok === null ? null : Number(r.cache_write_5m_usd_per_mtok),
      cacheWrite1hUsdPerMtok: r.cache_write_1h_usd_per_mtok === null ? null : Number(r.cache_write_1h_usd_per_mtok),
    };
  }

  async upsertProject(
    client: pg.PoolClient,
    hostPath: string,
    name: string,
    seenAt: Date,
  ): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO projects (path, name, first_seen, last_seen)
       VALUES ($1, $2, $3, $3)
       ON CONFLICT (path) DO UPDATE
         SET last_seen  = GREATEST(projects.last_seen, EXCLUDED.last_seen),
             first_seen = LEAST(projects.first_seen, EXCLUDED.first_seen)
       RETURNING id`,
      [hostPath, name, seenAt],
    );
    return rows[0]!.id;
  }

  async upsertSession(
    client: pg.PoolClient,
    s: {
      agentId: number;
      agentVersion: string | null;
      projectId: string;
      externalSessionId: string;
      providerId: number | null;
      modelRaw: string | null;
      providerSource: string;
      startedAt: Date | null;
      endedAt: Date | null;
      isSidechain: boolean;
      parentSessionId: string | null;
      entrypoint: string | null;
    },
  ): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO sessions (agent_id, agent_version, project_id, external_session_id,
                             provider_id, model_raw, provider_source, started_at, ended_at,
                             source, is_sidechain, parent_session_id, entrypoint)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'logs',$10,$11,$12)
       ON CONFLICT (agent_id, external_session_id) DO UPDATE
         SET agent_version = COALESCE(EXCLUDED.agent_version, sessions.agent_version),
             ended_at      = GREATEST(sessions.ended_at, EXCLUDED.ended_at),
             started_at    = LEAST(sessions.started_at, EXCLUDED.started_at),
             updated_at    = now()
       RETURNING id`,
      [
        s.agentId, s.agentVersion, s.projectId, s.externalSessionId,
        s.providerId, s.modelRaw, s.providerSource, s.startedAt, s.endedAt,
        s.isSidechain, s.parentSessionId, s.entrypoint,
      ],
    );
    return rows[0]!.id;
  }

  /**
   * Upsert a turn. Re-ingesting the same transcript hits the ON CONFLICT path
   * and rewrites the row with identical values — a no-op in effect.
   *
   * Child rows are deleted and re-inserted rather than upserted, because an
   * open turn re-read after a restart legitimately gains tool calls.
   */
  async upsertTurn(client: pg.PoolClient, t: Record<string, unknown>): Promise<string> {
    // Identity is the agent's own prompt id when it has one, because a resumed
    // session re-appends its history to the same file and seq is only a
    // position in that file (migration 009). `seq` is excluded from the UPDATE
    // list so a replayed turn keeps the number it was first given.
    const hasExternalId = t['externalTurnId'] !== null && t['externalTurnId'] !== undefined;
    const conflictTarget = hasExternalId
      ? '(session_id, external_turn_id) WHERE external_turn_id IS NOT NULL'
      : '(session_id, seq)';

    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO turns (
         session_id, seq, project_id, agent_id, external_turn_id,
         prompt_text, response_text,
         input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
         cache_write_5m_tokens, cache_write_1h_tokens, token_source,
         cost_usd, cost_source, pricing_id,
         provider_id, model_raw, provider_source,
         git_branch, git_head_sha, git_dirty,
         started_at, ended_at, status, source, redaction_version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28)
       ON CONFLICT ${conflictTarget} DO UPDATE SET
         prompt_text = EXCLUDED.prompt_text,
         response_text = EXCLUDED.response_text,
         input_tokens = EXCLUDED.input_tokens,
         output_tokens = EXCLUDED.output_tokens,
         cache_read_tokens = EXCLUDED.cache_read_tokens,
         cache_write_tokens = EXCLUDED.cache_write_tokens,
         cache_write_5m_tokens = EXCLUDED.cache_write_5m_tokens,
         cache_write_1h_tokens = EXCLUDED.cache_write_1h_tokens,
         token_source = EXCLUDED.token_source,
         cost_usd = EXCLUDED.cost_usd,
         cost_source = EXCLUDED.cost_source,
         pricing_id = EXCLUDED.pricing_id,
         provider_id = EXCLUDED.provider_id,
         model_raw = EXCLUDED.model_raw,
         provider_source = EXCLUDED.provider_source,
         git_branch = EXCLUDED.git_branch,
         ended_at = EXCLUDED.ended_at,
         status = EXCLUDED.status,
         redaction_version = EXCLUDED.redaction_version,
         updated_at = now()
       RETURNING id`,
      [
        t['sessionId'], t['seq'], t['projectId'], t['agentId'], t['externalTurnId'],
        t['promptText'], t['responseText'],
        t['inputTokens'], t['outputTokens'], t['cacheReadTokens'], t['cacheWriteTokens'],
        t['cacheWrite5mTokens'], t['cacheWrite1hTokens'], t['tokenSource'],
        t['costUsd'], t['costSource'], t['pricingId'],
        t['providerId'], t['modelRaw'], t['providerSource'],
        t['gitBranch'], t['gitHeadSha'], t['gitDirty'],
        t['startedAt'], t['endedAt'], t['status'], t['source'], t['redactionVersion'],
      ],
    );
    return rows[0]!.id;
  }

  async replaceTurnChildren(client: pg.PoolClient, turnId: string): Promise<void> {
    // file_change_diffs cascade from file_changes; file_changes reference
    // tool_calls with ON DELETE SET NULL, so order matters.
    await client.query('DELETE FROM file_changes WHERE turn_id = $1', [turnId]);
    await client.query('DELETE FROM tool_calls WHERE turn_id = $1', [turnId]);
  }

  async insertToolCall(client: pg.PoolClient, c: Record<string, unknown>): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO tool_calls (turn_id, seq, external_tool_use_id, tool_name, command, cwd,
                               exit_code, stdout_excerpt, stdout_bytes_total, stdout_truncated,
                               duration_ms, duration_source, started_at, interrupted,
                               is_background, redaction_version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       RETURNING id`,
      [
        c['turnId'], c['seq'], c['externalToolUseId'], c['toolName'], c['command'], c['cwd'],
        c['exitCode'], c['stdoutExcerpt'], c['stdoutBytesTotal'], c['stdoutTruncated'],
        c['durationMs'], c['durationSource'], c['startedAt'], c['interrupted'],
        c['isBackground'], c['redactionVersion'],
      ],
    );
    return rows[0]!.id;
  }

  async insertFileChange(client: pg.PoolClient, f: Record<string, unknown>): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO file_changes (turn_id, seq, tool_call_id, path, old_path, change_type,
                                 lines_added, lines_removed, is_binary, is_truncated,
                                 blob_hash_before, blob_hash_after, attribution, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING id`,
      [
        f['turnId'], f['seq'], f['toolCallId'], f['path'], f['oldPath'], f['changeType'],
        f['linesAdded'], f['linesRemoved'], f['isBinary'], f['isTruncated'],
        f['blobHashBefore'], f['blobHashAfter'], f['attribution'], f['source'],
      ],
    );
    return rows[0]!.id;
  }

  async insertDiff(
    client: pg.PoolClient,
    fileChangeId: string,
    unifiedDiff: string,
    byteSize: number,
    isTruncated: boolean,
    redactionVersion: number,
  ): Promise<void> {
    await client.query(
      `INSERT INTO file_change_diffs (file_change_id, unified_diff, byte_size, is_truncated, redaction_version)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (file_change_id) DO UPDATE
         SET unified_diff = EXCLUDED.unified_diff,
             byte_size = EXCLUDED.byte_size,
             is_truncated = EXCLUDED.is_truncated`,
      [fileChangeId, unifiedDiff, byteSize, isTruncated, redactionVersion],
    );
  }

  /** THE idempotency point. Re-tailing the same file inserts zero rows. */
  async insertRawEvents(
    client: pg.PoolClient,
    events: {
      source: string;
      externalId: string;
      agentId: number;
      layer: string;
      payload: unknown;
      sessionExternalId: string | null;
      projectPath: string | null;
      occurredAt: Date | null;
    }[],
  ): Promise<number> {
    if (events.length === 0) return 0;
    let inserted = 0;
    // Chunked so a very long turn does not build one enormous statement.
    const CHUNK = 250;
    for (let i = 0; i < events.length; i += CHUNK) {
      const slice = events.slice(i, i + CHUNK);
      const values: unknown[] = [];
      const tuples = slice.map((e, idx) => {
        const b = idx * 8;
        values.push(e.source, e.externalId, e.agentId, e.layer,
                    JSON.stringify(e.payload, Redactor.jsonSafeReplacer),
                    e.sessionExternalId, e.projectPath, e.occurredAt);
        // Casts are explicit: `layer` is an enum and `payload` is jsonb, and
        // node-postgres sends both as text without them.
        return `($${b + 1},$${b + 2},$${b + 3},$${b + 4}::capture_layer,$${b + 5}::jsonb,$${b + 6},$${b + 7},$${b + 8})`;
      });
      // Column order must match the tuple order above.
      const { rowCount } = await client.query(
        `INSERT INTO raw_events (source, external_id, agent_id, layer, payload,
                                 session_external_id, project_path, occurred_at)
         VALUES ${tuples.join(',')}
         ON CONFLICT (source, external_id) DO NOTHING`,
        values,
      );
      inserted += rowCount ?? 0;
    }
    return inserted;
  }

  async getCheckpoint(
    agentId: number,
    hostFilePath: string,
  ): Promise<{ byteOffset: number; inode: string | null; fileSize: number | null; nextSeq: number } | null> {
    const { rows } = await this.pool.query(
      `SELECT byte_offset, inode, file_size, next_seq FROM ingest_checkpoints
       WHERE agent_id = $1 AND file_path = $2`,
      [agentId, hostFilePath],
    );
    const r = rows[0];
    if (!r) return null;
    return {
      byteOffset: Number(r.byte_offset),
      inode: r.inode === null ? null : String(r.inode),
      fileSize: r.file_size === null ? null : Number(r.file_size),
      nextSeq: Number(r.next_seq),
    };
  }

  async saveCheckpoint(
    client: pg.PoolClient,
    c: {
      agentId: number;
      hostFilePath: string;
      byteOffset: number;
      inode: string;
      fileSize: number;
      recordsIngested: number;
      backfilled: boolean;
      nextSeq: number;
    },
  ): Promise<void> {
    await client.query(
      `INSERT INTO ingest_checkpoints (agent_id, file_path, byte_offset, inode, file_size,
                                       records_ingested, next_seq, last_ingested_at, backfilled_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$8, now(), CASE WHEN $7 THEN now() END, now())
       ON CONFLICT (agent_id, file_path) DO UPDATE
         SET byte_offset = EXCLUDED.byte_offset,
             inode = EXCLUDED.inode,
             file_size = EXCLUDED.file_size,
             records_ingested = ingest_checkpoints.records_ingested + EXCLUDED.records_ingested,
             next_seq = EXCLUDED.next_seq,
             last_ingested_at = now(),
             backfilled_at = COALESCE(ingest_checkpoints.backfilled_at, EXCLUDED.backfilled_at),
             updated_at = now()`,
      [c.agentId, c.hostFilePath, c.byteOffset, c.inode, c.fileSize, c.recordsIngested, c.backfilled, c.nextSeq],
    );
  }

  async findSessionIdByExternal(agentId: number, externalSessionId: string): Promise<string | null> {
    const { rows } = await this.pool.query<{ id: string }>(
      'SELECT id FROM sessions WHERE agent_id = $1 AND external_session_id = $2',
      [agentId, externalSessionId],
    );
    return rows[0]?.id ?? null;
  }

  /**
   * Close turns left 'partial' by a stream that never terminated — an agent
   * killed mid-turn, or a transcript that stopped being written.
   */
  async reconcileStalePartials(olderThanMs: number): Promise<number> {
    const { rowCount } = await this.pool.query(
      `UPDATE turns SET status = 'aborted', updated_at = now()
       WHERE status = 'partial' AND started_at < now() - ($1 || ' milliseconds')::interval`,
      [String(olderThanMs)],
    );
    return rowCount ?? 0;
  }

  async counts(): Promise<Record<string, number>> {
    const { rows } = await this.pool.query(
      `SELECT (SELECT count(*) FROM projects)   AS projects,
              (SELECT count(*) FROM sessions)   AS sessions,
              (SELECT count(*) FROM turns)      AS turns,
              (SELECT count(*) FROM tool_calls) AS tool_calls,
              (SELECT count(*) FROM file_changes) AS file_changes,
              (SELECT count(*) FROM raw_events) AS raw_events`,
    );
    const r = rows[0] as Record<string, string>;
    return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Number(v)]));
  }
}
