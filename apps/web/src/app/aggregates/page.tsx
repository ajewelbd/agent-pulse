import { compactNum, cost, num } from '@/lib/format';
import { readFilters } from '@/lib/filters';
import { HealthBanner } from '@/components/HealthBanner';
import { InfoTip, TipNote, TipTitle } from '@/components/InfoTip';
import { Chip } from '@/components/Chips';
import {
  aggregateBy,
  getHealth,
  providerModelBreakdown,
  type AggregateRow,
} from '@/lib/queries';

export const dynamic = 'force-dynamic';

/** Inline bar so relative magnitude is readable without a charting library. */
function Bar({ value, max }: { value: number; max: number }) {
  const pct = max > 0 ? Math.max(1, Math.round((value / max) * 100)) : 0;
  return (
    <div className="mt-1 h-1 w-full rounded bg-line">
      <div className="h-1 rounded bg-accent" style={{ width: `${pct}%` }} />
    </div>
  );
}

/**
 * What a cost column in a rollup actually is.
 *
 * Every row in a table is computed the same way, so this sits on the column
 * header rather than on each row — the per-row specific, how many of its turns
 * had no rate, is already in the Turns cell beside it.
 */
function GroupCostTip({ grouping }: { grouping: string }) {
  return (
    <InfoTip label="How these costs were calculated" width={300}>
      <TipTitle>How these costs were calculated</TipTitle>
      <p className="text-[11px] leading-relaxed text-ink-2">
        <span className="mono">sum(cost_usd)</span> over the turns in each {grouping}. Nothing is
        recomputed here: each turn was priced once at ingest, from its own token counts and the
        rate in force when it ran. Open any turn to see that turn&apos;s working.
      </p>
      <p className="mt-2 text-[11px] leading-relaxed text-ink-2">
        Turns with no rate are counted in <strong>Turns</strong> but contribute nothing to{' '}
        <strong>Cost</strong>, so any row flagged <span className="text-warn">unpriced</span> shows
        a floor rather than its real spend.
      </p>
      <TipNote>
        List price, from seeded rates. Batch discounts and contract rates are not modelled, and
        none of it has been checked against an invoice.
      </TipNote>
    </InfoTip>
  );
}

