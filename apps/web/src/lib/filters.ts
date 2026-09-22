import type { TurnFilters } from './queries';

/**
 * Filter state lives in the URL, not in component state.
 *
 * That is what makes every view linkable, bookmarkable and reproducible —
 * which matters for a tool whose whole purpose is going back and finding what
 * happened. It also means the detail page can be told which list it was opened
 * from, so it can say where in that list the turn sits.
 */
/** Everything that narrows the list. `sort` is deliberately not one of these. */
export const FILTER_KEYS = [
  'projectId', 'sessionId', 'agentId', 'providerId', 'model', 'branch', 'from', 'to', 'q', 'status',
] as const;

/** Carried through links alongside the filters, but not a filter itself. */
const CARRIED_KEYS = [...FILTER_KEYS, 'sort'] as const;

export function readFilters(sp: Record<string, string | string[] | undefined>): TurnFilters {
  const one = (k: string): string | undefined => {
    const v = sp[k];
    const s = Array.isArray(v) ? v[0] : v;
    return s && s !== '' ? s : undefined;
  };
  const filters: TurnFilters = { page: one('page') };
  for (const key of CARRIED_KEYS) filters[key] = one(key);
  return filters;
}

/** True when anything narrows the list — page position does not count. */
export function hasActiveFilters(filters: TurnFilters): boolean {
  return FILTER_KEYS.some((k) => filters[k]);
}

/** Serialise filters back to a query string, optionally moving to a page. */
export function filterQuery(filters: TurnFilters, page?: number): string {
  const params = new URLSearchParams();
  for (const key of CARRIED_KEYS) {
    const value = filters[key];
    if (value) params.set(key, value);
  }
  if (page !== undefined && page > 1) params.set('page', String(page));
  return params.toString();
}

/** The same list with the sort flipped — what the "Newest first" pill links to. */
export function sortToggleHref(filters: TurnFilters): string {
  const next: TurnFilters = { ...filters, sort: filters.sort === 'oldest' ? undefined : 'oldest' };
  const qs = filterQuery(next);
  return qs ? `/?${qs}` : '/';
}

/** `/?…` for the list, with an empty filter set collapsing to a bare `/`. */
export function listHref(filters: TurnFilters, page?: number): string {
  const qs = filterQuery(filters, page);
  return qs ? `/?${qs}` : '/';
}

/**
 * A turn link that carries the filter it was opened from, so the detail page
 * can place it ("4 of 464 in this filter") and link back to the same list.
 */
export function turnHref(id: string, filters?: TurnFilters, page?: number): string {
  if (!filters) return `/turns/${id}`;
  const qs = filterQuery(filters, page);
  return qs ? `/turns/${id}?${qs}` : `/turns/${id}`;
}
