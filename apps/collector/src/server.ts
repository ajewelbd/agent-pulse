/**
 * Hook receiver (Layer 2) and health endpoint.
 *
 * SECURITY: this listener binds 0.0.0.0 INSIDE the container, which is correct
 * — it is published as 127.0.0.1:4317 in compose, so it is not reachable from
 * the LAN. The shared-secret header is required on every data endpoint anyway:
 * any local process could otherwise post fabricated turns into your history,
 * or (worse) read it back.
 *
 * Hook payloads land in raw_events verbatim and are NOT yet folded into turns.
 * Storing them unparsed was the right call and still is: the payload shape is
 * now known (docs/hook-payloads.md, read out of claude-code 2.1.278 and then
 * confirmed against live events) and storing it whole means the enrichment
 * pass can be written later without re-capturing anything.
 *
 * Exit codes ARE recoverable, contrary to an earlier note here that said they
 * lived only on an OpenTelemetry span — the function that would set that span
 * attribute is a no-op in the shipped binary. The working rule is observed:
 * PostToolUseFailure carries `error` beginning "Exit code N". See migration 012.
 *
 * Also carried, and worth the pass: `duration_ms` (a real measurement,
 * excluding permission-prompt and hook time, unlike the derived upper bound
 * Layer 1 gives), `tool_use_id` (an exact join key instead of heuristic
 * matching), and `agent_id` (present only inside a subagent, which is the
 * clean answer to sub-agent double counting).
 *
 * One trap for whoever writes that pass: PostToolUse "may run concurrently for
 * parallel tool calls" per its own schema description, so events must not be
 * assumed to arrive in tool order. Sequence from the payload, not arrival.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { Db } from './db.js';

const MAX_BODY_BYTES = 4 * 1024 * 1024;

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  // timingSafeEqual throws on length mismatch, which would itself leak length.
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX_BODY_BYTES) throw new Error('payload too large');
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export interface HookServerOptions {
  port: number;
  sharedSecret: string;
  db: Db;
  agentIdFor: (agentKey: string) => Promise<number>;
  /** Stamped on stored compactions — the pattern set this collector runs. */
  redactionVersion: number;
  onEvent?: () => void;
}

/** The subset of a compaction POST this endpoint requires. */
interface CompactionBody {
  requestId?: unknown;
  turnId?: unknown;
  provider?: unknown;
  model?: unknown;
  length?: unknown;
  parts?: unknown;
  summarized?: unknown;
  reason?: unknown;
  output?: unknown;
  inputTokens?: unknown;
  outputTokens?: unknown;
  estimatedInputTokens?: unknown;
}

