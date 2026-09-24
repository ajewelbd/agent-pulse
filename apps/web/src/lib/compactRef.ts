import type { CompactTurnRef } from '@/components/CompactSelection';
import { cost, shortId, tokenCount } from './format';
import type { TurnListRow } from './queries';

/**
 * A list row, reduced to what the compaction tray needs to show it.
 *
 * Built on the server so the labels come from the same formatters the table
 * cells use — which is what keeps "absence is not zero" true inside the tray.
 * An unreported turn carries `tokensLabel: '—'` and `tokensIn: null`, and the
 * tray's totals skip the null instead of adding a zero to them.
 *
 * The raw figures are parsed here rather than in the browser because the pg
 * driver hands bigint and numeric back as strings, and Number('') is 0.
 */
export function toCompactRef(turn: TurnListRow): CompactTurnRef {
  const tokens = turn.token_source === 'unknown' ? null : Number(turn.total_input_tokens);
  const costUsd = turn.cost_usd === null ? null : Number(turn.cost_usd);
  return {
    id: turn.id,
    seq: turn.seq,
    label: turn.prompt_preview?.replace(/\s+/g, ' ').trim() || '(no prompt text)',
    ideKind: turn.ide_kind,
    tokensLabel: tokenCount(turn.total_input_tokens, turn.token_source),
    costLabel: cost(turn.cost_usd, turn.cost_source),
    tokensIn: tokens !== null && Number.isFinite(tokens) ? tokens : null,
    costUsd: costUsd !== null && Number.isFinite(costUsd) ? costUsd : null,
    sessionShort: shortId(turn.external_session_id),
  };
}
