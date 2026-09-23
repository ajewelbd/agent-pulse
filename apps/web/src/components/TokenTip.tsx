import { InfoTip, TipNote, TipTitle } from './InfoTip';
import { num } from '@/lib/format';
import { formatShare, shareOf, tokenWorking, type TokenInputsRow, type TokenPart } from '@/lib/tokens';

/**
 * What a token count is made of, on an info icon.
 *
 * The input figure is the one that needs explaining: on an agent turn it is
 * almost entirely cache reads, which is why a turn can show 30M "in" and cost
 * a few dollars. Showing the composition is the difference between a number
 * that looks alarming and one that can be reasoned about.
 *
 * Output has no components — it is one figure the provider reported — so its
 * panel explains provenance rather than arithmetic, and says what is NOT
 * known.
 */

const SOURCE_NOTE: Record<string, string> = {
  provider: 'Counted by the provider and recorded in the agent’s own transcript.',
  hooks: 'Reported by the agent’s hooks rather than by the provider.',
  proxy: 'Observed on the wire by the local proxy.',
  estimated: 'Estimated, not reported — treat it as an order of magnitude.',
};

function Row({ part, share }: { part: TokenPart; share: number }) {
  return (
    <div className="border-b border-line-soft py-1 last:border-0">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] text-ink-2">{part.label}</span>
        <span className="mono shrink-0 text-[11px] text-ink">{num(part.tokens)}</span>
      </div>
      <div className="mt-0.5 flex items-center gap-1.5">
        <span className="h-1 flex-1 overflow-hidden rounded-full bg-line">
          <span className="block h-1 rounded-full bg-accent" style={{ width: `${share}%` }} />
        </span>
        <span className="mono w-12 shrink-0 text-right text-[10px] text-ink-3">
          {formatShare(share)}
        </span>
      </div>
      <div className="text-[10px] leading-snug text-ink-3">{part.what}</div>
    </div>
  );
}

export function TokenTip({
  row,
  focus,
  width = 300,
}: {
  row: TokenInputsRow;
  focus: 'in' | 'out';
  width?: number;
}) {
  const working = tokenWorking(row);
  const label = focus === 'in' ? 'What these input tokens are' : 'Where this output count comes from';

  return (
    <InfoTip label={label} width={width}>
      <TipTitle>{label}</TipTitle>

      {working === null ? (
        <p className="text-[11px] leading-relaxed text-ink-2">
          No assistant message in this turn carried a usage report, so nothing is known about its
          token counts. The figure is shown as <span className="mono">—</span> rather than 0: this
          turn did not use zero tokens, it declined to say. It also cannot be priced, and it is
          left out of every total on this page.
        </p>
      ) : focus === 'out' ? (
        <>
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-[11px] text-ink-2">Output</span>
            <span className="mono text-[11px] font-semibold text-out">{num(working.output)}</span>
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-ink-2">
            Everything the model generated this turn, summed over every assistant message in it —
            prose, tool calls and all. It has no sub-parts, and it is the most expensive token
            class: on every rate seeded here it costs exactly 5× uncached input, and between 50×
            and 200× a cache read.
          </p>
          <p className="mt-2 text-[11px] leading-relaxed text-ink-2">
            Against{' '}
            <span className="mono text-ink">{num(working.totalIn)}</span> in, that is a ratio of 1
            :{' '}
            <span className="mono text-ink">
              {working.output && working.output > 0
                ? Math.round(working.totalIn / working.output)
                : '—'}
            </span>
            . Agent turns are read-heavy; almost all of the bill is context, not generation.
          </p>
          <TipNote>{SOURCE_NOTE[row.token_source] ?? `Source: ${row.token_source}.`}</TipNote>
        </>
      ) : (
        <>
          <div>
            {working.parts.map((p) => (
              <Row key={p.key} part={p} share={shareOf(working, p)} />
            ))}
          </div>
          <div className="mt-1.5 flex items-baseline justify-between gap-2 border-t border-line pt-1.5">
            <span className="text-[11px] font-medium">Total in</span>
            <span className="mono text-[11px] font-semibold">{num(working.totalIn)}</span>
          </div>

          {working.writeSplit && (
            <div className="mt-2 rounded-md border border-line bg-surface-2 p-2">
              <div className="text-[10px] text-ink-2">
                Cache write splits by how long the entry lives:
              </div>
              <div className="mono mt-1 flex justify-between text-[10px] text-ink">
                <span>5 min</span>
                <span>{num(working.writeSplit.m5)}</span>
              </div>
              <div className="mono flex justify-between text-[10px] text-ink">
                <span>1 hour</span>
                <span>{num(working.writeSplit.h1)}</span>
              </div>
              {working.writeSplit.exceedsTotal && (
                // Both numbers are the provider's own, accumulated over the
                // turn's assistant messages. Neither is this system's
                // arithmetic, so neither is "corrected" — the disagreement is
                // the fact worth reporting.
                <p className="mt-1.5 text-[10px] leading-snug text-warn">
                  These buckets add up to {num(working.writeSplit.sum)}, more than the{' '}
                  {num(working.parts[2]?.tokens ?? 0)} cache-write total the same provider
                  reported. Both figures are recorded as given; the total above uses the reported
                  total, and the cost uses the buckets.
                </p>
              )}
            </div>
          )}

          <TipNote>
            {SOURCE_NOTE[row.token_source] ?? `Source: ${row.token_source}.`} Summed across every
            assistant message in the turn — a turn with ten tool round-trips reports usage ten
            times, and this is their total.
          </TipNote>
        </>
      )}
    </InfoTip>
  );
}
