/**
 * Gemini CLI adapter (Layer 1).
 *
 * Included to prove the adapter contract generalises beyond the agent it was
 * designed against — Gemini CLI is the only *other* agent installed on this
 * machine with a verifiable transcript format. It is not one of the five v1
 * targets.
 *
 * Two on-disk formats, both still present on this machine:
 *
 *   Legacy (verified 2026-09-18, sessions from 2025):
 *     ~/.gemini/tmp/<projectHash>/chats/session-<ts>-<id>.json
 *     One JSON document { sessionId, projectHash, startTime, lastUpdated,
 *     messages: [...] }, rewritten in place. `content` is a string.
 *
 *   Current (verified 2026-09-24 against Gemini CLI 0.61.0, three sessions):
 *     ~/.gemini/tmp/<projectName>/chats/session-<ts>-<id>.jsonl
 *     The directory is named via ~/.gemini/projects.json, but the header line
 *     still carries the sha256 projectHash, so resolution is unchanged. The
 *     file is an append-only event log, replayed by `replayJsonl`:
 *       - line 1 is the header (no `messages`);
 *       - a bare message line upserts by `id` — a `gemini` message is written
 *         once when it streams and again, whole, once its `toolCalls` finish;
 *       - `{"$set": {...}}` overwrites top-level fields. `$set.messages`
 *         REPLACES the list: it is how a failed prompt gets rewound (a quota
 *         error removed "create GEMINI.md file" before it was retried).
 *     `content` is a parts array: `[{text}]` for typed text, `[{functionResponse}]`
 *     for a tool result. Types seen: user, gemini, error, info.
 *
 * Things that differ from Claude Code and shape the implementation:
 *
 *  1. THE WHOLE FILE IS PARSED EVERY TIME. The legacy file is rewritten in
 *     place, and in the current one a later line can rewrite or delete an
 *     earlier message, so there is no offset to resume from. Turn identity is
 *     the prompt's message id, so re-parsing upserts instead of duplicating.
 *
 *  2. NOT EVERY `user` MESSAGE IS A PROMPT. Tool results arrive as `user`
 *     messages, and the CLI injects its own context as `user` text (see
 *     INJECTED_PREFIXES). Only the rest start a turn.
 *
 *  3. TOOL CALLS exist only in the current format; the legacy files record
 *     none. Neither records file changes or an exit code.
 *
 *  4. THE PROJECT PATH IS HASHED. `projectHash` is sha256 of the absolute
 *     project path (verified: 4 of the 5 hashes on this machine resolve
 *     against real directories). The hash is one-way, so the adapter builds a
 *     reverse index by hashing the configured code roots. A hash that matches
 *     no candidate — a deleted project, or a root that is not mounted — is
 *     unresolvable by construction, and those sessions are skipped rather than
 *     attributed to a guess.
 */
import { createHash } from 'node:crypto';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  AgentAdapter,
  DiscoveredTranscript,
  ParseResult,
  ParsedToolCall,
  ParsedTurn,
  RawRecordRef,
} from './types.js';

/** How deep to look for project directories under each configured code root. */
const SCAN_DEPTH = 3;
/** Safety valve so a huge tree cannot stall startup. */
const MAX_SCANNED_DIRS = 5000;

interface GeminiTokens {
  input?: number;
  output?: number;
  cached?: number;
  thoughts?: number;
  tool?: number;
  total?: number;
}

/**
 * Text the CLI itself sends as a `user` message. Every user text in the three
 * current-format sessions on this machine was either typed or starts with one
 * of these. An unrecognised prefix is treated as a prompt: a stray turn is
 * visible and fixable, a hidden prompt is not.
 */
const INJECTED_PREFIXES = [
  '<session_context>',
  "Here is the user's editor context",
  "Here is a summary of changes in the user's editor context",
];

interface GeminiPart {
  text?: string;
  functionResponse?: unknown;
}

interface GeminiToolCall {
  id?: string;
  name?: string;
  args?: Record<string, unknown>;
  result?: unknown;
  status?: string;
  timestamp?: string;
}

interface GeminiMessage {
  id?: string;
  timestamp?: string;
  type?: string;
  content?: string | GeminiPart[];
  model?: string;
  tokens?: GeminiTokens;
  toolCalls?: GeminiToolCall[];
}

interface GeminiSession {
  sessionId?: string;
  projectHash?: string;
  startTime?: string;
  lastUpdated?: string;
  messages?: GeminiMessage[];
}

