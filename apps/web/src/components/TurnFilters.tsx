import Link from 'next/link';
import type { FilterOptions, TurnFilters } from '@/lib/queries';

/**
 * Filter bar.
 *
 * A plain GET form with no client JavaScript: filter state lives in the URL,
 * so every view is linkable, bookmarkable and reproducible — which matters for
 * a tool whose whole purpose is going back and finding what happened.
 */
const field =
  'w-full rounded border border-[--color-line] bg-[--color-surface] px-2 py-1.5 text-sm';

export function TurnFiltersBar({
  options,
  filters,
  total,
}: {
  options: FilterOptions;
  filters: TurnFilters;
  total: number;
}) {
  const hasFilters = Object.entries(filters).some(
    ([key, value]) => key !== 'cursor' && value,
  );

  return (
    <form method="GET" className="mb-4 rounded-lg border border-[--color-line] bg-[--color-surface-2] p-3">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-8">
        <label className="xl:col-span-2 flex flex-col gap-1">
          <span className="text-[11px] uppercase tracking-wide text-[--color-ink-2]">Search</span>
          <input
            type="search"
            name="q"
            defaultValue={filters.q ?? ''}
            placeholder="prompt + response…"
            className={field}
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-[11px] uppercase tracking-wide text-[--color-ink-2]">Project</span>
          <select name="projectId" defaultValue={filters.projectId ?? ''} className={field}>
            <option value="">All</option>
            {options.projects.map((p) => (
              <option key={p.id} value={p.id} title={p.path}>{p.name}</option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-[11px] uppercase tracking-wide text-[--color-ink-2]">Agent</span>
          <select name="agentId" defaultValue={filters.agentId ?? ''} className={field}>
            <option value="">All</option>
            {options.agents.map((a) => (
              <option key={a.id} value={a.id}>{a.key}</option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-[11px] uppercase tracking-wide text-[--color-ink-2]">Provider</span>
          <select name="providerId" defaultValue={filters.providerId ?? ''} className={field}>
            <option value="">All</option>
            {options.providers.map((p) => (
              <option key={p.id} value={p.id}>{p.key}</option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-[11px] uppercase tracking-wide text-[--color-ink-2]">Model</span>
          <select name="model" defaultValue={filters.model ?? ''} className={field}>
            <option value="">All</option>
            {options.models.map((m) => (
              <option key={m.model_normalized} value={m.model_normalized}>{m.model_normalized}</option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-[11px] uppercase tracking-wide text-[--color-ink-2]">Branch</span>
          <select name="branch" defaultValue={filters.branch ?? ''} className={field}>
            <option value="">All</option>
            {options.branches.map((b) => (
              <option key={b.git_branch} value={b.git_branch}>{b.git_branch}</option>
            ))}
          </select>
        </label>

        <div className="flex gap-2">
          <label className="flex flex-1 flex-col gap-1">
            <span className="text-[11px] uppercase tracking-wide text-[--color-ink-2]">From</span>
            <input type="date" name="from" defaultValue={filters.from ?? ''} className={field} />
          </label>
          <label className="flex flex-1 flex-col gap-1">
            <span className="text-[11px] uppercase tracking-wide text-[--color-ink-2]">To</span>
            <input type="date" name="to" defaultValue={filters.to ?? ''} className={field} />
          </label>
        </div>
      </div>

      <div className="mt-3 flex items-center gap-3">
        <button
          type="submit"
          className="rounded bg-[--color-accent] px-3 py-1.5 text-sm font-medium text-white"
        >
          Apply
        </button>
        {hasFilters && (
          <Link href="/" className="text-sm text-[--color-ink-2] hover:text-[--color-accent]">
            Clear
          </Link>
        )}
        <span className="ml-auto text-sm text-[--color-ink-2]">
          {total.toLocaleString('en-US')} turn{total === 1 ? '' : 's'}
        </span>
      </div>
    </form>
  );
}
