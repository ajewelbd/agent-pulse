/**
 * Layer 3 — local LLM reverse proxy.
 *
 * Point an agent at it with its base-URL env var and it records what the agent
 * actually sent and what the provider actually reported, including the
 * upstream host (authoritative provider attribution) and provider-reported
 * usage for agents whose logs omit token counts entirely.
 *
 * THE OVERRIDING RULE: never break the agent. This process sits in the path of
 * every model call, so a recording failure, a database outage or a slow insert
 * must not fail, stall, or alter the request. Everything observability-related
 * is best-effort and happens after the bytes are already on their way.
 *
 * SECURITY: this proxy sees every prompt AND every credential — the agent's
 * API key is in the Authorization/x-api-key header it forwards. Therefore:
 *   - it is published as 127.0.0.1:4318 in compose, never 0.0.0.0
 *   - auth headers are stripped before anything is recorded
 *   - bodies pass through the same redaction pipeline as prompts and diffs
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { loadProxyConfig, type ProxyConfig } from './config.js';
import { ProxyDb } from './db.js';
import { isLocalProvider, providerForHost } from './providers.js';
import { extractUsage, modelFromRequest, requestWantsStream, EMPTY_USAGE } from './usage.js';
import { Redactor } from '@agentpulse/schema/redaction';

/**
 * Headers that must never be recorded. The agent's credentials pass through
 * here on every request; storing them would put a live key in the database
 * that the redaction regexes might or might not catch.
 */
const SECRET_HEADERS = new Set([
  'authorization', 'x-api-key', 'api-key', 'cookie', 'set-cookie',
  'proxy-authorization', 'x-goog-api-key', 'openai-organization',
]);

/** Hop-by-hop headers: forwarding these corrupts the connection. */
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length',
]);

function log(message: string): void {
  process.stdout.write(`${new Date().toISOString()} ${message}\n`);
}

function safeHeaders(headers: IncomingMessage['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (SECRET_HEADERS.has(key.toLowerCase())) {
      out[key] = '[REDACTED]';
      continue;
    }
    out[key] = Array.isArray(value) ? value.join(', ') : String(value ?? '');
  }
  return out;
}

async function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > maxBytes) throw new Error(`request body exceeds ${maxBytes} bytes`);
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

