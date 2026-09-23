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

/**
 * A token count, respecting `token_source`.
 *
 * `turns.total_input_tokens` is generated with `coalesce(…, 0)`, so a turn
 * whose usage was never reported has 0 there rather than NULL — and `num()`
 * cannot tell that apart from a genuine zero. Before this existed, all 16
 * unreported turns in this archive rendered "0 in", which is exactly the claim
 * the schema's CHECK constraints exist to prevent. `token_source = 'unknown'`
 * is the flag that distinguishes them; it is set by the adapter only when no
 * assistant record in the turn carried usage at all.
 */
export function tokenCount(
  value: string | number | null | undefined,
  source: string | null | undefined,
  compact = true,
): string {
  if (source === 'unknown') return '—';
  return compact ? compactNum(value) : num(value);
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
