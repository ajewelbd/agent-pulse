import Link from 'next/link';
import { TurnFiltersBar } from '@/components/TurnFilters';
import { CostChip, ProviderChip, StatusDot } from '@/components/Chips';
import { HealthBanner } from '@/components/HealthBanner';
import { Pagination } from '@/components/Pagination';
import { StatTiles } from '@/components/StatTiles';
import { IconChevronDown, IconFile, IconTerminal, IconWarning } from '@/components/icons';
import { readFilters, sortToggleHref, turnHref } from '@/lib/filters';
import { compactNum, cost, duration, shortId, utcClock, utcDay } from '@/lib/format';
import {
  PAGE_SIZE,
  countTurns,
  getFilterOptions,
  getHealth,
  listTurns,
  readPage,
  type TurnListRow,
} from '@/lib/queries';

export const dynamic = 'force-dynamic';

/** A duration this long in a single turn is almost always a turn left open. */
const LONG_TURN_MS = 60 * 60 * 1000;

const TH = 'px-3 py-2.5 text-left font-medium';

/**
 * The prompt cell.
 *
 * The editor-focus block is already stripped in SQL, so what lands here is what
 * the user actually typed. The badge is kept because that block was part of the
 * turn — it is context the model was paid to read, and a row that hides it
 * entirely would understate why the turn cost what it did.
 */
function PromptCell({ turn }: { turn: TurnListRow }) {
  const text = turn.prompt_preview?.trim();
  return (
    <span className="flex items-baseline gap-2">
      {turn.had_ide_context && (
        <span
          title="This turn was also given the file open in the editor at the time."
          className="mono shrink-0 rounded border border-line bg-surface-2 px-1.5 py-0.5 text-[10px] text-ink-3"
        >
          ide context
        </span>
      )}
      {text ? (
        <span className="min-w-0 truncate">{text}</span>
      ) : (
        <span className="text-ink-3">(no prompt text)</span>
      )}
    </span>
  );
}

