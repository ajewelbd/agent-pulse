/**
 * Claude Code adapter (Layer 1 — session log tailer).
 *
 * Every rule below was derived by inspecting 25,571 real records across 31
 * transcripts on this machine (see phase-1-format-discovery.md). Nothing here
 * is guessed from memory.
 *
 * Layout:
 *   <home>/projects/<path-slug>/<session-uuid>.jsonl               main
 *   <home>/projects/<path-slug>/<session-uuid>/subagents/*.jsonl   sidechains
 *   <home>/projects/<path-slug>/<session-uuid>/tool-results/*.txt  spilled stdout
 */
import { createHash } from 'node:crypto';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  AgentAdapter,
  DiscoveredTranscript,
  ParseResult,
  ParsedFileChange,
  ParsedToolCall,
  ParsedTurn,
  RawRecordRef,
} from './types.js';

/**
 * Injected by Claude Code when a session resumes after context compaction.
 * It arrives as a `user` record with prose content and no `origin`, so without
 * this check it looks exactly like a human prompt and would create a phantom
 * turn at every compaction boundary. 73 such records exist on this machine.
 */
const COMPACTION_PREFIX = 'This session is being continued from a previous conversation';

/**
 * Claude Code's own placeholder model for locally generated messages (errors,
 * interrupts). It maps to no real model and carries no real usage, so it must
 * never reach pricing.
 */
const SYNTHETIC_MODEL = '<synthetic>';

interface ClaudeRecord {
  type?: string;
  uuid?: string;
  parentUuid?: string | null;
  sessionId?: string;
  timestamp?: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  entrypoint?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  promptSource?: unknown;
  origin?: { kind?: string } | null;
  message?: {
    role?: string;
    model?: string;
    content?: unknown;
    usage?: ClaudeUsage;
    stop_reason?: string | null;
  };
  toolUseResult?: unknown;
  subtype?: string;
}

interface ClaudeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  };
}

