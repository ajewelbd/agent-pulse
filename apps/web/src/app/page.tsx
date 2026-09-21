import Link from 'next/link';
import { TurnFiltersBar } from '@/components/TurnFilters';
import { CostChip, ProviderChip, StatusChip, TokenSourceChip } from '@/components/Chips';
import { HealthBanner } from '@/components/HealthBanner';
import { compactNum, cost, duration, utcShort } from '@/lib/format';
import { countTurns, getFilterOptions, getHealth, listTurns, type TurnFilters } from '@/lib/queries';

export const dynamic = 'force-dynamic';

function readFilters(sp: Record<string, string | string[] | undefined>): TurnFilters {
  const one = (k: string): string | undefined => {
    const v = sp[k];
    const s = Array.isArray(v) ? v[0] : v;
    return s && s !== '' ? s : undefined;
  };
  return {
    projectId: one('projectId'), agentId: one('agentId'), providerId: one('providerId'),
    model: one('model'), branch: one('branch'), from: one('from'), to: one('to'),
    q: one('q'), status: one('status'), cursor: one('cursor'),
  };
}

function nextHref(filters: TurnFilters, cursor: string): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) {
    if (v && k !== 'cursor') params.set(k, String(v));
  }
  params.set('cursor', cursor);
  return `/?${params.toString()}`;
}

export default async function TurnListPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const filters = readFilters(sp);

  const [{ rows, nextCursor }, total, options, health] = await Promise.all([
    listTurns(filters),
    countTurns(filters),
    getFilterOptions(filters.projectId),
    getHealth(),
  ]);

  return (
    <>
      <HealthBanner health={health} />
      <TurnFiltersBar options={options} filters={filters} total={total} />

      {rows.length === 0 ? (
        <p className="rounded-lg border border-[--color-line] p-8 text-center text-sm text-[--color-ink-2]">
          No turns match these filters.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-[--color-line]">
          <table className="w-full min-w-[1100px] text-sm">
            <thead className="bg-[--color-surface-2] text-left text-[11px] uppercase tracking-wide text-[--color-ink-2]">
              <tr>
                <th className="px-3 py-2 font-medium">Started (UTC)</th>
                <th className="px-3 py-2 font-medium">Project</th>
                <th className="px-3 py-2 font-medium">Prompt</th>
                <th className="px-3 py-2 font-medium">Model</th>
                <th className="px-3 py-2 text-right font-medium">In</th>
                <th className="px-3 py-2 text-right font-medium">Out</th>
                <th className="px-3 py-2 text-right font-medium">Cost</th>
                <th className="px-3 py-2 text-right font-medium">Dur</th>
                <th className="px-3 py-2 text-right font-medium">Cmds</th>
                <th className="px-3 py-2 text-right font-medium">Files</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.id} className="border-t border-[--color-line] align-top hover:bg-[--color-surface-2]">
                  <td className="whitespace-nowrap px-3 py-2 mono text-xs text-[--color-ink-2]">
                    <Link href={`/turns/${t.id}`} className="hover:text-[--color-accent]">
                      {utcShort(t.started_at)}
                    </Link>
                    <div className="mt-1 flex flex-wrap gap-1">
                      <StatusChip status={t.status} />
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <div className="font-medium">{t.project_name}</div>
                    <div className="mt-0.5 text-xs text-[--color-ink-2]">{t.agent_key}</div>
                    {t.git_branch && (
                      <div className="mono mt-0.5 truncate text-[11px] text-[--color-ink-2]" title={t.git_branch}>
                        {t.git_branch}
                      </div>
                    )}
                  </td>
                  <td className="max-w-[420px] px-3 py-2">
                    <Link href={`/turns/${t.id}`} className="line-clamp-3 hover:text-[--color-accent]">
                      {t.prompt_preview ?? <span className="text-[--color-ink-2]">(no prompt text)</span>}
                    </Link>
                  </td>
                  <td className="px-3 py-2">
                    <div className="mono text-xs">{t.model_raw ?? '—'}</div>
                    <div className="mt-1 flex flex-wrap gap-1">
                      <ProviderChip provider={t.provider_key} source={t.provider_source} />
                    </div>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-right mono text-xs">
                    {compactNum(t.total_input_tokens)}
                    <div className="mt-1"><TokenSourceChip source={t.token_source} /></div>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-right mono text-xs">
                    {compactNum(t.output_tokens)}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-right mono text-xs">
                    {cost(t.cost_usd, t.cost_source)}
                    <div className="mt-1"><CostChip source={t.cost_source} /></div>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-right mono text-xs text-[--color-ink-2]">
                    {duration(t.duration_ms)}
                  </td>
                  <td className="px-3 py-2 text-right mono text-xs">{t.tool_call_count}</td>
                  <td className="px-3 py-2 text-right mono text-xs">{t.file_change_count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {nextCursor && (
        <div className="mt-4 flex justify-center">
          <Link
            href={nextHref(filters, nextCursor)}
            className="rounded border border-[--color-line] px-4 py-2 text-sm hover:border-[--color-accent] hover:text-[--color-accent]"
          >
            Load older turns →
          </Link>
        </div>
      )}
    </>
  );
}