const LENGTHS = new Set(['brief', 'standard', 'detailed']);
const PARTS = new Set(['prompt', 'response', 'commands', 'files', 'diffs']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validate a compaction before it reaches the database.
 *
 * Everything here is also a CHECK constraint in migration 013, so this is not
 * the only guard — it exists so a malformed post comes back as a 400 naming the
 * field, rather than as a constraint violation the caller has to decode.
 *
 * Returns the error message, or null when the body is good.
 */
function badCompaction(b: CompactionBody): string | null {
  if (typeof b.requestId !== 'string' || !UUID_RE.test(b.requestId)) return 'requestId must be a uuid';
  if (typeof b.turnId !== 'string' || !/^\d+$/.test(b.turnId)) return 'turnId must be numeric';
  if (typeof b.provider !== 'string' || b.provider === '') return 'provider is required';
  if (typeof b.model !== 'string' || b.model === '') return 'model is required';
  if (typeof b.length !== 'string' || !LENGTHS.has(b.length)) return 'length must be brief, standard or detailed';
  if (!Array.isArray(b.parts) || b.parts.length === 0) return 'parts must be a non-empty array';
  if (!b.parts.every((p) => typeof p === 'string' && PARTS.has(p))) return 'parts contains an unknown value';
  if (typeof b.summarized !== 'boolean') return 'summarized must be a boolean';
  // The schema's own rule, restated where it can be explained: an unsummarised
  // row with no reason leaves the history panel unable to say why.
  if (!b.summarized && typeof b.reason !== 'string') return 'reason is required when summarized is false';
  if (typeof b.output !== 'string' || b.output === '') return 'output is required';
  if (typeof b.estimatedInputTokens !== 'number') return 'estimatedInputTokens must be a number';
  return null;
}

/** A reported count, or null. NEVER 0 for "not reported". */
function optionalCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

export function startHookServer(options: HookServerOptions): Server {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handle(req, res, options).catch((error: unknown) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'internal error' }));
    });
  });
  server.listen(options.port, '0.0.0.0');
  return server;
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  options: HookServerOptions,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');

  // Health is unauthenticated on purpose so the compose healthcheck works, and
  // it deliberately reveals nothing about content.
  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  const provided = req.headers['x-aiuo-secret'];
  if (typeof provided !== 'string' || !safeEqual(provided, options.sharedSecret)) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'missing or invalid X-Aiuo-Secret' }));
    return;
  }

  if (url.pathname === '/v1/hooks' && req.method === 'POST') {
    const body = await readBody(req);
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'body is not valid JSON' }));
      return;
    }

    const agentKey = url.searchParams.get('agent') ?? 'claude_code';
    const eventName = url.searchParams.get('event') ?? 'unknown';
    const agentId = await options.agentIdFor(agentKey);

    const obj = (typeof payload === 'object' && payload !== null ? payload : {}) as Record<string, unknown>;
    const sessionExternalId =
      typeof obj['session_id'] === 'string' ? obj['session_id']
      : typeof obj['sessionId'] === 'string' ? obj['sessionId']
      : null;

    // Content-derived id so a hook retry is idempotent, exactly like the tailer.
    const { createHash } = await import('node:crypto');
    const externalId = `${eventName}:${createHash('sha256').update(body).digest('hex').slice(0, 32)}`;

    const inserted = await options.db.withTransaction((client) =>
      options.db.insertRawEvents(client, [
        {
          source: `${agentKey}:hooks`,
          externalId,
          agentId,
          layer: 'hooks',
          payload,
          sessionExternalId,
          // Hook events carry HOST paths already — the collector must not
          // store a translated one. Left null here; the enrichment pass
          // resolves it once the payload shape is confirmed.
          projectPath: null,
          occurredAt: new Date(),
        },
      ]),
    );

    options.onEvent?.();
    res.writeHead(202, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ accepted: true, stored: inserted }));
    return;
  }

  /**
   * A compaction the dashboard produced.
   *
   * This is the one endpoint that stores something the operator did rather than
   * something an agent did, and it exists here rather than in apps/web because
   * the dashboard's pool is read-only and stays that way.
   *
   * Same shared secret as the hook endpoint, for the same reason: any local
   * process could otherwise write into this history — or, by posting and
   * reading back, learn what is in it.
   */
  if (url.pathname === '/v1/compactions' && req.method === 'POST') {
    const body = await readBody(req);
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'body is not valid JSON' }));
      return;
    }

    const c = (typeof payload === 'object' && payload !== null ? payload : {}) as CompactionBody;
    const problem = badCompaction(c);
    if (problem) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: problem }));
      return;
    }

    let stored: boolean;
    try {
      stored = await options.db.insertCompaction({
        requestId: c.requestId as string,
        turnId: c.turnId as string,
        provider: c.provider as string,
        model: c.model as string,
        length: c.length as string,
        parts: c.parts as string[],
        summarized: c.summarized as boolean,
        reason: typeof c.reason === 'string' ? c.reason : null,
        output: c.output as string,
        inputTokens: optionalCount(c.inputTokens),
        outputTokens: optionalCount(c.outputTokens),
        estimatedInputTokens: c.estimatedInputTokens as number,
        redactionVersion: options.redactionVersion,
      });
    } catch (error) {
      // A turn_id naming no turn is the caller's mistake, not a server fault —
      // the tray can outlive the row it points at.
      const message = error instanceof Error ? error.message : 'insert failed';
      const isFk = /foreign key|violates foreign key constraint/i.test(message);
      res.writeHead(isFk ? 400 : 500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: isFk ? `no turn ${String(c.turnId)}` : message }));
      return;
    }

    res.writeHead(stored ? 201 : 200, { 'content-type': 'application/json' });
    // `stored: false` means this request_id was already recorded — a retry, not
    // a failure, and the caller should treat it as success.
    res.end(JSON.stringify({ accepted: true, stored }));
    return;
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
}
