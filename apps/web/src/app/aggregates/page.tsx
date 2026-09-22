import { compactNum, cost, num } from '@/lib/format';
import { readFilters } from '@/lib/filters';
import { HealthBanner } from '@/components/HealthBanner';
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

function AggregateTable({ title, rows, note }: { title: string; rows: AggregateRow[]; note?: string }) {
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
                <th className="px-3 py-1.5 text-right font-medium">Cost</th>
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
        <div>
          <span className="text-xl font-semibold mono">{cost(String(totalCost))}</span>
          <span className="ml-2 text-xs text-ink-2">total recorded cost</span>
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
                <th className="px-3 py-1.5 text-right font-medium">Cost</th>
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
        <AggregateTable title="By day (UTC)" rows={byDay} />
        <AggregateTable title="By project" rows={byProject} />
        <AggregateTable title="By agent" rows={byAgent} />
        <AggregateTable title="By provider" rows={byProvider} />
        <AggregateTable title="By model" rows={byModel} />
        <AggregateTable
          title="By branch"
          rows={byBranch}
          note="branch names only mean something within a project"
        />
      </div>
    </>
  );
}
