/**
 * How a turn's cost was arrived at, reconstructed for display.
 *
 * This is a DELIBERATE second implementation of the collector's
 * `computeCost()` (apps/collector/src/ingest.ts), and it has to stay a mirror
 * of it, line for line:
 *
 *   - a NULL rate contributes 0, it does not fall back to the input rate;
 *   - a NULL token count contributes 0;
 *   - cache writes the provider did not split into 5m/1h are billed at the 5m
 *     rate, which is the cheaper of the two, so this never over-bills.
 *
 * It exists because the alternative — showing the four stored sub-totals and
 * calling them "the breakdown" — cannot be checked against anything. Computing
 * the parts here and comparing their sum to the stored `cost_usd` makes the
 * claim falsifiable, and `reconcile()` is what reports when it fails. Nothing
 * here ever replaces the stored cost: a price change inserts a new
 * `model_pricing` row, it does not rewrite what past turns cost.
 */

/** The columns `getCostInputs()` selects. snake_case: this is the query boundary. */
export interface CostInputsRow {
  input_tokens: string | null;
  output_tokens: string | null;
  cache_read_tokens: string | null;
  cache_write_tokens: string | null;
  cache_write_5m_tokens: string | null;
  cache_write_1h_tokens: string | null;
  input_usd_per_mtok: string | null;
  output_usd_per_mtok: string | null;
  cache_read_usd_per_mtok: string | null;
  cache_write_5m_usd_per_mtok: string | null;
  cache_write_1h_usd_per_mtok: string | null;
}

/** Stable identity for a line of working. The label is display text; this is not. */
export type CostPartKey =
  | 'input'
  | 'cache_read'
  | 'cache_write_5m'
  | 'cache_write_1h'
  | 'cache_write_unsplit'
  | 'output';

export interface CostPart {
  key: CostPartKey;
  label: string;
  tokens: number;
  /** USD per million tokens. NULL means the rate row does not price this. */
  rate: number | null;
  usd: number;
  /** Why this line is not simply "tokens × rate", when it is not. */
  note?: string;
}

export interface CostWorking {
  parts: CostPart[];
  /** Sum of the parts, in JS floats — the same arithmetic the collector ran. */
  total: number;
}

/** pg returns bigint and numeric as strings; absent stays absent. */
function n(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** The collector's rule, verbatim: no tokens or no rate means no charge. */
function perMillion(tokens: number | null, rate: number | null): number {
  return tokens === null || rate === null ? 0 : (tokens / 1_000_000) * rate;
}

/**
 * The lines of arithmetic behind one turn's cost.
 *
 * Returns null when the turn was never priced — there is no working to show
 * for a sum that was never computed, and a table of zeroes would read as
 * "this turn cost nothing".
 */
export function costWorking(row: CostInputsRow | null | undefined): CostWorking | null {
  if (!row) return null;
  const inputRate = n(row.input_usd_per_mtok);
  const outputRate = n(row.output_usd_per_mtok);
  if (inputRate === null && outputRate === null) return null;

  const cacheReadRate = n(row.cache_read_usd_per_mtok);
  const write5mRate = n(row.cache_write_5m_usd_per_mtok);
  const write1hRate = n(row.cache_write_1h_usd_per_mtok);

  const input = n(row.input_tokens);
  const output = n(row.output_tokens);
  const cacheRead = n(row.cache_read_tokens);
  const write5m = n(row.cache_write_5m_tokens);
  const write1h = n(row.cache_write_1h_tokens);

  // Cache-write tokens the provider reported as a total without saying which
  // bucket they fell in. Charged at the 5m rate — see the header.
  const unsplit = Math.max(0, (n(row.cache_write_tokens) ?? 0) - ((write5m ?? 0) + (write1h ?? 0)));

  const parts: CostPart[] = [
    { key: 'input', label: 'Input (uncached)', tokens: input ?? 0, rate: inputRate, usd: perMillion(input, inputRate) },
    { key: 'cache_read', label: 'Cache read', tokens: cacheRead ?? 0, rate: cacheReadRate, usd: perMillion(cacheRead, cacheReadRate) },
    { key: 'cache_write_5m', label: 'Cache write 5m', tokens: write5m ?? 0, rate: write5mRate, usd: perMillion(write5m, write5mRate) },
    { key: 'cache_write_1h', label: 'Cache write 1h', tokens: write1h ?? 0, rate: write1hRate, usd: perMillion(write1h, write1hRate) },
    { key: 'output', label: 'Output', tokens: output ?? 0, rate: outputRate, usd: perMillion(output, outputRate) },
  ];

  if (unsplit > 0) {
    parts.splice(4, 0, {
      key: 'cache_write_unsplit',
      label: 'Cache write (bucket not reported)',
      tokens: unsplit,
      rate: write5mRate,
      usd: perMillion(unsplit, write5mRate),
      note: 'billed at the 5m rate, the cheaper of the two',
    });
  }

  return { parts, total: parts.reduce((sum, p) => sum + p.usd, 0) };
}

/** Sum the lines of working that make up one bar segment. */
export function sumParts(working: CostWorking, keys: CostPartKey[]): number {
  return working.parts.reduce((sum, p) => (keys.includes(p.key) ? sum + p.usd : sum), 0);
}

/**
 * Does the working reproduce what was stored?
 *
 * The stored value is `total.toFixed(8)` from the collector, so an exact match
 * is expected and anything else means the two implementations have drifted —
 * a new pricing column the dashboard does not know about, say. The tolerance
 * is one unit in the stored 8th decimal place, for the rounding itself.
 */
export function reconcile(
  working: CostWorking | null,
  storedCostUsd: string | null,
): { matches: boolean; stored: number; difference: number } | null {
  const stored = n(storedCostUsd);
  if (working === null || stored === null) return null;
  const difference = working.total - stored;
  return { matches: Math.abs(difference) <= 1e-8, stored, difference };
}

/**
 * A cost with enough precision to check the arithmetic by eye.
 *
 * `cost()` in format.ts is the reading view and collapses anything under a
 * cent to "<$0.01"; a line of working that said "<$0.01" four times and then
 * a total would not add up on the page.
 */
export function costExact(usd: number): string {
  if (!Number.isFinite(usd)) return '—';
  if (usd === 0) return '$0';
  return `$${usd.toFixed(usd < 0.01 ? 6 : 4)}`;
}

/** "$15.00 / Mtok", or the honest absence. */
export function rate(usdPerMtok: number | null): string {
  if (usdPerMtok === null) return 'not priced';
  return `$${usdPerMtok.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} / Mtok`;
}

/**
 * How long a rate row was in force, in words.
 *
 * Every seeded row in this database uses the Unix epoch as `effective_from`,
 * meaning "this has always applied" — migration 003 has no real start dates to
 * give. Printing that literally read as "in force from 1970-01-01", which
 * looks like a recorded fact and is not one. An epoch start is reported as
 * what it is: no start date.
 */
export function rateWindow(
  from: Date | string | null | undefined,
  to: Date | string | null | undefined,
): string {
  const at = (v: Date | string | null | undefined): Date | null => {
    if (!v) return null;
    const d = v instanceof Date ? v : new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  };
  const day = (d: Date): string => d.toISOString().slice(0, 10);
  const start = at(from);
  const end = at(to);
  const bounded = start !== null && start.getTime() > 0;

  if (bounded && end) return `in force ${day(start)} to ${day(end)}`;
  if (bounded) return `in force from ${day(start)}`;
  if (end) return `in force until ${day(end)}`;
  return 'with no start or end date recorded, so it applies to every turn on this model';
}
