import { compactNum, cost, num } from '@/lib/format';
import { InfoTip, TipNote, TipTitle } from './InfoTip';
import { IconFile, IconIn, IconOut, IconSpend, IconTerminal } from './icons';
import { formatShare, sumTokenWorking } from '@/lib/tokens';
import type { TurnListRow } from '@/lib/queries';

/**
 * Page-level totals.
 *
 * Deliberately scoped to the rows on screen, and each tile says so — a tile
 * labelled "spend" over a filtered, paginated list invites being read as the
 * whole filter's spend. The sub-line is the guard against that.
 *
 * Unpriced turns are named rather than folded in: they contribute nothing to
 * the sum, so a spend figure that stays silent about them understates.
 */
function Tile({
  icon,
  label,
  value,
  sub,
  tone,
  title,
  info,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub: React.ReactNode;
  tone?: 'accent' | 'out';
  title?: string;
  info?: React.ReactNode;
}) {
  const valueTone =
    tone === 'accent' ? 'text-accent' : tone === 'out' ? 'text-out' : 'text-ink';
  return (
    <div className="card p-4" title={title}>
      <div className="flex items-center gap-1.5">
        <span className="text-ink-3">{icon}</span>
        <span className="eyebrow">{label}</span>
        {info && <span className="ml-auto">{info}</span>}
      </div>
      <div className={`mono mt-2 text-2xl leading-none font-semibold tracking-tight ${valueTone}`}>
        {value}
      </div>
      <div className="mt-2 text-xs text-ink-2">{sub}</div>
    </div>
  );
}

export function StatTiles({ rows }: { rows: TurnListRow[] }) {
  const turns = rows.length;
  if (turns === 0) return null;

  let spend = 0;
  let unpriced = 0;
  let commands = 0;
  let files = 0;
  let turnsWithFiles = 0;

  for (const r of rows) {
    if (r.cost_usd === null) {
      if (r.cost_source !== 'free_local') unpriced += 1;
    } else {
      spend += Number(r.cost_usd);
    }
    commands += Number(r.tool_call_count);
    const fc = Number(r.file_change_count);
    files += fc;
    if (fc > 0) turnsWithFiles += 1;
  }

  // Turns that reported no usage are counted out rather than added as zero —
  // otherwise the per-turn averages below are divided by turns that
  // contributed nothing and could not have.
  const tokens = sumTokenWorking(rows);
  const tokensIn = tokens.totalIn;
  const tokensOut = tokens.output;

  const allTokens = tokensIn + tokensOut;
  const outShare = allTokens > 0 ? (tokensOut / allTokens) * 100 : null;
  const priced = turns - unpriced;

  const tokenNote = (
    <TipNote>
      Summed over the {tokens.reported} turn{tokens.reported === 1 ? '' : 's'} on this page that
      reported usage
      {tokens.unreported > 0
        ? `; ${tokens.unreported} reported none and are left out of both the total and the average`
        : ''}
      . This page only — not the whole filter.
    </TipNote>
  );

  return (
    <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      <Tile
        icon={<IconSpend className="h-3.5 w-3.5" />}
        label="Spend"
        value={cost(String(spend))}
        tone="accent"
        title="List-price estimate over the turns on this page only."
        info={
          <InfoTip label="How this spend figure was calculated" width={300}>
            <TipTitle>How this spend figure was calculated</TipTitle>
            <p className="text-[11px] leading-relaxed text-ink-2">
              The stored <span className="mono">cost_usd</span> of the{' '}
              <span className="mono text-ink">{priced}</span> priced turn
              {priced === 1 ? '' : 's'} on this page, added together. Each of those was priced at
              ingest from its own token counts and the rate then in force — the info icon on any
              row&apos;s cost shows that row&apos;s working.
            </p>
            {unpriced > 0 && (
              <p className="mt-2 text-[11px] leading-relaxed text-warn">
                <span className="mono">{unpriced}</span> turn{unpriced === 1 ? ' has' : 's have'}{' '}
                no rate and contribute nothing. This total is therefore a floor, not the full
                spend.
              </p>
            )}
            <TipNote>
              This page only — not the whole filter, and not the whole archive. Change the page
              and this number changes.
            </TipNote>
          </InfoTip>
        }
        sub={
          unpriced > 0 ? (
            <>
              {turns} turns on this page ·{' '}
              <span className="text-warn">{unpriced} unpriced, excluded</span>
            </>
          ) : (
            `${turns} turn${turns === 1 ? '' : 's'} on this page`
          )
        }
      />
      <Tile
        icon={<IconIn className="h-3.5 w-3.5" />}
        label="Tokens in"
        value={compactNum(tokensIn)}
        title="input + cache read + cache write — the billable figure, not uncached input alone."
        info={
          <InfoTip label="What these input tokens are" width={300}>
            <TipTitle>What these input tokens are</TipTitle>
            <div>
              {tokens.parts.map((p) => {
                const share = tokensIn > 0 ? (p.tokens / tokensIn) * 100 : 0;
                return (
                  <div key={p.key} className="border-b border-line-soft py-1 last:border-0">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-[11px] text-ink-2">{p.label}</span>
                      <span className="mono shrink-0 text-[11px] text-ink">{num(p.tokens)}</span>
                    </div>
                    <div className="mt-0.5 flex items-center gap-1.5">
                      <span className="h-1 flex-1 overflow-hidden rounded-full bg-line">
                        <span
                          className="block h-1 rounded-full bg-accent"
                          style={{ width: `${share}%` }}
                        />
                      </span>
                      <span className="mono w-12 shrink-0 text-right text-[10px] text-ink-3">
                        {formatShare(share)}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="mt-1.5 flex items-baseline justify-between gap-2 border-t border-line pt-1.5">
              <span className="text-[11px] font-medium">Total in</span>
              <span className="mono text-[11px] font-semibold">{num(tokensIn)}</span>
            </div>
            {tokenNote}
          </InfoTip>
        }
        sub={
          tokens.reported === 0
            ? 'no usage reported on this page'
            : `avg ${compactNum(Math.round(tokensIn / tokens.reported))} per reporting turn`
        }
      />
      <Tile
        icon={<IconOut className="h-3.5 w-3.5" />}
        label="Tokens out"
        value={compactNum(tokensOut)}
        tone="out"
        info={
          <InfoTip label="Where this output count comes from" width={300}>
            <TipTitle>Where this output count comes from</TipTitle>
            <p className="text-[11px] leading-relaxed text-ink-2">
              Everything the models generated across these turns — prose and tool calls alike.
              Output has no sub-parts, but it is the priciest class: on every rate seeded here it
              costs 5× uncached input.
            </p>
            <div className="mt-2 flex items-baseline justify-between gap-2 border-t border-line pt-1.5">
              <span className="text-[11px] text-ink-2">In : out</span>
              <span className="mono text-[11px] font-semibold">
                {tokensOut > 0 ? `${Math.round(tokensIn / tokensOut)} : 1` : '—'}
              </span>
            </div>
            {tokenNote}
          </InfoTip>
        }
        sub={outShare === null ? 'no tokens reported' : `${outShare.toFixed(1)}% of all tokens`}
      />
      <Tile
        icon={<IconTerminal className="h-3.5 w-3.5" />}
        label="Commands"
        value={compactNum(commands)}
        sub={`avg ${Math.round(commands / turns)} per turn`}
      />
      <Tile
        icon={<IconFile className="h-3.5 w-3.5" />}
        label="Files touched"
        value={compactNum(files)}
        sub={`across ${turnsWithFiles} of ${turns} turns`}
      />
    </div>
  );
}
