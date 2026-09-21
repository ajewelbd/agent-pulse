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

export function bytes(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 ** 2).toFixed(1)} MB`;
}
