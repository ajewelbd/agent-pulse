/**
 * Proxy configuration.
 *
 * Kept separate from the collector's config on purpose: the proxy is a
 * separate service so that restarting it to change an upstream never drops the
 * tailer's file watches or checkpoints. Sharing a config module would quietly
 * couple their restart cycles through shared required variables.
 */

export interface ProxyConfig {
  databaseUrl: string;
  port: number;
  /** Where requests go when no /_u/<name> prefix is used. */
  defaultUpstream: string;
  /** Named upstreams, reachable as /_u/<name>/... */
  upstreams: Map<string, string>;
  maxBodyBytes: number;
  /** Cap on how much of a response is buffered for usage extraction. */
  maxCaptureBytes: number;
  /** Cap on how much of a body is stored after redaction. */
  maxStoredBodyBytes: number;
  redactionDisabled: boolean;
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(`${name} is required. See .env.example.`);
  }
  return value;
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got "${raw}"`);
  }
  return value;
}

function assertHttpUrl(value: string, name: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} is not a valid URL: "${value}"`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${name} must be http or https, got "${url.protocol}"`);
  }
  return value;
}

/** Parse `name=url,name=url`. */
function parseUpstreams(raw: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (raw === undefined || raw.trim() === '') return map;
  for (const entry of raw.split(',')) {
    const pair = entry.trim();
    if (pair === '') continue;
    const idx = pair.indexOf('=');
    if (idx <= 0) throw new Error(`PROXY_UPSTREAMS entry "${pair}" is not name=url`);
    const name = pair.slice(0, idx).trim().toLowerCase();
    const url = pair.slice(idx + 1).trim();
    map.set(name, assertHttpUrl(url, `PROXY_UPSTREAMS[${name}]`));
  }
  return map;
}

export function loadProxyConfig(): ProxyConfig {
  const redactionDisabled =
    (process.env['REDACTION_DISABLED'] ?? 'false').toLowerCase() === 'true';
  if (redactionDisabled) {
    process.stderr.write(
      'WARNING: REDACTION_DISABLED=true — full request and response bodies will be stored RAW. ' +
        'Every prompt and every completion, unredacted.\n',
    );
  }

  return {
    databaseUrl: required('DATABASE_URL'),
    port: intEnv('PROXY_PORT', 4318),
    defaultUpstream: assertHttpUrl(
      process.env['PROXY_DEFAULT_UPSTREAM'] ?? 'https://api.anthropic.com',
      'PROXY_DEFAULT_UPSTREAM',
    ),
    upstreams: parseUpstreams(process.env['PROXY_UPSTREAMS']),
    maxBodyBytes: intEnv('PROXY_MAX_BODY_BYTES', 32 * 1024 * 1024),
    maxCaptureBytes: intEnv('PROXY_MAX_CAPTURE_BYTES', 8 * 1024 * 1024),
    maxStoredBodyBytes: intEnv('PROXY_MAX_STORED_BODY_BYTES', 64 * 1024),
    redactionDisabled,
  };
}
