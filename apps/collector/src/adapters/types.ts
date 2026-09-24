/**
 * The adapter contract.
 *
 * Adding an agent must mean writing one adapter + one config entry, nothing
 * else — no migration, no change to the ingest pipeline, no new table. So this
 * interface is deliberately narrow: an adapter finds its transcripts and turns
 * bytes into ParsedTurns. Everything downstream (redaction, path translation,
 * pricing, upserts, checkpoints) is shared and agent-agnostic.
 */
import type {
  Attribution,
  CaptureLayer,
  ChangeType,
  DurationSource,
  TokenSource,
  TurnStatus,
} from '@agentpulse/schema/types';

export interface DiscoveredTranscript {
  /** Container path to read. */
  containerPath: string;
  /** The agent's own session id, used for idempotent upserts. */
  externalSessionId: string;
  /** True for sub-agent/sidechain transcripts. */
  isSidechain: boolean;
  /** External session id of the parent, when this is a sidechain. */
  parentExternalSessionId: string | null;
}

export interface ParsedToolCall {
  seq: number;
  externalToolUseId: string | null;
  toolName: string;
  command: string | null;
  /** Container path; translated to a host path before insert. */
  cwd: string | null;
  /** null = unknown. Layer 1 never reports this for Claude Code. */
  exitCode: number | null;
  stdout: string | null;
  durationMs: number | null;
  durationSource: DurationSource;
  startedAt: Date | null;
  interrupted: boolean;
  isBackground: boolean;
}

export interface ParsedFileChange {
  seq: number;
  /** Container path; translated before insert. */
  path: string;
  oldPath: string | null;
  changeType: ChangeType;
  linesAdded: number | null;
  linesRemoved: number | null;
  isBinary: boolean;
  blobHashBefore: string | null;
  blobHashAfter: string | null;
  attribution: Attribution;
  /** Raw unified diff, pre-redaction and pre-cap. */
  unifiedDiff: string | null;
  toolCallSeq: number | null;
}

export interface ParsedTurn {
  externalSessionId: string;
  seq: number;
  externalTurnId: string | null;
  promptText: string | null;
  responseText: string | null;

  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  cacheWrite5mTokens: number | null;
  cacheWrite1hTokens: number | null;
  tokenSource: TokenSource;

  modelRaw: string | null;
  gitBranch: string | null;
  gitHeadSha: string | null;
  gitDirty: boolean | null;

  startedAt: Date;
  endedAt: Date | null;
  status: TurnStatus;
  source: CaptureLayer;

  /** Container path of the project root / cwd. Translated before insert. */
  cwd: string | null;
  agentVersion: string | null;
  entrypoint: string | null;

  toolCalls: ParsedToolCall[];
  fileChanges: ParsedFileChange[];

  /** Verbatim source records, for raw_events provenance and replay. */
  rawRecords: RawRecordRef[];
}

export interface RawRecordRef {
  /** Stable, content-derived. Never a line number — compaction rewrites files. */
  externalId: string;
  payload: unknown;
  occurredAt: Date | null;
}

export interface ParseResult {
  /** Turns closed by a following human prompt — safe to write as complete. */
  turns: ParsedTurn[];
  /**
   * Byte offset to checkpoint.
   *
   * This is the offset of the START of the currently-open turn, not EOF. On
   * restart we re-read the open turn from its first byte rather than losing
   * it. Re-reading is free because every write is idempotent — turns upsert on
   * (session_id, seq) and raw_events on (source, external_id).
   */
  checkpointOffset: number;
  /** The still-open turn, written as status='partial'. */
  openTurn: ParsedTurn | null;
}

export interface AgentAdapter {
  readonly key: string;
  /** Find transcripts under the agent's (read-only) home directory. */
  discover(): Promise<DiscoveredTranscript[]>;
  /**
   * Parse a whole transcript from `fromOffset`.
   * @param content   file content from byte 0 (the adapter slices it itself)
   * @param fromOffset byte offset to resume from
   * @param startSeq   first turn seq to assign
   */
  parse(transcript: DiscoveredTranscript, content: Buffer, fromOffset: number, startSeq: number): ParseResult;
}
