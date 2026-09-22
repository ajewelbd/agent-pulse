import { compactNum, cost } from '@/lib/format';
import { IconFile, IconIn, IconOut, IconSpend, IconTerminal } from './icons';
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
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub: React.ReactNode;
  tone?: 'accent' | 'out';
  title?: string;
}) {
  const valueTone =
    tone === 'accent' ? 'text-accent' : tone === 'out' ? 'text-out' : 'text-ink';
  return (
    <div className="card p-4" title={title}>
      <div className="flex items-center gap-1.5">
        <span className="text-ink-3">{icon}</span>
        <span className="eyebrow">{label}</span>
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
  let tokensIn = 0;
  let tokensOut = 0;
  let commands = 0;
  let files = 0;
  let turnsWithFiles = 0;

  for (const r of rows) {
    if (r.cost_usd === null) {
      if (r.cost_source !== 'free_local') unpriced += 1;
    } else {
      spend += Number(r.cost_usd);
    }
    tokensIn += Number(r.total_input_tokens ?? 0);
    tokensOut += Number(r.output_tokens ?? 0);
    commands += Number(r.tool_call_count);
    const fc = Number(r.file_change_count);
    files += fc;
    if (fc > 0) turnsWithFiles += 1;
  }

  const allTokens = tokensIn + tokensOut;
  const outShare = allTokens > 0 ? (tokensOut / allTokens) * 100 : null;

  return (
    <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      <Tile
        icon={<IconSpend className="h-3.5 w-3.5" />}
        label="Spend"
        value={cost(String(spend))}
        tone="accent"
        title="List-price estimate over the turns on this page only."
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
        sub={`avg ${compactNum(Math.round(tokensIn / turns))} per turn`}
      />
      <Tile
        icon={<IconOut className="h-3.5 w-3.5" />}
        label="Tokens out"
        value={compactNum(tokensOut)}
        tone="out"
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