function AggregateTable({
  title,
  rows,
  note,
  grouping,
}: {
  title: string;
  rows: AggregateRow[];
  note?: string;
  grouping: string;
}) {
  const maxCost = Math.max(0, ...rows.map((r) => Number(r.cost_usd ?? 0)));

  return (
    <section className="card overflow-hidden">
      <h2 className="border-b border-line bg-surface-2 px-3 py-2 text-sm font-semibold">
        {title}
        {note && <span className="ml-2 font-normal text-xs text-ink-2">{note}</span>}
      </h2>
      {rows.length === 0 ? (
        <p className="px-3 py-4 text-sm text-ink-2">No data.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-[11px] uppercase tracking-wide text-ink-2">
              <tr className="border-b border-line">
                <th className="px-3 py-1.5 font-medium">&nbsp;</th>
                <th className="px-3 py-1.5 text-right font-medium">Turns</th>
                <th className="px-3 py-1.5 text-right font-medium">Input</th>
                <th className="px-3 py-1.5 text-right font-medium">Output</th>
                <th className="px-3 py-1.5 text-right font-medium">
                  <span className="inline-flex items-center gap-1.5">
                    Cost
                    <GroupCostTip grouping={grouping} />
                  </span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.label} className="border-b border-line last:border-0">
                  <td className="px-3 py-1.5">
                    <span className="mono text-xs">{r.label}</span>
                    <Bar value={Number(r.cost_usd ?? 0)} max={maxCost} />
                  </td>
                  <td className="px-3 py-1.5 text-right mono text-xs">
                    {num(r.turns)}
                    {Number(r.unpriced_turns) > 0 && (
                      <span
                        className="ml-1 text-warn"
                        title={`${r.unpriced_turns} of these have no price, so the cost shown excludes them`}
                      >
                        ({r.unpriced_turns} unpriced)
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-1.5 text-right mono text-xs">{compactNum(r.input_tokens)}</td>
                  <td className="px-3 py-1.5 text-right mono text-xs">{compactNum(r.output_tokens)}</td>
                  <td className="px-3 py-1.5 text-right mono text-xs">{cost(r.cost_usd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export default async function AggregatesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const filters = readFilters(await searchParams);

  const [byDay, byProject, byAgent, byProvider, byModel, byBranch, providerModel, health] =
    await Promise.all([
      aggregateBy('day', filters),
      aggregateBy('project', filters),
      aggregateBy('agent', filters),
      aggregateBy('provider', filters),
      aggregateBy('model', filters),
      aggregateBy('branch', filters),
      providerModelBreakdown(filters),
      getHealth(),
    ]);

  const totalCost = providerModel.reduce((sum, r) => sum + Number(r.cost_usd ?? 0), 0);
  const totalTurns = providerModel.reduce((sum, r) => sum + Number(r.turns), 0);
  const totalUnpriced = providerModel.reduce((sum, r) => sum + Number(r.unpriced_turns), 0);

  return (
    <>
      <HealthBanner health={health} />

      <div className="mb-4 flex flex-wrap items-baseline gap-x-6 gap-y-1 card px-4 py-3">
        <div className="flex items-baseline gap-2">
          <span className="text-xl font-semibold mono">{cost(String(totalCost))}</span>
          <span className="text-xs text-ink-2">total recorded cost</span>
          <InfoTip label="How this total was calculated" width={310}>
            <TipTitle>How this total was calculated</TipTitle>
            <p className="text-[11px] leading-relaxed text-ink-2">
              <span className="mono">sum(cost_usd)</span> over every turn matching the current
              filter, grouped by provider × model and then added up. Each turn&apos;s cost was
              computed once at ingest, from that turn&apos;s token counts and the rate in force
              when it ran; nothing is repriced here.
            </p>
            <p className="mt-2 text-[11px] leading-relaxed text-ink-2">
              {num(totalTurns)} turns are in scope.{' '}
              {totalUnpriced > 0 ? (
                <span className="text-warn">
                  {num(totalUnpriced)} of them have no rate and add nothing, so this is a floor —
                  the real figure is higher by an unknown amount.
                </span>
              ) : (
                'Every one of them is priced, so nothing is missing from this figure.'
              )}
            </p>
            <TipNote>
              Recorded, not billed. List price from seeded rates, never reconciled against an
              invoice.
            </TipNote>
          </InfoTip>
        </div>
        <div className="text-sm text-ink-2">
          {num(totalTurns)} turns
          {totalUnpriced > 0 && (
            <span className="ml-2 text-warn">
              · {num(totalUnpriced)} unpriced and excluded from the total
            </span>
          )}
        </div>
        <span className="ml-auto text-[11px] text-ink-2">
          Derived from provider-reported usage and seeded rates — not billing-authoritative.
        </span>
      </div>

      <section className="card mb-5 overflow-hidden">
        <h2 className="border-b border-line bg-surface-2 px-3 py-2 text-sm font-semibold">
          Provider × model
          <span className="ml-2 font-normal text-xs text-ink-2">
            cost is keyed on the pair — the same model prices differently through a gateway
          </span>
        </h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-[11px] uppercase tracking-wide text-ink-2">
              <tr className="border-b border-line">
                <th className="px-3 py-1.5 font-medium">Provider</th>
                <th className="px-3 py-1.5 font-medium">Model</th>
                <th className="px-3 py-1.5 font-medium">Attribution</th>
                <th className="px-3 py-1.5 text-right font-medium">Turns</th>
                <th className="px-3 py-1.5 text-right font-medium">Input</th>
                <th className="px-3 py-1.5 text-right font-medium">Output</th>
                <th className="px-3 py-1.5 text-right font-medium">
                  <span className="inline-flex items-center gap-1.5">
                    Cost
                    <GroupCostTip grouping="provider × model pair" />
                  </span>
                </th>
              </tr>
            </thead>
            <tbody>
              {providerModel.map((r) => (
                <tr
                  key={`${r.provider_key}|${r.model_normalized}|${r.provider_source}`}
                  className="border-b border-line last:border-0"
                >
                  <td className="px-3 py-1.5">{r.provider_key}</td>
                  <td className="px-3 py-1.5 mono text-xs">{r.model_normalized}</td>
                  <td className="px-3 py-1.5">
                    {r.provider_source === 'proxy' ? (
                      <Chip tone="good" title="Observed — the API host actually connected to">observed</Chip>
                    ) : r.provider_source === 'config' ? (
                      <Chip title="Resolved from the agent's configured base URL">config</Chip>
                    ) : (
                      <Chip tone="warn" title="Inferred from the model id prefix — cannot distinguish direct from gateway traffic">
                        inferred
                      </Chip>
                    )}
                  </td>
                  <td className="px-3 py-1.5 text-right mono text-xs">{num(r.turns)}</td>
                  <td className="px-3 py-1.5 text-right mono text-xs">{compactNum(r.input_tokens)}</td>
                  <td className="px-3 py-1.5 text-right mono text-xs">{compactNum(r.output_tokens)}</td>
                  <td className="px-3 py-1.5 text-right mono text-xs">{cost(r.cost_usd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <AggregateTable title="By day (UTC)" rows={byDay} grouping="day" />
        <AggregateTable title="By project" rows={byProject} grouping="project" />
        <AggregateTable title="By agent" rows={byAgent} grouping="agent" />
        <AggregateTable title="By provider" rows={byProvider} grouping="provider" />
        <AggregateTable title="By model" rows={byModel} grouping="model" />
        <AggregateTable
          title="By branch"
          rows={byBranch}
          grouping="branch"
          note="branch names only mean something within a project"
        />
      </div>
    </>
  );
}