function parseDate(v: unknown): Date | null {
  if (typeof v !== 'string') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function textOf(content: GeminiMessage['content']): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((p) => (isRecord(p) && typeof p.text === 'string' ? p.text : ''))
    .filter((t) => t !== '')
    .join('\n');
}

type UserKind = 'prompt' | 'injected' | 'tool_result';

function classifyUser(message: GeminiMessage): UserKind {
  // Legacy string content predates both tool results and injected context.
  if (typeof message.content === 'string') return 'prompt';
  const text = textOf(message.content);
  if (text === '') return 'tool_result';
  return INJECTED_PREFIXES.some((p) => text.startsWith(p)) ? 'injected' : 'prompt';
}

/**
 * Replay a current-format event log into its final message list.
 *
 * `promptOrder` is every prompt id in first-appearance order, including ones a
 * later `$set.messages` removed. Turn seq is derived from it rather than from
 * the final list, so a rewind can never shift a later turn onto a seq that an
 * earlier pass already gave to a different turn. A rewound prompt leaves a gap.
 */
export function replayJsonl(content: string): { session: GeminiSession; promptOrder: string[] } {
  const session: GeminiSession = {};
  let messages: GeminiMessage[] = [];
  const promptOrder: string[] = [];
  const seen = new Set<string>();
  const note = (m: GeminiMessage): void => {
    if (typeof m.id !== 'string' || seen.has(m.id)) return;
    if (m.type !== 'user' || classifyUser(m) !== 'prompt') return;
    seen.add(m.id);
    promptOrder.push(m.id);
  };

  for (const line of content.split('\n')) {
    if (line.trim() === '') continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      // The last line of a file being appended to can be half-written. The
      // next pass re-reads it whole.
      continue;
    }
    if (!isRecord(record)) continue;

    if (isRecord(record['$set'])) {
      for (const [key, value] of Object.entries(record['$set'])) {
        if (key === 'messages') {
          if (!Array.isArray(value)) continue;
          messages = value.filter(isRecord) as GeminiMessage[];
          messages.forEach(note);
        } else {
          (session as Record<string, unknown>)[key] = value;
        }
      }
      continue;
    }

    if (typeof record['id'] === 'string' && typeof record['type'] === 'string') {
      const message = record as GeminiMessage;
      note(message);
      const at = messages.findIndex((m) => m.id === message.id);
      if (at === -1) messages.push(message);
      else messages[at] = message;
      continue;
    }

    // The header: everything except the messages.
    Object.assign(session, record);
  }

  session.messages = messages;
  return { session, promptOrder };
}

/** The shell tool's result is `[{functionResponse: {response: {output}}}]`. */
function shellOutput(result: unknown): string | null {
  if (!Array.isArray(result)) return null;
  for (const part of result) {
    if (!isRecord(part) || !isRecord(part['functionResponse'])) continue;
    const response = part['functionResponse']['response'];
    if (isRecord(response) && typeof response['output'] === 'string') return response['output'];
  }
  return null;
}

export class GeminiCliAdapter implements AgentAdapter {
  readonly key = 'gemini_cli';

  /** projectHash → CONTAINER path of the project. */
  private hashIndex = new Map<string, string>();

  /**
   * @param home        container path of ~/.gemini
   * @param codeRoots   container paths of the mounted code roots
   * @param toHostPath  container → host, because Gemini hashed the HOST path
   */
  constructor(
    private readonly home: string,
    private readonly codeRoots: readonly string[],
    private readonly toHostPath: (containerPath: string) => string,
  ) {}

  /**
   * Build the projectHash → path reverse index.
   *
   * Hashing the HOST path is essential: the agent ran on the host, so
   * `/host/code/root1/foo` hashes to something that appears in no transcript.
   */
  private async buildHashIndex(): Promise<void> {
    this.hashIndex.clear();
    let scanned = 0;

    const visit = async (dir: string, depth: number): Promise<void> => {
      if (depth > SCAN_DEPTH || scanned >= MAX_SCANNED_DIRS) return;
      scanned += 1;
      const hostPath = this.toHostPath(dir);
      this.hashIndex.set(createHash('sha256').update(hostPath).digest('hex'), dir);

      if (depth === SCAN_DEPTH) return;
      let entries: string[];
      try {
        entries = await readdir(dir);
      } catch {
        return;
      }
      for (const entry of entries) {
        // Skip the usual suspects: they are never project roots and can be
        // enormous.
        if (entry.startsWith('.') || entry === 'node_modules' || entry === 'vendor') continue;
        const child = join(dir, entry);
        try {
          if ((await stat(child)).isDirectory()) await visit(child, depth + 1);
        } catch {
          // Unreadable or vanished between readdir and stat.
        }
      }
    };

    for (const root of this.codeRoots) await visit(root, 0);
  }