export default async function TurnListPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const filters = readFilters(await searchParams);

  // The count has to come first: it is what bounds the page number, and asking
  // for page 900 of a 52-page result must land on the last page, not on empty.
  const [total, options, health] = await Promise.all([
    countTurns(filters),
    getFilterOptions(filters.projectId, filters.sessionId),
    getHealth(),
  ]);

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = readPage(filters.page, pageCount);
  const offset = (page - 1) * PAGE_SIZE;
  const rows = await listTurns(filters, offset);

  const maxCost = Math.max(0, ...rows.map((r) => Number(r.cost_usd ?? 0)));

  return (
    <>
      <HealthBanner health={health} />
      <StatTiles rows={rows} />
      <TurnFiltersBar options={options} filters={filters} total={total} />

      <section className="card overflow-hidden">
        <div className="flex items-center gap-3 border-b border-line px-4 py-3">
          <h2 className="text-sm font-semibold">Turns</h2>
          <span className="mono rounded-md border border-line bg-surface-2 px-2 py-0.5 text-[11px] text-ink-2">
            {total.toLocaleString('en-US')} results
          </span>
          <Link
            href={sortToggleHref(filters)}
            title="Sort by start time. Click to reverse."
            className="ml-auto flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-xs text-ink-2 hover:bg-surface-2 hover:text-ink"
          >
            <IconChevronDown className={`h-3.5 w-3.5 ${filters.sort === 'oldest' ? 'rotate-180' : ''}`} />
            {filters.sort === 'oldest' ? 'Oldest first' : 'Newest first'}
          </Link>
        </div>

        {rows.length === 0 ? (
          <p className="px-4 py-16 text-center text-sm text-ink-2">No turns match these filters.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1100px] text-sm">
              <thead>
                <tr className="eyebrow border-b border-line">
                  <th className={TH}>Started</th>
                  <th className={TH}>Project</th>
                  <th className={TH}>Prompt</th>
                  <th className={TH}>Model</th>
                  <th className={`${TH} text-right`}>In</th>
                  <th className={`${TH} text-right`}>Out</th>
                  <th className={`${TH} text-right`}>Cost</th>
                  <th className={`${TH} text-right`}>Duration</th>
                  <th className={`${TH} text-right`}>Activity</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((t) => {
                  const long = Number(t.duration_ms ?? 0) >= LONG_TURN_MS;
                  const costPct = maxCost > 0 ? (Number(t.cost_usd ?? 0) / maxCost) * 100 : 0;
                  const href = turnHref(t.id, filters, page);
                  return (
                    <tr
                      key={t.id}
                      className="group relative border-b border-line-soft align-top last:border-0 hover:bg-surface-2"
                    >
                      <td className="relative px-3 py-3 whitespace-nowrap">
                        <span className="absolute inset-y-0 left-0 w-0.5 bg-accent opacity-0 group-hover:opacity-100" />
                        <Link href={href} className="mono text-xs text-ink">
                          {utcDay(t.started_at)} · {utcClock(t.started_at)}
                        </Link>
                        <div className="mt-1.5">
                          <StatusDot status={t.status} />
                        </div>
                      </td>

                      <td className="px-3 py-3">
                        {/* Fixed width, not auto: a long branch name otherwise
                            widens this column enough to push Activity off. */}
                        <div className="w-[11rem]">
                          <div className="truncate text-[13px] font-medium">{t.project_name}</div>
                          <div className="mono mt-0.5 truncate text-[11px] text-ink-3" title={t.project_path}>
                            {t.agent_key}
                            {t.git_branch && ` · ${t.git_branch}`}
                          </div>
                        </div>
                      </td>

                      {/*
                        The session id is truncated for width only — the full
                        value is in the title, and it is what names the agent's
                        own transcript file, so it is the handle for checking a
                        row against the raw source.
                      */}
                      {/* The width lives on this inner div, not the <td>: in
                          auto table layout a cell's max-width is ignored, so
                          the truncation has to happen inside a block element
                          that actually has one. */}
                      <td className="px-3 py-3">
                        <div className="w-[22rem] max-w-full 2xl:w-[32rem]">
                          <Link href={href} className="block text-[13px] group-hover:text-ink">
                            <PromptCell turn={t} />
                          </Link>
                          <div className="mono mt-1 text-[11px] text-ink-3" title={t.external_session_id}>
                            {shortId(t.external_session_id)} · turn #{t.seq}
                          </div>
                        </div>
                      </td>

                      <td className="px-3 py-3">
                        <div className="mono text-[11px] whitespace-nowrap">{t.model_raw ?? '—'}</div>
                        <div className="mt-1.5">
                          <ProviderChip provider={t.provider_key} source={t.provider_source} />
                        </div>
                      </td>

                      <td className="mono px-3 py-3 text-right text-xs whitespace-nowrap">
                        {compactNum(t.total_input_tokens)}
                      </td>
                      <td className="mono px-3 py-3 text-right text-xs whitespace-nowrap">
                        {compactNum(t.output_tokens)}
                      </td>

                      <td className="px-3 py-3 text-right whitespace-nowrap">
                        <div className="mono text-xs font-medium">{cost(t.cost_usd, t.cost_source)}</div>
                        {/* Relative to the most expensive turn on this page — a
                            shape cue for scanning, not a scale to read off. */}
                        <div className="mt-1.5 ml-auto h-0.5 w-14 rounded-full bg-line">
                          <div className="h-0.5 rounded-full bg-accent" style={{ width: `${costPct}%` }} />
                        </div>
                        <div className="mt-1 flex justify-end">
                          <CostChip source={t.cost_source} />
                        </div>
                      </td>

                      <td
                        className={`mono px-3 py-3 text-right text-xs whitespace-nowrap ${long ? 'text-warn' : 'text-ink-2'}`}
                        title={long ? 'Over an hour of wall clock — usually a turn left open, not an hour of work.' : undefined}
                      >
                        {duration(t.duration_ms)}
                      </td>

                      <td className="px-3 py-3 whitespace-nowrap">
                        <div className="mono flex items-center justify-end gap-3 text-xs text-ink-2">
                          <span className="flex items-center gap-1" title={`${t.tool_call_count} commands`}>
                            <IconTerminal className="h-3.5 w-3.5 text-ink-3" />
                            {t.tool_call_count}
                          </span>
                          <span className="flex items-center gap-1" title={`${t.file_change_count} files changed`}>
                            <IconFile className="h-3.5 w-3.5 text-ink-3" />
                            {t.file_change_count}
                          </span>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-x-4 gap-y-3 border-t border-line px-4 py-3">
          <p className="text-xs text-ink-2">
            Showing{' '}
            <span className="mono text-ink">
              {rows.length === 0 ? 0 : offset + 1}–{offset + rows.length}
            </span>{' '}
            of <span className="mono text-ink">{total.toLocaleString('en-US')}</span> turns
          </p>
          <p className="flex items-center gap-1.5 text-xs text-ink-3">
            <IconWarning className="h-3.5 w-3.5" />
            dashed border = inferred value
          </p>
          <div className="ml-auto">
            <Pagination filters={filters} page={page} pageCount={pageCount} />
          </div>
        </div>
      </section>
    </>
  );
}
