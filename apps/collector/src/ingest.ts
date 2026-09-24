/**
 * The shared, agent-agnostic ingest pipeline.
 *
 * An adapter produces ParsedTurns in container-path space with raw text. This
 * module does everything that must be identical for every agent:
 * path translation outbound, redaction, provider resolution, cost, and the
 * idempotent writes — all inside one transaction per transcript pass, so a
 * checkpoint can never advance past rows that were not written.
 */
import { basename } from 'node:path';
import type pg from 'pg';
import type { AgentAdapter, DiscoveredTranscript, ParsedTurn } from './adapters/types.js';
import type { CollectorConfig } from './config.js';
import { Db } from './db.js';
import { PathMapper } from './paths.js';
import type { Redactor } from '@agentpulse/schema/redaction';

export interface IngestStats {
  turns: number;
  toolCalls: number;
  fileChanges: number;
  rawEvents: number;
  /** Turns with no resolvable cwd, so no project. Raw events still kept. */
  skipped: number;
  /** Transcripts that failed entirely and were skipped. Must be surfaced. */
  failed: number;
}

export class Ingestor {
  constructor(
    private readonly db: Db,
    private readonly config: CollectorConfig,
    private readonly redactor: Redactor,
  ) {}

  /**
   * Resolve the project for a turn.
   *
   * The agent's cwd is authoritative. Claude Code's directory slug
   * ('-Volumes-Macintosh-HD-1-Projects-Atom') is NOT usable for this: a
   * literal '-' in a directory name is indistinguishable from a separator, so
   * the slug is lossy. Falling back to cwd also covers the spec's "agent
   * invoked outside a git repo" case for free.
   */
  private resolveProjectPath(containerCwd: string | null): { hostPath: string; name: string } | null {
    if (containerCwd === null || containerCwd === '') return null;
    const hostPath = this.config.pathMapper.toHostIfMapped(containerCwd);
    PathMapper.assertHostPath(hostPath, 'projects.path');
    if (!hostPath.startsWith('/')) return null;
    return { hostPath, name: basename(hostPath) || hostPath };
  }

  /**
   * Cost, computed once at ingest and stored.
   *
   * Never recomputed retroactively: a price change inserts a new pricing row,
   * it does not rewrite what past turns cost. If no rate covers
   * (provider, model, started_at) the turn is 'unpriced' with a NULL cost —
   * NOT $0.00, which would make unknown models look free.
   */
  private async computeCost(
    providerId: number | null,
    modelNormalized: string | null,
    turn: ParsedTurn,
  ): Promise<{ costUsd: string | null; costSource: string; pricingId: string | null }> {
    if (providerId === null || modelNormalized === null || turn.tokenSource === 'unknown') {
      return { costUsd: null, costSource: 'unpriced', pricingId: null };
    }
    const pricing = await this.db.findPricing(providerId, modelNormalized, turn.startedAt);
    if (!pricing) return { costUsd: null, costSource: 'unpriced', pricingId: null };

    const perMillion = (tokens: number | null, rate: number | null): number =>
      tokens === null || rate === null ? 0 : (tokens / 1_000_000) * rate;

    // The 5m and 1h cache-write buckets price differently (1.25x vs 2x input),
    // so they are billed separately. When the provider reported only a total,
    // the buckets are zero and the total is charged at the 5m rate — the
    // cheaper of the two, so this never over-bills.
    const split = (turn.cacheWrite5mTokens ?? 0) + (turn.cacheWrite1hTokens ?? 0);
    const unsplit = Math.max(0, (turn.cacheWriteTokens ?? 0) - split);

    const total =
      perMillion(turn.inputTokens, pricing.inputUsdPerMtok) +
      perMillion(turn.outputTokens, pricing.outputUsdPerMtok) +
      perMillion(turn.cacheReadTokens, pricing.cacheReadUsdPerMtok) +
      perMillion(turn.cacheWrite5mTokens, pricing.cacheWrite5mUsdPerMtok) +
      perMillion(turn.cacheWrite1hTokens, pricing.cacheWrite1hUsdPerMtok) +
      perMillion(unsplit, pricing.cacheWrite5mUsdPerMtok);

    return { costUsd: total.toFixed(8), costSource: 'priced', pricingId: pricing.id };
  }

  /** Normalizer mirroring normalize_model_id() in SQL, for provider lookup. */
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

