import { InfoTip, TipNote, TipTitle } from './InfoTip';
import { costExact, costWorking, rate, rateWindow, reconcile, type CostInputsRow } from '@/lib/cost';
import { num } from '@/lib/format';

/**
 * The working behind one turn's cost, on an info icon.
 *
 * Every line is `tokens × rate = amount`, so the figure can be checked rather
 * than taken on trust — which matters more here than usual, because this
 * number has never been reconciled against an invoice and the panel says so.
 *
 * A turn with no price gets an explanation of *why*, not a blank panel. That
 * is the same rule the rest of the UI follows: absence is a fact about the
 * capture, and hiding it would let "unpriced" read as "free".
 */

export interface CostTipRow extends CostInputsRow {
  rate_source?: string | null;
  effective_from?: Date | string | null;
  effective_to?: Date | string | null;
  rate_model?: string | null;
  rate_provider?: string | null;
}

function Line({
  label,
  tokens,
  rateUsd,
  usd,
  note,
}: {
  label: string;
  tokens: number;
  rateUsd: number | null;
  usd: number;
  note?: string;
}) {
  return (
    <div className="border-b border-line-soft py-1 last:border-0">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] text-ink-2">{label}</span>
        <span className="mono shrink-0 text-[11px] text-ink">{costExact(usd)}</span>
      </div>
      <div className="mono text-[10px] text-ink-3">
        {num(tokens)} × {rate(rateUsd)}
      </div>
      {note && <div className="text-[10px] text-ink-3 italic">{note}</div>}
    </div>
  );
}

export function CostTip({
  row,
  storedCostUsd,
  costSource,
  width,
}: {
  /** NULL when the turn has no pricing row — i.e. it was never priced. */
  row: CostTipRow | null;
  storedCostUsd: string | null;
  costSource: string;
  width?: number;
}) {
  const working = costWorking(row);
  const check = reconcile(working, storedCostUsd);

  return (
    <InfoTip label="How this cost was calculated" width={width}>
      <TipTitle>How this cost was calculated</TipTitle>

      {costSource === 'free_local' ? (
        <p className="text-[11px] leading-relaxed text-ink-2">
          This turn ran against a local model, so no rate applies and nothing was billed. That is
          different from an unpriced turn, where a cost exists but this system cannot compute it.
        </p>
      ) : working === null ? (
        <p className="text-[11px] leading-relaxed text-ink-2">
          No rate in <span className="mono">model_pricing</span> covers this turn&apos;s
          (provider, model) at the time it ran, so no cost was computed. The turn was{' '}
          <strong>not free</strong> — the amount is unknown, and it is left out of every total on
          this page rather than counted as zero.
        </p>
      ) : (
        <>
          <div>
            {working.parts.map((p) => (
              <Line
                key={p.label}
                label={p.label}
                tokens={p.tokens}
                rateUsd={p.rate}
                usd={p.usd}
                note={p.note}
              />
            ))}
          </div>
          <div className="mt-1.5 flex items-baseline justify-between gap-2 border-t border-line pt-1.5">
            <span className="text-[11px] font-medium">Total</span>
            <span className="mono text-[11px] font-semibold">{costExact(working.total)}</span>
          </div>

          {check && !check.matches && (
            // The sum of the parts is the dashboard's reconstruction; the
            // stored value is what the collector computed at ingest. If they
            // disagree, the stored one is the record and this panel is the
            // thing that is wrong — say so rather than quietly showing two
            // numbers and letting the reader pick.
            <p className="mt-2 text-[11px] leading-relaxed text-warn">
              These lines come to {costExact(working.total)}, but the stored cost is{' '}
              {costExact(check.stored)}. The stored value is the record. This breakdown is
              reconstructed from the same rate row and has drifted from it — treat the working,
              not the total, as suspect.
            </p>
          )}

          <TipNote>
            Rate row: <span className="mono">{row?.rate_source ?? 'unknown source'}</span>
            {row?.rate_provider && row?.rate_model
              ? `, for ${row.rate_provider} · ${row.rate_model}`
              : ''}
            , {rateWindow(row?.effective_from, row?.effective_to)}. Computed once at ingest and
            never recomputed: a later price change adds a new rate row, it does not rewrite this.
            List price only — batch discounts and contract rates are not modelled, and none of
            this has been checked against an invoice.
          </TipNote>
        </>
      )}
    </InfoTip>
  );
}
