/**
 * Gemini CLI adapter (Layer 1).
 *
 * Included to prove the adapter contract generalises beyond the agent it was
 * designed against — Gemini CLI is the only *other* agent installed on this
 * machine with a verifiable transcript format. It is not one of the five v1
 * targets.
 *
 * Layout (verified 2026-09-18):
 *   ~/.gemini/tmp/<projectHash>/chats/session-<ts>-<id>.json
 *   ~/.gemini/tmp/<projectHash>/logs.json          (prompts only; unused here)
 *
 * Shape:
 *   { sessionId, projectHash, startTime, lastUpdated,
 *     messages: [ { id, timestamp, type: 'user' | 'gemini', content,
 *                   model?, tokens?: {input,output,cached,thoughts,tool,total},
 *                   thoughts?: [...] } ] }
 *
 * Three things differ from Claude Code and shape the whole implementation:
 *
 *  1. WHOLE-FILE JSON, not append-only NDJSON. The file is rewritten in place,
 *     so byte-offset resume cannot mean "parse from here" — the document must
 *     be parsed in full every time. Safe because turn identity is the message
 *     id, so re-parsing upserts instead of duplicating.
 *
 *  2. NO TOOL CALLS AND NO FILE CHANGES are recorded anywhere in the chat
 *     files. Dashboard columns 6 and 7 are therefore genuinely empty for this
 *     agent — not missing due to a parser gap. Only Layer 2/3 could fill them.
 *
 *  3. THE PROJECT PATH IS HASHED. `projectHash` is sha256 of the absolute
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

interface GeminiMessage {
  id?: string;
  timestamp?: string;
  type?: string;
  content?: string;
  model?: string;
  tokens?: GeminiTokens;
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
        if (!file.endsWith('.json')) continue;
        found.push({
          containerPath: join(chatsDir, file),
          // Namespaced by hash: session file names are only unique per project.
          externalSessionId: `${projectHash}/${file.replace(/\.json$/, '')}`,
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
    startSeq: number,
  ): ParseResult {
    // fromOffset is deliberately ignored: this is a whole-document JSON file
    // that gets rewritten, so a partial read is not parseable. Idempotency
    // comes from the message id, not from the offset.
    const turns: ParsedTurn[] = [];

    let session: GeminiSession;
    try {
      session = JSON.parse(content.toString('utf8')) as GeminiSession;
    } catch {
      // A rewrite caught mid-flight leaves invalid JSON. Do not advance the
      // checkpoint — the next poll reads a complete file.
      return { turns, checkpointOffset: _fromOffset, openTurn: null };
    }

    const projectHash = session.projectHash ?? transcript.externalSessionId.split('/')[0] ?? '';
    const cwd = this.resolveProject(projectHash);
    const messages = Array.isArray(session.messages) ? session.messages : [];

    let seq = startSeq;
    let current: {
      prompt: GeminiMessage;
      startedAt: Date;
      responses: string[];
      raw: RawRecordRef[];
      input: number;
      output: number;
      cached: number;
      model: string | null;
      sawTokens: boolean;
      endedAt: Date | null;
    } | null = null;

    const flush = (): void => {
      if (!current) return;
      turns.push({
        externalSessionId: transcript.externalSessionId,
        seq,
        externalTurnId: current.prompt.id ?? null,
        promptText: current.prompt.content ?? null,
        responseText: current.responses.length > 0 ? current.responses.join('\n\n') : null,

        inputTokens: current.sawTokens ? current.input : null,
        // Gemini reports `thoughts` as a bucket separate from `output`, and
        // `total` includes both. They are folded together here because both
        // are model-generated tokens. ASSUMPTION, flagged: I have not verified
        // how Gemini bills thinking tokens on this machine. It does not affect
        // cost today — no Gemini pricing row is seeded, so these turns are
        // cost_source='unpriced' rather than silently mispriced.
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
        status: 'complete',
        source: 'logs',

        cwd,
        agentVersion: null,
        entrypoint: 'gemini-cli',

        // Genuinely empty: the chat files record no tool calls and no edits.
        toolCalls: [],
        fileChanges: [],
        rawRecords: current.raw,
      });
      seq += 1;
      current = null;
    };

    for (const message of messages) {
      const ts = parseDate(message.timestamp);
      const rawRef: RawRecordRef = {
        externalId: `${transcript.externalSessionId}:${message.id ?? createHash('sha256').update(JSON.stringify(message)).digest('hex').slice(0, 24)}`,
        payload: message,
        occurredAt: ts,
      };

      if (message.type === 'user') {
        flush();
        current = {
          prompt: message,
          startedAt: ts ?? parseDate(session.startTime) ?? new Date(),
          responses: [],
          raw: [rawRef],
          input: 0,
          output: 0,
          cached: 0,
          model: null,
          sawTokens: false,
          endedAt: ts,
        };
        continue;
      }

      if (!current) continue; // assistant output before any prompt
      current.raw.push(rawRef);
      if (ts) current.endedAt = ts;
      if (typeof message.content === 'string' && message.content.trim() !== '') {
        current.responses.push(message.content);
      }
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
    }

    flush();

    // Every turn is closed: the file is a complete document, so there is no
    // "open turn" the way there is when tailing an append-only log.
    return { turns, checkpointOffset: content.length, openTurn: null };
  }
}