/** Resolve the upstream for a request path. */
function resolveUpstream(config: ProxyConfig, path: string): { url: URL; rest: string } {
  // Explicit override: /_u/<name>/... lets one proxy serve several upstreams,
  // which matters because an agent only gives you ONE base-URL env var.
  const match = /^\/_u\/([a-z0-9_-]+)(\/.*)?$/i.exec(path);
  if (match) {
    const name = match[1]!.toLowerCase();
    const base = config.upstreams.get(name);
    if (!base) throw new Error(`unknown upstream "${name}" — add it to PROXY_UPSTREAMS`);
    return { url: new URL(base), rest: match[2] ?? '/' };
  }
  return { url: new URL(config.defaultUpstream), rest: path };
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  config: ProxyConfig,
  db: ProxyDb,
  redactor: Redactor,
): Promise<void> {
  const path = req.url ?? '/';

  if (path === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', upstream: config.defaultUpstream }));
    return;
  }

  const startedAt = new Date();
  let upstream: { url: URL; rest: string };
  try {
    upstream = resolveUpstream(config, path);
  } catch (error) {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'bad upstream' }));
    return;
  }

  const requestBody = await readBody(req, config.maxBodyBytes);
  const requestText = requestBody.toString('utf8');

  const target = new URL(upstream.rest.replace(/^\//, ''), upstream.url.origin + upstream.url.pathname.replace(/\/?$/, '/'));
  target.search = new URL(path, 'http://x').search;

  const forwardHeaders = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (HOP_BY_HOP.has(key.toLowerCase())) continue;
    forwardHeaders.set(key, Array.isArray(value) ? value.join(', ') : String(value ?? ''));
  }
  forwardHeaders.set('host', target.host);

  const providerKey = providerForHost(target.hostname);
  const wantsStream = requestWantsStream(requestText);

  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(target, {
      method: req.method,
      headers: forwardHeaders,
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : requestBody,
      // No timeout on purpose: a long agentic completion can legitimately run
      // for many minutes, and a proxy timeout would look to the user like the
      // model failed.
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'upstream unreachable';
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: `proxy could not reach ${target.host}: ${message}` }));
    void record(db, redactor, config, {
      startedAt, endedAt: new Date(), target, method: req.method ?? 'POST',
      providerKey, statusCode: null, errorMessage: message, isStreaming: wantsStream,
      requestText, responseText: '', contentType: null, providerRequestId: null,
      requestHeaders: safeHeaders(req.headers),
    });
    return;
  }

  const responseHeaders: Record<string, string> = {};
  upstreamResponse.headers.forEach((value, key) => {
    if (HOP_BY_HOP.has(key.toLowerCase())) return;
    responseHeaders[key] = value;
  });
  res.writeHead(upstreamResponse.status, responseHeaders);

  const contentType = upstreamResponse.headers.get('content-type');
  const providerRequestId =
    upstreamResponse.headers.get('request-id') ?? upstreamResponse.headers.get('x-request-id');

  // Tee: forward every chunk to the client the instant it arrives, while
  // keeping a CAPPED copy for usage extraction. Buffering the whole stream
  // before forwarding would destroy the streaming UX the agent depends on.
  const captured: Buffer[] = [];
  let capturedBytes = 0;
  let truncated = false;

  if (upstreamResponse.body) {
    const reader = upstreamResponse.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        res.write(chunk);
        if (capturedBytes < config.maxCaptureBytes) {
          captured.push(chunk);
          capturedBytes += chunk.length;
        } else {
          truncated = true;
        }
      }
    } catch (error) {
      log(`stream aborted: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  res.end();

  const responseText = Buffer.concat(captured).toString('utf8');
  void record(db, redactor, config, {
    startedAt, endedAt: new Date(), target, method: req.method ?? 'POST',
    providerKey, statusCode: upstreamResponse.status,
    errorMessage: truncated ? 'response capture truncated' : null,
    isStreaming: wantsStream || (contentType ?? '').includes('event-stream'),
    requestText, responseText, contentType, providerRequestId,
    requestHeaders: safeHeaders(req.headers),
  });
}

interface RecordInput {
  startedAt: Date;
  endedAt: Date;
  target: URL;
  method: string;
  providerKey: string;
  statusCode: number | null;
  errorMessage: string | null;
  isStreaming: boolean;
  requestText: string;
  responseText: string;
  contentType: string | null;
  providerRequestId: string | null;
  requestHeaders: Record<string, string>;
}

/**
 * Best-effort recording. Runs AFTER the response is fully delivered and never
 * throws into the request path — the agent has already got its answer.
 */
async function record(
  db: ProxyDb,
  redactor: Redactor,
  config: ProxyConfig,
  input: RecordInput,
): Promise<void> {
  try {
    const usage = input.responseText === ''
      ? { ...EMPTY_USAGE }
      : extractUsage(input.contentType, input.responseText);
    const modelRaw = usage.modelRaw ?? modelFromRequest(input.requestText);

    // Content-derived id: replaying a recording must not duplicate it, the
    // same rule as raw_events and the hook receiver.
    const externalId = createHash('sha256')
      .update(input.startedAt.toISOString())
      .update(input.target.toString())
      .update(input.requestText)
      .digest('hex')
      .slice(0, 40);

    await db.recordRequest({
      externalId,
      upstreamHost: input.target.hostname,
      upstreamUrl: input.target.toString(),
      method: input.method,
      path: input.target.pathname,
      providerKey: input.providerKey,
      modelRaw,
      isStreaming: input.isStreaming,
      statusCode: input.statusCode,
      errorMessage: input.errorMessage,
      usage,
      isLocal: isLocalProvider(input.providerKey),
      providerRequestId: input.providerRequestId,
      startedAt: input.startedAt,
      endedAt: input.endedAt,
      redactionVersion: redactor.version,
      // SECURITY: bodies get the same redaction as prompts and diffs, and
      // headers were stripped of credentials before they reached here.
      rawPayload: {
        request: {
          headers: input.requestHeaders,
          body: redactor.redactAndCap(input.requestText, config.maxStoredBodyBytes).text,
        },
        response: {
          status: input.statusCode,
          contentType: input.contentType,
          body: redactor.redactAndCap(input.responseText, config.maxStoredBodyBytes).text,
        },
      },
    });
  } catch (error) {
    // Log and move on. An observability failure must never become an outage
    // for the thing being observed.
    log(`record failed (request was served normally): ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function main(): Promise<void> {
  const config = loadProxyConfig();
  log('proxy starting');
  log(`  default upstream: ${config.defaultUpstream}`);
  for (const [name, url] of config.upstreams) log(`  /_u/${name} → ${url}`);

  const db = new ProxyDb(config.databaseUrl);
  await db.connectWithRetry();
  const redactor = new Redactor(undefined, config.redactionDisabled);
  await db.registerRedactionVersion(redactor.version, redactor.patternHash, redactor.patternCount);
  log(`  database ok, redaction version ${redactor.version}`);

  const server = createServer((req, res) => {
    handle(req, res, config, db, redactor).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : 'proxy error';
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: message }));
      } else {
        res.end();
      }
      log(`request failed: ${message}`);
    });
  });
  // Binds 0.0.0.0 INSIDE the container; compose publishes 127.0.0.1:4318 only.
  server.listen(config.port, '0.0.0.0');
  log(`  listening on :${config.port}`);

  const shutdown = async (signal: string): Promise<void> => {
    log(`${signal} received, shutting down`);
    server.close();
    await db.end();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  process.stderr.write(`\n${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
