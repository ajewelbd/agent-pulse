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
 * The Claude Code PostToolUse payload shape is unverified on this machine —
 * the hook did not fire mid-session, since settings are read at session start.
 * Rather than guess a schema and write a parser against it, every event is
 * stored for replay; once the real shape is known, the enrichment pass reads
 * it back out of raw_events with no data lost in the meantime.
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
  onEvent?: () => void;
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

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
}