  async ingestTurns(
    client: pg.PoolClient,
    adapter: AgentAdapter,
    agentId: number,
    transcript: DiscoveredTranscript,
    turns: ParsedTurn[],
    stats: IngestStats,
  ): Promise<void> {
    for (const turn of turns) {
      const project = this.resolveProjectPath(turn.cwd);
      if (!project) {
        // Without a cwd there is no project, and projects.project_id is NOT
        // NULL by design. Skip the turn but keep its raw events, so nothing is
        // lost and the gap is auditable.
        stats.skipped += 1;
        await this.storeRawEvents(client, adapter, agentId, transcript, turn, null);
        continue;
      }

      const projectId = await this.db.upsertProject(
        client, project.hostPath, project.name, turn.startedAt,
      );

      const modelNormalized = this.normalizeModel(turn.modelRaw);
      // Precedence: proxy > config > model_map > unknown. Layer 1 transcripts
      // record neither the provider nor the resolved base URL, so backfilled
      // history can only ever reach 'model_map'.
      const providerId = modelNormalized === null ? null : await this.db.inferProvider(modelNormalized);
      const providerSource = providerId === null ? 'unknown' : 'model_map';

      const parentSessionId = transcript.parentExternalSessionId
        ? await this.db.findSessionIdByExternal(agentId, transcript.parentExternalSessionId)
        : null;

      const sessionId = await this.db.upsertSession(client, {
        agentId,
        agentVersion: turn.agentVersion,
        projectId,
        externalSessionId: transcript.externalSessionId,
        providerId,
        modelRaw: turn.modelRaw,
        providerSource,
        startedAt: turn.startedAt,
        endedAt: turn.endedAt,
        isSidechain: transcript.isSidechain,
        parentSessionId,
        entrypoint: turn.entrypoint,
      });

      const cost = await this.computeCost(providerId, modelNormalized, turn);

      const turnId = await this.db.upsertTurn(client, {
        sessionId,
        seq: turn.seq,
        projectId,
        agentId,
        externalTurnId: turn.externalTurnId,
        promptText: this.redactor.redact(turn.promptText),
        responseText: this.redactor.redact(turn.responseText),
        inputTokens: turn.inputTokens,
        outputTokens: turn.outputTokens,
        cacheReadTokens: turn.cacheReadTokens,
        cacheWriteTokens: turn.cacheWriteTokens,
        cacheWrite5mTokens: turn.cacheWrite5mTokens,
        cacheWrite1hTokens: turn.cacheWrite1hTokens,
        tokenSource: turn.tokenSource,
        costUsd: cost.costUsd,
        costSource: cost.costSource,
        pricingId: cost.pricingId,
        providerId,
        modelRaw: turn.modelRaw,
        providerSource,
        gitBranch: turn.gitBranch,
        gitHeadSha: turn.gitHeadSha,
        gitDirty: turn.gitDirty,
        startedAt: turn.startedAt,
        endedAt: turn.endedAt,
        status: turn.status,
        source: turn.source,
        redactionVersion: this.redactor.version,
      });

      // Re-reading an open turn after a restart legitimately adds tool calls,
      // so children are replaced wholesale rather than upserted row by row.
      await this.db.replaceTurnChildren(client, turnId);

      const toolCallIds = new Map<number, string>();
      for (const call of turn.toolCalls) {
        const stdout = this.redactor.redactAndCap(call.stdout, this.config.maxStdoutBytes);
        const id = await this.db.insertToolCall(client, {
          turnId,
          seq: call.seq,
          externalToolUseId: call.externalToolUseId,
          toolName: call.toolName,
          command: this.redactor.redact(call.command),
          cwd: call.cwd === null ? null : this.config.pathMapper.toHostIfMapped(call.cwd),
          exitCode: call.exitCode,
          stdoutExcerpt: stdout.text,
          stdoutBytesTotal: stdout.totalBytes,
          stdoutTruncated: stdout.truncated,
          durationMs: call.durationMs,
          durationSource: call.durationSource,
          startedAt: call.startedAt,
          interrupted: call.interrupted,
          isBackground: call.isBackground,
          redactionVersion: this.redactor.version,
        });
        toolCallIds.set(call.seq, id);
        stats.toolCalls += 1;
      }

      // Per-turn diff budget. Once exhausted, later diffs are stored truncated
      // rather than dropped — the file_change row always survives.
      let turnDiffBudget = this.config.maxTurnDiffBytes;

      for (const change of turn.fileChanges) {
        const hostPath = this.config.pathMapper.toHostIfMapped(change.path);
        PathMapper.assertHostPath(hostPath, 'file_changes.path');

        // SECURITY: diffs carry the same secrets prompts do — a diff that adds
        // a key to a config file contains that key. Redact before insert,
        // under the same pattern set and version as prompt text.
        const perDiffCap = Math.max(0, Math.min(this.config.maxDiffBytes, turnDiffBudget));
        const diff = change.unifiedDiff === null
          ? null
          : this.redactor.redactAndCap(change.unifiedDiff, perDiffCap);
        if (diff) turnDiffBudget = Math.max(0, turnDiffBudget - (diff.text?.length ?? 0));

        const fileChangeId = await this.db.insertFileChange(client, {
          turnId,
          seq: change.seq,
          toolCallId: change.toolCallSeq === null ? null : toolCallIds.get(change.toolCallSeq) ?? null,
          path: hostPath,
          oldPath: change.oldPath === null ? null : this.config.pathMapper.toHostIfMapped(change.oldPath),
          changeType: change.changeType,
          linesAdded: change.isBinary ? null : change.linesAdded,
          linesRemoved: change.isBinary ? null : change.linesRemoved,
          isBinary: change.isBinary,
          isTruncated: diff?.truncated ?? false,
          blobHashBefore: change.blobHashBefore,
          blobHashAfter: change.blobHashAfter,
          attribution: change.attribution,
          source: turn.source,
        });
        stats.fileChanges += 1;

        if (diff?.text != null) {
          await this.db.insertDiff(
            client, fileChangeId, diff.text, diff.totalBytes, diff.truncated, this.redactor.version,
          );
        }
      }

      await this.storeRawEvents(client, adapter, agentId, transcript, turn, project.hostPath);
      stats.turns += 1;
    }
  }

  private async storeRawEvents(
    client: pg.PoolClient,
    adapter: AgentAdapter,
    agentId: number,
    transcript: DiscoveredTranscript,
    turn: ParsedTurn,
    projectHostPath: string | null,
  ): Promise<void> {
    const inserted = await this.db.insertRawEvents(
      client,
      turn.rawRecords.map((r) => ({
        source: `${adapter.key}:logs`,
        externalId: r.externalId,
        agentId,
        layer: 'logs',
        payload: r.payload,
        sessionExternalId: transcript.externalSessionId,
        projectPath: projectHostPath,
        occurredAt: r.occurredAt,
      })),
    );
    // Not a stat of turns — this counts genuinely new raw rows, which is how a
    // re-run proves itself a no-op.
    void inserted;
  }
}