  async discover(): Promise<DiscoveredTranscript[]> {
    await this.buildHashIndex();

    const tmpDir = join(this.home, 'tmp');
    const found: DiscoveredTranscript[] = [];

    let hashes: string[];
    try {
      hashes = await readdir(tmpDir);
    } catch {
      return found;
    }

    for (const projectHash of hashes) {
      const chatsDir = join(tmpDir, projectHash, 'chats');
      let files: string[];
      try {
        files = await readdir(chatsDir);
      } catch {
        continue; // a project with logs but no chats
      }
      for (const file of files) {
        if (!file.endsWith('.json') && !file.endsWith('.jsonl')) continue;
        found.push({
          containerPath: join(chatsDir, file),
          // Namespaced by directory: session file names are only unique per
          // project. The directory is a hash (legacy) or a project name.
          externalSessionId: `${projectHash}/${file.replace(/\.jsonl?$/, '')}`,
          isSidechain: false,
          parentExternalSessionId: null,
        });
      }
    }
    return found;
  }

  /** Resolve a project hash to a container path, or null if unknown. */
  private resolveProject(projectHash: string): string | null {
    return this.hashIndex.get(projectHash) ?? null;
  }

  parse(
    transcript: DiscoveredTranscript,
    content: Buffer,
    _fromOffset: number,
    _startSeq: number,
  ): ParseResult {
    // Both offsets are deliberately ignored (see note 1). Seq is derived from
    // the file itself, never from the checkpoint, because every pass numbers
    // the whole session again and must hand each prompt the number it had.
    const turns: ParsedTurn[] = [];
    const text = content.toString('utf8');

    let session: GeminiSession;
    let promptOrder: string[];
    if (transcript.containerPath.endsWith('.jsonl')) {
      ({ session, promptOrder } = replayJsonl(text));
    } else {
      try {
        session = JSON.parse(text) as GeminiSession;
      } catch {
        // A rewrite caught mid-flight leaves invalid JSON. Do not advance the
        // checkpoint — the next poll reads a complete file.
        return { turns, checkpointOffset: _fromOffset, openTurn: null };
      }
      promptOrder = (Array.isArray(session.messages) ? session.messages : [])
        .filter((m) => m.type === 'user' && classifyUser(m) === 'prompt' && typeof m.id === 'string')
        .map((m) => m.id as string);
    }

    const projectHash = session.projectHash ?? transcript.externalSessionId.split('/')[0] ?? '';
    const cwd = this.resolveProject(projectHash);
    const messages = Array.isArray(session.messages) ? session.messages : [];

    let current: {
      prompt: GeminiMessage;
      seq: number;
      startedAt: Date;
      responses: string[];
      raw: RawRecordRef[];
      toolCalls: ParsedToolCall[];
      input: number;
      output: number;
      cached: number;
      model: string | null;
      sawTokens: boolean;
      sawError: boolean;
      endedAt: Date | null;
    } | null = null;
    // Injected context arrives just before the prompt it belongs to.
    let pendingRaw: RawRecordRef[] = [];

    const build = (closed: boolean): ParsedTurn | null => {
      if (!current) return null;
      let status: ParsedTurn['status'];
      if (!closed) status = 'partial';
      else if (current.sawError) status = 'error';
      else status = 'complete';
      return {
        externalSessionId: transcript.externalSessionId,
        seq: current.seq,
        externalTurnId: current.prompt.id ?? null,
        promptText: textOf(current.prompt.content) || null,
        responseText: current.responses.length > 0 ? current.responses.join('\n\n') : null,

        // Gemini's `input` INCLUDES `cached` (observed: total = input + output
        // + thoughts + tool). input_tokens is stored uncached, as for Claude,
        // so total_input_tokens is not inflated and cost bills each token once.
        inputTokens: current.sawTokens ? Math.max(0, current.input - current.cached) : null,
        // Gemini reports `thoughts` as a bucket separate from `output`, and
        // `total` includes both. They are folded together here because both
        // are model-generated tokens. ASSUMPTION, flagged: billing thinking at
        // the output rate is not verified against a Gemini invoice.
        outputTokens: current.sawTokens ? current.output : null,
        cacheReadTokens: current.sawTokens ? current.cached : null,
        // Gemini reports no cache-write bucket at all.
        cacheWriteTokens: null,
        cacheWrite5mTokens: null,
        cacheWrite1hTokens: null,
        tokenSource: current.sawTokens ? 'provider' : 'unknown',

        modelRaw: current.model,
        // Not recorded by this agent in any form.
        gitBranch: null,
        gitHeadSha: null,
        gitDirty: null,

        startedAt: current.startedAt,
        endedAt: current.endedAt,
        status,
        source: 'logs',

        cwd,
        agentVersion: null,
        entrypoint: 'gemini-cli',

        toolCalls: current.toolCalls,
        // Genuinely empty: neither format records edits as such.
        fileChanges: [],
        rawRecords: current.raw,
      };
    };

    for (const message of messages) {
      const ts = parseDate(message.timestamp);
      const rawRef: RawRecordRef = {
        externalId: `${transcript.externalSessionId}:${message.id ?? createHash('sha256').update(JSON.stringify(message)).digest('hex').slice(0, 24)}`,
        payload: message,
        occurredAt: ts,
      };

      const kind = message.type === 'user' ? classifyUser(message) : null;
      const seqIndex = kind === 'prompt' && typeof message.id === 'string' ? promptOrder.indexOf(message.id) : -1;

      if (kind === 'prompt' && seqIndex !== -1) {
        const closed = build(true);
        if (closed) turns.push(closed);
        current = {
          prompt: message,
          seq: seqIndex + 1,
          startedAt: ts ?? parseDate(session.startTime) ?? new Date(),
          responses: [],
          raw: [...pendingRaw, rawRef],
          toolCalls: [],
          input: 0,
          output: 0,
          cached: 0,
          model: null,
          sawTokens: false,
          sawError: false,
          endedAt: ts,
        };
        pendingRaw = [];
        continue;
      }

      if (kind === 'injected' || !current) {
        // Kept as provenance on the next turn; a record before any prompt has
        // nowhere else to go.
        pendingRaw.push(rawRef);
        continue;
      }

      current.raw.push(rawRef);
      if (ts) current.endedAt = ts;
      if (kind === 'tool_result') continue;

      if (message.type === 'error') current.sawError = true;
      const body = textOf(message.content);
      if (body.trim() !== '') current.responses.push(body);
      if (typeof message.model === 'string' && current.model === null) {
        current.model = message.model;
      }
      const tokens = message.tokens;
      if (tokens) {
        current.sawTokens = true;
        current.input += tokens.input ?? 0;
        current.output += (tokens.output ?? 0) + (tokens.thoughts ?? 0);
        current.cached += tokens.cached ?? 0;
      }

      for (const call of message.toolCalls ?? []) {
        if (!isRecord(call)) continue;
        const args = isRecord(call.args) ? call.args : {};
        const finishedAt = parseDate(call.timestamp);
        const isShell = call.name === 'run_shell_command';
        current.toolCalls.push({
          seq: current.toolCalls.length + 1,
          externalToolUseId: typeof call.id === 'string' ? call.id : null,
          toolName: typeof call.name === 'string' ? call.name : 'unknown',
          command: typeof args['command'] === 'string' ? args['command'] : null,
          cwd,
          // Not recorded: a successful shell result carries output only.
          exitCode: null,
          stdout: isShell ? shellOutput(call.result) : null,
          // DERIVED, an upper bound: the call's timestamp is when it finished
          // (it lands ~2ms before the result message), measured from when the
          // model message that issued it was written.
          durationMs: ts && finishedAt ? Math.max(0, finishedAt.getTime() - ts.getTime()) : null,
          durationSource: ts && finishedAt ? 'derived' : 'unknown',
          startedAt: ts,
          interrupted: false,
          isBackground: false,
        });
      }
    }

    // The last turn stays open until a following prompt closes it, exactly as
    // when tailing Claude Code: a live session may still be answering.
    const openTurn = build(false);

    // Checkpoint at EOF so an unchanged file is skipped; any growth re-parses
    // the whole thing.
    return { turns, checkpointOffset: content.length, openTurn };
  }
}
