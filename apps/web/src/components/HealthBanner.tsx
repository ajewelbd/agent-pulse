import { num } from '@/lib/format';
import { IconChevronDown, IconWarning } from './icons';
import type { HealthRow } from '@/lib/queries';

/**
 * Data-quality banner.
 *
 * A dashboard that renders only what it knows quietly implies it knows
 * everything. This states, up front, exactly where the numbers below are
 * incomplete — because the gaps here are structural, not bugs:
 *
 *   - Layer 1 transcripts record no shell exit codes at all.
 *   - They record no provider either, so attribution from logs alone is
 *     inference from the model id and cannot tell direct from gateway traffic.
 *   - A model with no seeded rate is unpriced, so cost totals understate spend.
 *
 * Each of these has a fix the user can act on, so each says what it is. The
 * collapsed line carries the first three in short form rather than a bare
 * count, so the caveats are legible without opening anything.
 */
interface Caveat {
  short: string;
  label: string;
  detail: string;
}

function buildCaveats(health: HealthRow): Caveat[] {
  const items: Caveat[] = [];
  const total = Number(health.total_turns);

  const inferred = Number(health.inferred_provider_turns);
  if (inferred > 0) {
    items.push({
      short: 'provider is inferred where marked',
      label: `${num(inferred)} of ${num(total)} turns have an inferred provider`,
      detail:
        'Guessed from the model id. A gateway serving the same model is indistinguishable this way — route the agent through the proxy (ANTHROPIC_BASE_URL=http://127.0.0.1:4318) for observed attribution.',
    });
  }

  const unpriced = Number(health.unpriced_turns);
  if (unpriced > 0) {
    items.push({
      short: 'some turns are unpriced',
      label: `${num(unpriced)} turns are unpriced`,
      detail:
        'No rate exists for their (provider, model). They contribute nothing to cost totals, so spend below is understated rather than wrong. Add rows to model_pricing to include them.',
    });
  }

  const tools = Number(health.tool_calls_total);
  const withExit = Number(health.tool_calls_with_exit_code);
  if (tools > 0 && withExit < tools) {
    items.push({
      short: 'most commands have no exit code',
      label: `${num(tools - withExit)} of ${num(tools)} commands have no exit code`,
      detail:
        'Transcripts never recorded it, so these can never be backfilled. Going forward it is recoverable from Layer 2 hooks — a failing command states it in the hook’s error text — but the enrichment pass that applies that is not written yet. Hook events are being captured meanwhile, so nothing is being lost. See docs/hook-payloads.md.',
    });
  }

  const unknownTokens = Number(health.unknown_token_turns);
  if (unknownTokens > 0) {
    items.push({
      short: 'some turns reported no tokens',
      label: `${num(unknownTokens)} turns reported no token counts`,
      detail: 'Shown as “no tokens”, never as zero. These are excluded from token totals.',
    });
  }

  const partial = Number(health.partial_turns);
  if (partial > 0) {
    items.push({
      short: 'some turns are still partial',
      label: `${num(partial)} turns are still partial`,
      detail:
        'Streaming turns that have not reached a terminal event. The reconciler closes stale ones after 30 minutes.',
    });
  }

  const uncertain = Number(health.uncertain_file_changes);
  if (uncertain > 0) {
    items.push({
      short: 'some file changes are not confidently attributed',
      label: `${num(uncertain)} file changes are not confidently attributed`,
      detail:
        'The file changed between the agent reading and writing it, or git was unusable for that repo. The changes are kept, flagged rather than dropped.',
    });
  }

  return items;
}

export function HealthBanner({ health }: { health: HealthRow | null }) {
  if (!health) return null;
  if (Number(health.total_turns) === 0) return null;

  const items = buildCaveats(health);
  if (items.length === 0) return null;

  const head = items.slice(0, 3).map((i) => i.short);
  const rest = items.length - head.length;

  return (
    <details className="group mb-5 rounded-xl border border-warn-line bg-warn-bg">
      <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3">
        <IconWarning className="h-4 w-4 shrink-0 text-warn" />
        <span className="min-w-0 flex-1 text-sm">
          <span className="font-medium text-warn">What these numbers do not know</span>
          <span className="ml-2 text-ink-2">
            {head.join(' · ')}
            {rest > 0 && ` · ${rest} more`}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-1.5 rounded-lg border border-warn-line bg-surface px-3 py-1.5 text-xs whitespace-nowrap text-ink-2">
          <IconChevronDown className="h-3.5 w-3.5 transition-transform group-open:rotate-180" />
          Read the {items.length} caveat{items.length === 1 ? '' : 's'}
        </span>
      </summary>

      <ul className="space-y-3 border-t border-warn-line px-4 py-3">
        {items.map((item) => (
          <li key={item.label} className="text-sm">
            <span className="font-medium">{item.label}</span>
            <span className="mt-0.5 block text-xs leading-relaxed text-ink-2">{item.detail}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}
