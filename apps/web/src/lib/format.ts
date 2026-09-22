/**
 * Display formatting.
 *
 * The recurring rule here: ABSENCE IS NOT ZERO. A null token count means "not
 * reported", a null cost means "no rate for this (provider, model)", and a
 * null exit code means "Layer 1 does not record exit codes". Rendering any of
 * those as 0 or $0.00 would turn a known unknown into a confident lie — which
 * is the exact failure the schema's CHECK constraints exist to prevent, and
 * the UI must not undo it.
 */

export function num(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString('en-US');
}

export function compactNum(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return '—';
  if (Math.abs(n) < 1000) return String(n);
  return n.toLocaleString('en-US', { notation: 'compact', maximumFractionDigits: 1 });
}

export function cost(value: string | null | undefined, source?: string): string {
  if (source === 'free_local') return 'free (local)';
  if (value === null || value === undefined) return 'not priced';
  const n = Number(value);
  if (!Number.isFinite(n)) return 'not priced';
  if (n > 0 && n < 0.01) return '<$0.01';
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function duration(ms: string | number | null | undefined): string {
  if (ms === null || ms === undefined || ms === '') return '—';
  const n = typeof ms === 'number' ? ms : Number(ms);
  if (!Number.isFinite(n)) return '—';
  if (n < 1000) return `${Math.round(n)}ms`;
  const s = n / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${Math.round(s % 60)}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** Always UTC, always explicit — every timestamp in the schema is UTC. */
export function utc(value: Date | string | null | undefined): string {
  if (!value) return '—';
  const d = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return '—';
  return d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z');
}

export function utcShort(value: Date | string | null | undefined): string {
  if (!value) return '—';
  const d = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return '—';
  return d.toISOString().slice(0, 16).replace('T', ' ');
}

/**
 * First segment of an opaque id, for a table cell too narrow for the whole
 * thing. The full value always goes in a `title`, never thrown away — a
 * session id is how a row is matched back to the agent's own transcript file.
 */
export function shortId(value: string | null | undefined, chars = 8): string {
  if (!value) return '—';
  return value.length <= chars ? value : `${value.slice(0, chars)}…`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function asDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const d = typeof value === 'string' ? new Date(value) : value;
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "22 Sep" — UTC, like everything else here. */
export function utcDay(value: Date | string | null | undefined): string {
  const d = asDate(value);
  return d ? `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}` : '—';
}

/** "09:33" — UTC wall clock. */
export function utcClock(value: Date | string | null | undefined): string {
  const d = asDate(value);
  if (!d) return '—';
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

/** "22 Sep 2026 · 04:50 UTC" — the detail-page header stamp. */
export function utcLong(value: Date | string | null | undefined): string {
  const d = asDate(value);
  if (!d) return '—';
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} · ${utcClock(d)} UTC`;
}

/**
 * Claude Code prefixes a turn with an editor block when the file in focus or
 * the selection changed. It is boilerplate the user never typed, and it is long
 * enough to hide the actual request behind it.
 *
 * Verified against the prompt_text actually stored (2026-09-22): these are the
 * only two leading tags in this archive, each is closed, and every one of the
 * 207 carries the real request after it — so this splits rather than replaces.
 * `rest` is what the user wrote; `path` is null when the block named no file.
 */
export function ideContext(
  prompt: string | null | undefined,
): { kind: string; path: string | null; rest: string } | null {
  if (!prompt) return null;
  const match = /^<(ide_opened_file|ide_selection)>([\s\S]*?)<\/\1>/.exec(prompt);
  if (!match) return null;
  // Two phrasings, verified against stored prompts: "opened the file X in the
  // IDE." and "selected the lines N to M from X:". Paths contain spaces on this
  // machine ("/Volumes/Macintosh HD 1/…"), so both captures are non-greedy up
  // to their own terminator rather than to whitespace.
  const body = match[2]!;
  const path =
    /opened the file (.+?) in the IDE\./.exec(body)?.[1] ??
    /from (.+?):\s/.exec(body)?.[1] ??
    null;
  return { kind: match[1]!, path, rest: prompt.slice(match[0].length).trim() };
}

/** Last `keep` path segments, ellipsised at the front — the tail is what identifies a file. */
export function tailPath(path: string, keep = 3): string {
  const parts = path.split('/').filter(Boolean);
  return parts.length <= keep ? path : `…/${parts.slice(-keep).join('/')}`;
}

export function bytes(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 ** 2).toFixed(1)} MB`;
}
