/**
 * TypeScript mirror of the SQL schema.
 *
 * Convention (per the project brief): snake_case in SQL, camelCase in TS. The
 * collector and web app map between the two at the query boundary; nothing
 * below should carry a snake_case key.
 *
 * Enum string values DO match the SQL labels exactly — they are data, not
 * identifiers, and keeping them identical means config files, API payloads and
 * database rows all speak one vocabulary.
 */

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

/** Which capture layer produced a row. Conflict precedence: hooks > logs > proxy. */
export type CaptureLayer = 'hooks' | 'logs' | 'proxy' | 'reconciler';

/**
 * Where token counts came from. Provider-reported and locally estimated counts
 * must never be summed together silently.
 */
export type TokenSource = 'provider' | 'proxy' | 'estimated' | 'unknown';

/** Which rule resolved the provider, in the spec's precedence order. */
export type ProviderSource = 'proxy' | 'config' | 'model_map' | 'unknown';

export type TurnStatus = 'complete' | 'partial' | 'error' | 'aborted';

export type ChangeType = 'add' | 'modify' | 'delete' | 'rename';

/** 'uncertain' when a concurrent human edit or an unusable git repo makes agent attribution doubtful. */
export type Attribution = 'agent' | 'uncertain';

/** 'derived' durations are wall-clock upper bounds, not measured execution time. */
export type DurationSource = 'reported' | 'derived' | 'unknown';

/** 'unpriced' must render as "not priced", never as $0.00. */
export type CostSource = 'priced' | 'unpriced' | 'free_local';

/**
 * Agent and provider are NOT unions of literals here, because they are lookup
 * tables in SQL precisely so that adding one needs no migration. Typing them
 * as closed unions would reintroduce in TypeScript the rigidity the schema
 * went out of its way to avoid.
 */
export type AgentKey = string;
export type ProviderKey = string;

/** The v1 agent keys, for config defaults and exhaustiveness in the adapter registry. */
export const KNOWN_AGENT_KEYS = [
  'claude_code',
  'codex_cli',
  'qwen_code',
  'cursor_cli',
  'copilot_cli',
  'gemini_cli',
] as const;

/** The v1 provider keys. Hyphenated forms match the spec's vocabulary verbatim. */
export const KNOWN_PROVIDER_KEYS = [
  'anthropic',
  'openai',
  'google',
  'dashscope',
  'openrouter',
  'ollama',
  'github-copilot',
  'azure',
  'aws-bedrock',
  'google-vertex',
  'unknown',
] as const;

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export interface Project {
  id: string;
  /** Absolute HOST path. Never a container path — the DB rejects `/host/…`. */
  path: string;
  name: string;
  gitRemote: string | null;
  firstSeen: Date;
  lastSeen: Date;
}

export interface Session {
  id: string;
  agentId: number;
  agentVersion: string | null;
  projectId: string;
  externalSessionId: string;
  providerId: number | null;
  /** Verbatim provider model string. */
  modelRaw: string | null;
  /** Generated in SQL from modelRaw. Read-only — never written by the app. */
  readonly modelNormalized: string | null;
  providerSource: ProviderSource;
  startedAt: Date | null;
  endedAt: Date | null;
  source: CaptureLayer;
  parentSessionId: string | null;
  isSidechain: boolean;
  entrypoint: string | null;
}

export interface Turn {
  id: string;
  sessionId: string;
  seq: number;
  /** Denormalized from the session; kept consistent by a composite FK. */
  projectId: string;
  agentId: number;
  externalTurnId: string | null;

  promptText: string | null;
  responseText: string | null;

  /** null means "not reported" — which is not zero, and must not be summed as zero. */
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  /** Breakdown of cacheWriteTokens by TTL. The two price differently (1.25× vs 2× input). */
  cacheWrite5mTokens: number | null;
  cacheWrite1hTokens: number | null;
  tokenSource: TokenSource;
  /** Generated: input + cacheRead + cacheWrite. Use this for reporting, not inputTokens. */
  readonly totalInputTokens: number;

  costUsd: string | null;
  costSource: CostSource;
  pricingId: string | null;

  providerId: number | null;
  modelRaw: string | null;
  readonly modelNormalized: string | null;
  providerSource: ProviderSource;

  gitBranch: string | null;
  gitHeadSha: string | null;
  gitDirty: boolean | null;

  startedAt: Date;
  endedAt: Date | null;
  readonly durationMs: number | null;

  status: TurnStatus;
  source: CaptureLayer;
  redactionVersion: number;
}

export interface ToolCall {
  id: string;
  turnId: string;
  seq: number;
  externalToolUseId: string | null;
  toolName: string;
  command: string | null;
  cwd: string | null;
  /**
   * null means UNKNOWN, never success. Render null as "unknown".
   *
   * Recoverable ONLY from Layer 2 hooks, and only for tool calls captured
   * while hooks were installed:
   *
   *   PostToolUseFailure, error =~ /^Exit code (\d+)/  -> N   (observed)
   *   PostToolUse, no returnCodeInterpretation         -> 0   (inferred)
   *   PostToolUse, returnCodeInterpretation present    -> non-zero,
   *                                                       value not stated
   *
   * `tool_response` itself carries no exit status, and transcripts carry
   * none either, so historical rows can never be backfilled. See
   * docs/hook-payloads.md.
   */
  exitCode: number | null;
  stdoutExcerpt: string | null;
  stdoutBytesTotal: number | null;
  stdoutTruncated: boolean;
  durationMs: number | null;
  durationSource: DurationSource;
  startedAt: Date | null;
  interrupted: boolean;
  isBackground: boolean;
  redactionVersion: number;
}

export interface FileChange {
  id: string;
  turnId: string;
  /** One row per edit operation, not per file per turn. Group by path for display. */
  seq: number;
  toolCallId: string | null;
  path: string;
  oldPath: string | null;
  changeType: ChangeType;
  linesAdded: number | null;
  linesRemoved: number | null;
  isBinary: boolean;
  isTruncated: boolean;
  blobHashBefore: string | null;
  blobHashAfter: string | null;
  attribution: Attribution;
  sizeBeforeBytes: number | null;
  sizeAfterBytes: number | null;
  source: CaptureLayer;
}

/** Separate from FileChange so a list query can never accidentally select it. */
export interface FileChangeDiff {
  fileChangeId: string;
  unifiedDiff: string;
  /** Size before truncation, so the UI can say how much was elided. */
  byteSize: number;
  isTruncated: boolean;
  redactionVersion: number;
}

export interface RawEvent {
  id: string;
  source: string;
  /** Stable content-derived id. Never a line number — compaction rewrites transcripts. */
  externalId: string;
  agentId: number | null;
  layer: CaptureLayer;
  payload: unknown;
  sessionExternalId: string | null;
  projectPath: string | null;
  occurredAt: Date | null;
  ingestedAt: Date;
  supersededByLayer: CaptureLayer | null;
}

export interface IngestCheckpoint {
  id: string;
  agentId: number;
  filePath: string;
  byteOffset: number;
  inode: string | null;
  fileSize: number | null;
  lastLineHash: string | null;
  recordsIngested: number;
  lastIngestedAt: Date | null;
  backfilledAt: Date | null;
}

export interface ModelPricing {
  id: string;
  providerId: number;
  modelNormalized: string;
  inputUsdPerMtok: string;
  outputUsdPerMtok: string;
  cacheReadUsdPerMtok: string | null;
  cacheWrite5mUsdPerMtok: string | null;
  cacheWrite1hUsdPerMtok: string | null;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  source: string;
}