interface ContentBlock {
  type?: string;
  text?: string;
  name?: string;
  id?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function blocksOf(content: unknown): ContentBlock[] {
  return Array.isArray(content) ? (content.filter(isRecord) as ContentBlock[]) : [];
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  return blocksOf(content)
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n');
}

/**
 * Is this record a genuine human prompt — i.e. does it start a new turn?
 *
 * Getting this wrong is the single most damaging parser error available: too
 * loose and every tool result becomes a phantom turn (8,883 of them here), too
 * strict and whole conversations vanish.
 *
 * Empirically, across all 31 transcripts:
 *   - `origin.kind === 'human'` is authoritative on v2.1.204+ (449 records).
 *   - Before v2.1.204 `origin` does not exist, and real prompts are
 *     indistinguishable from XML injections by metadata alone — both carry
 *     `promptSource: 'sdk'`. Hence the content-shape fallback.
 *   - Everything without `origin` in this corpus is a non-human injection:
 *     XML blocks (109), compaction summaries (73), interrupt markers (25),
 *     isMeta skill preambles (17), image placeholders (2).
 */
export function isHumanPrompt(rec: ClaudeRecord): boolean {
  if (rec.type !== 'user') return false;
  // A record carrying toolUseResult is a tool result, never a prompt.
  if (rec.toolUseResult !== undefined) return false;

  const content = rec.message?.content;
  if (blocksOf(content).some((b) => b.type === 'tool_result')) return false;

  // Authoritative path (Claude Code >= 2.1.204).
  if (isRecord(rec.origin)) return rec.origin['kind'] === 'human';

  // Legacy fallback for transcripts written before `origin` existed.
  if (rec.isMeta) return false;
  if (rec.promptSource === undefined || rec.promptSource === null) return false;

  const text = textOf(content).trim();
  if (text === '') return false;
  if (text.startsWith('<')) return false; // <ide_opened_file>, <command-name>, …
  if (text.startsWith('[')) return false; // [Request interrupted by user], [Image: …]
  if (text.startsWith(COMPACTION_PREFIX)) return false;
  return true;
}

/** Stable id for raw_events. Content-derived so re-ingest is a true no-op. */
function recordExternalId(sessionId: string, rec: ClaudeRecord, line: string): string {
  if (typeof rec.uuid === 'string' && rec.uuid !== '') return `${sessionId}:${rec.uuid}`;
  // Records without a uuid (mode, ai-title, queue-operation) hash their content:
  // a line number would shift when compaction rewrites the transcript.
  return `${sessionId}:h:${createHash('sha256').update(line).digest('hex').slice(0, 24)}`;
}

function parseDate(v: unknown): Date | null {
  if (typeof v !== 'string') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Count +/- lines in a structuredPatch hunk list. */
function countPatchLines(patch: unknown): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  if (!Array.isArray(patch)) return { added, removed };
  for (const hunk of patch) {
    if (!isRecord(hunk) || !Array.isArray(hunk['lines'])) continue;
    for (const line of hunk['lines']) {
      if (typeof line !== 'string') continue;
      if (line.startsWith('+')) added++;
      else if (line.startsWith('-')) removed++;
    }
  }
  return { added, removed };
}

/** Render Claude Code's structuredPatch as a standard unified diff. */
function renderUnifiedDiff(path: string, patch: unknown): string | null {
  if (!Array.isArray(patch) || patch.length === 0) return null;
  const out: string[] = [`--- a${path}`, `+++ b${path}`];
  for (const hunk of patch) {
    if (!isRecord(hunk)) continue;
    const oldStart = Number(hunk['oldStart'] ?? 0);
    const oldLines = Number(hunk['oldLines'] ?? 0);
    const newStart = Number(hunk['newStart'] ?? 0);
    const newLines = Number(hunk['newLines'] ?? 0);
    out.push(`@@ -${oldStart},${oldLines} +${newStart},${newLines} @@`);
    for (const line of Array.isArray(hunk['lines']) ? hunk['lines'] : []) {
      if (typeof line === 'string') out.push(line);
    }
  }
  return out.join('\n');
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/** Accumulates records between two human prompts into one turn. */
class TurnBuilder {
  private readonly toolCalls: ParsedToolCall[] = [];
  private readonly fileChanges: ParsedFileChange[] = [];
  private readonly raw: RawRecordRef[] = [];
  private readonly responseParts: string[] = [];
  /** tool_use id → its index in toolCalls, for matching results back. */
  private readonly pendingTools = new Map<string, number>();
  private readonly toolStartedAt = new Map<string, Date>();

  private inputTokens = 0;
  private outputTokens = 0;
  private cacheReadTokens = 0;
  private cacheWriteTokens = 0;
  private cacheWrite5m = 0;
  private cacheWrite1h = 0;
  private sawUsage = false;

  private modelRaw: string | null = null;
  private endedAt: Date | null = null;
  private sawError = false;
  private sawAborted = false;

  constructor(
    readonly externalSessionId: string,
    readonly seq: number,
    readonly promptRecord: ClaudeRecord,
    readonly startedAt: Date,
    readonly byteOffset: number,
  ) {}

  addRaw(ref: RawRecordRef): void {
    this.raw.push(ref);
  }

  ingest(rec: ClaudeRecord): void {
    const ts = parseDate(rec.timestamp);
    // MAX, not "last seen". Timestamps within a turn are not monotonic: a
    // resumed session re-appends older records, so the final record processed
    // can predate the prompt. Taking the last one produced ended_at <
    // started_at, which violates the period CHECK on both turns and sessions
    // and — because ingest runs in one transaction per transcript — took down
    // the whole file's pass. Observed on real data: 134 turns ingested instead
    // of 442.
    if (ts && (this.endedAt === null || ts > this.endedAt)) this.endedAt = ts;

    if (rec.type === 'system' && rec.subtype === 'model_consent_fallback') {
      // A mid-session model switch. The per-record model on each assistant
      // message already reflects it, so nothing to do beyond keeping the raw
      // event — but this is why session-level model is not authoritative.
      return;
    }

    if (rec.type === 'assistant') {
      const msg = rec.message;
      if (!msg) return;

      const model = typeof msg.model === 'string' ? msg.model : null;
      // Take the first real model seen. Sub-turn model switches are visible in
      // raw_events; the turn reports the model that actually served it.
      if (model !== null && model !== SYNTHETIC_MODEL && this.modelRaw === null) {
        this.modelRaw = model;
      }

      // Usage is reported per assistant record, and a single turn produces many
      // (one per tool round-trip), so these accumulate. `iterations` inside the
      // usage object is a breakdown of the same totals — summing it too would
      // double-count.
      const usage = msg.usage;
      if (usage && model !== SYNTHETIC_MODEL) {
        this.sawUsage = true;
        this.inputTokens += usage.input_tokens ?? 0;
        this.outputTokens += usage.output_tokens ?? 0;
        this.cacheReadTokens += usage.cache_read_input_tokens ?? 0;
        this.cacheWriteTokens += usage.cache_creation_input_tokens ?? 0;
        this.cacheWrite5m += usage.cache_creation?.ephemeral_5m_input_tokens ?? 0;
        this.cacheWrite1h += usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
      }

      const text = textOf(msg.content);
      if (text.trim() !== '') this.responseParts.push(text);

      for (const block of blocksOf(msg.content)) {
        if (block.type !== 'tool_use' || typeof block.id !== 'string') continue;
        const input = isRecord(block.input) ? block.input : {};
        const command = typeof input['command'] === 'string' ? input['command'] : null;
        const index = this.toolCalls.length;
        this.toolCalls.push({
          seq: index + 1,
          externalToolUseId: block.id,
          toolName: typeof block.name === 'string' ? block.name : 'unknown',
          command,
          cwd: typeof rec.cwd === 'string' ? rec.cwd : null,
          // Layer 1 records no exit code for any tool. NULL means unknown.
          exitCode: null,
          stdout: null,
          durationMs: null,
          durationSource: 'unknown',
          startedAt: ts,
          interrupted: false,
          isBackground: false,
        });
        this.pendingTools.set(block.id, index);
        if (ts) this.toolStartedAt.set(block.id, ts);
      }
      return;
    }

    if (rec.type === 'user') {
      // Tool results arrive as `user` records — this is the trap that makes a
      // naive parser invent hundreds of turns.
      for (const block of blocksOf(rec.message?.content)) {
        if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
        const index = this.pendingTools.get(block.tool_use_id);
        if (index === undefined) continue;
        this.applyToolResult(index, block.tool_use_id, rec, ts);
      }
      return;
    }
  }

  private applyToolResult(
    index: number,
    toolUseId: string,
    rec: ClaudeRecord,
    ts: Date | null,
  ): void {
    const call = this.toolCalls[index];
    if (!call) return;
    const result = rec.toolUseResult;

    if (ts) {
      const startedAt = this.toolStartedAt.get(toolUseId);
      if (startedAt) {
        // DERIVED, not measured: this is wall-clock between the tool_use record
        // and its result, which includes model latency around the call. An
        // upper bound. duration_source keeps it from being averaged together
        // with real measurements from hooks.
        call.durationMs = ts.getTime() - startedAt.getTime();
        call.durationSource = 'derived';
      }
    }

    if (!isRecord(result)) return;

    if (typeof result['stdout'] === 'string') {
      const stderr = typeof result['stderr'] === 'string' ? result['stderr'] : '';
      call.stdout = stderr === '' ? result['stdout'] : `${result['stdout']}\n[stderr]\n${stderr}`;
    }
    if (result['interrupted'] === true) {
      call.interrupted = true;
      this.sawAborted = true;
    }
    if (typeof result['backgroundTaskId'] === 'string') call.isBackground = true;

    this.extractFileChange(result, index);
  }

  /**
   * Build a file change from an agent-reported edit payload.
   *
   * This is the preferred source over git: it is correct in a dirty tree, for
   * untracked files, and it cannot misattribute a concurrent human edit —
   * `originalFile` is what the agent actually read.
   */
  private extractFileChange(result: Record<string, unknown>, toolCallIndex: number): void {
    const filePath = result['filePath'];
    if (typeof filePath !== 'string') return;

    const patch = result['structuredPatch'];
    const hasPatch = Array.isArray(patch) && patch.length > 0;
    const isCreate = result['type'] === 'create';
    if (!hasPatch && !isCreate) return;

    const { added, removed } = countPatchLines(patch);
    const originalFile = typeof result['originalFile'] === 'string' ? result['originalFile'] : null;
    const newContent = typeof result['content'] === 'string' ? result['content'] : null;

    this.fileChanges.push({
      seq: this.fileChanges.length + 1,
      path: filePath,
      oldPath: null,
      changeType: isCreate ? 'add' : 'modify',
      linesAdded: isCreate && newContent !== null ? newContent.split('\n').length : added,
      linesRemoved: isCreate ? 0 : removed,
      isBinary: false,
      blobHashBefore: originalFile !== null ? sha256(originalFile) : null,
      blobHashAfter: newContent !== null ? sha256(newContent) : null,
      // `userModified` means the human touched the file between the agent's
      // read and its write, so the agent is not solely responsible for the
      // resulting content. Keep the row, flag the doubt — never drop it.
      attribution: result['userModified'] === true ? 'uncertain' : 'agent',
      unifiedDiff: hasPatch ? renderUnifiedDiff(filePath, patch) : null,
      toolCallSeq: toolCallIndex + 1,
    });
  }

  markError(): void {
    this.sawError = true;
  }

  build(closed: boolean): ParsedTurn {
    const prompt = this.promptRecord;
    let status: ParsedTurn['status'];
    if (!closed) status = 'partial';
    else if (this.sawError) status = 'error';
    else if (this.sawAborted) status = 'aborted';
    else status = 'complete';

    return {
      externalSessionId: this.externalSessionId,
      seq: this.seq,
      externalTurnId: typeof prompt.uuid === 'string' ? prompt.uuid : null,
      promptText: textOf(prompt.message?.content) || null,
      responseText: this.responseParts.length > 0 ? this.responseParts.join('\n\n') : null,

      // If no assistant record carried usage, report null rather than 0 —
      // "not reported" and "zero tokens" are different facts.
      inputTokens: this.sawUsage ? this.inputTokens : null,
      outputTokens: this.sawUsage ? this.outputTokens : null,
      cacheReadTokens: this.sawUsage ? this.cacheReadTokens : null,
      cacheWriteTokens: this.sawUsage ? this.cacheWriteTokens : null,
      cacheWrite5mTokens: this.sawUsage ? this.cacheWrite5m : null,
      cacheWrite1hTokens: this.sawUsage ? this.cacheWrite1h : null,
      tokenSource: this.sawUsage ? 'provider' : 'unknown',

      modelRaw: this.modelRaw,
      // A detached HEAD is reported as the literal branch name "HEAD". Storing
      // that would let the dashboard offer "HEAD" as a branch filter spanning
      // unrelated commits in unrelated repos. Per spec: null branch (the sha
      // is the real identity, and Layer 1 does not record it).
      gitBranch:
        typeof prompt.gitBranch === 'string' && prompt.gitBranch !== '' && prompt.gitBranch !== 'HEAD'
          ? prompt.gitBranch
          : null,
      // Not recorded anywhere in the transcript — only a hook or git gap-fill
      // can supply these.
      gitHeadSha: null,
      gitDirty: null,

      startedAt: this.startedAt,
      // Belt and braces after the max() above: if every record in the turn
      // predates its prompt, report no end time rather than an impossible one.
      endedAt: this.endedAt !== null && this.endedAt >= this.startedAt ? this.endedAt : null,
      status,
      source: 'logs',

      cwd: typeof prompt.cwd === 'string' ? prompt.cwd : null,
      agentVersion: typeof prompt.version === 'string' ? prompt.version : null,
      entrypoint: typeof prompt.entrypoint === 'string' ? prompt.entrypoint : null,

      toolCalls: this.toolCalls,
      fileChanges: this.fileChanges,
      rawRecords: this.raw,
    };
  }
}

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly key = 'claude_code';

  constructor(private readonly home: string) {}

  async discover(): Promise<DiscoveredTranscript[]> {
    const projectsDir = join(this.home, 'projects');
    const found: DiscoveredTranscript[] = [];

    let slugs: string[];
    try {
      slugs = await readdir(projectsDir);
    } catch {
      return found;
    }

    for (const slug of slugs) {
      const slugDir = join(projectsDir, slug);
      let entries: string[];
      try {
        entries = await readdir(slugDir);
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (entry.endsWith('.jsonl')) {
          found.push({
            containerPath: join(slugDir, entry),
            externalSessionId: entry.replace(/\.jsonl$/, ''),
            isSidechain: false,
            parentExternalSessionId: null,
          });
          continue;
        }

        // A directory named after a session holds its sidechains.
        const subagentsDir = join(slugDir, entry, 'subagents');
        try {
          const st = await stat(subagentsDir);
          if (!st.isDirectory()) continue;
          for (const sub of await readdir(subagentsDir)) {
            if (!sub.endsWith('.jsonl')) continue;
            found.push({
              containerPath: join(subagentsDir, sub),
              externalSessionId: `${entry}/${sub.replace(/\.jsonl$/, '')}`,
              isSidechain: true,
              parentExternalSessionId: entry,
            });
          }
        } catch {
          // No subagents directory — normal.
        }
      }
    }
    return found;
  }

  parse(
    transcript: DiscoveredTranscript,
    content: Buffer,
    fromOffset: number,
    startSeq: number,
  ): ParseResult {
    const sessionId = transcript.externalSessionId;
    const turns: ParsedTurn[] = [];
    let builder: TurnBuilder | null = null;
    let seq = startSeq;

    // Only whole lines are safe to parse: a tail can land mid-line, and half a
    // JSON object is not a record. Anything after the last newline is left for
    // the next pass.
    const lastNewline = content.lastIndexOf(0x0a);
    const safeEnd = lastNewline === -1 ? fromOffset : lastNewline + 1;
    if (safeEnd <= fromOffset) {
      return { turns, checkpointOffset: fromOffset, openTurn: null };
    }

    let cursor = fromOffset;
    // Offset of the first byte of the currently-open turn. Checkpointing here
    // rather than at EOF means a restart re-reads the open turn instead of
    // losing it; re-reading is free because every write is idempotent.
    let openTurnOffset = fromOffset;

    while (cursor < safeEnd) {
      const newlineAt = content.indexOf(0x0a, cursor);
      const end = newlineAt === -1 || newlineAt >= safeEnd ? safeEnd : newlineAt;
      const lineStart = cursor;
      const line = content.subarray(cursor, end).toString('utf8');
      cursor = end + 1;

      const trimmed = line.trim();
      if (trimmed === '') continue;

      let rec: ClaudeRecord;
      try {
        rec = JSON.parse(trimmed) as ClaudeRecord;
      } catch {
        // A malformed line must not stop the tail. It stays unparsed; the byte
        // offset still advances past it so we do not spin.
        continue;
      }

      const rawRef: RawRecordRef = {
        externalId: recordExternalId(sessionId, rec, trimmed),
        payload: rec,
        occurredAt: parseDate(rec.timestamp),
      };

      if (isHumanPrompt(rec)) {
        if (builder) turns.push(builder.build(true));
        const startedAt = parseDate(rec.timestamp) ?? new Date();
        openTurnOffset = lineStart;
        builder = new TurnBuilder(sessionId, seq, rec, startedAt, lineStart);
        seq += 1;
        builder.addRaw(rawRef);
        continue;
      }

      if (!builder) {
        // Records before the first human prompt (session metadata, resumed
        // transcript preamble). Retained as raw events, attached to no turn.
        continue;
      }

      builder.addRaw(rawRef);
      if (rec.type === 'system' && rec.subtype === 'api_error') builder.markError();
      builder.ingest(rec);
    }

    const openTurn = builder ? builder.build(false) : null;
    return {
      turns,
      // If a turn is open, resume from ITS first byte, not from EOF.
      checkpointOffset: builder ? openTurnOffset : safeEnd,
      openTurn,
    };
  }
}
