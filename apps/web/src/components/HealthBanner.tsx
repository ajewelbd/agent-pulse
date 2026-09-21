import { num } from '@/lib/format';
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
 * Each of these has a fix the user can act on, so each says what it is.
 */
export function HealthBanner({ health }: { health: HealthRow | null }) {
  if (!health) return null;

  const total = Number(health.total_turns);
  if (total === 0) return null;

  const items: { label: string; detail: string }[] = [];

  const inferred = Number(health.inferred_provider_turns);
  if (inferred > 0) {
    items.push({
      label: `${num(inferred)} of ${num(total)} turns have an inferred provider`,
      detail:
        'Guessed from the model id. A gateway serving the same model is indistinguishable this way — route the agent through the proxy (ANTHROPIC_BASE_URL=http://127.0.0.1:4318) for observed attribution.',
    });
  }

  const unpriced = Number(health.unpriced_turns);
  if (unpriced > 0) {
    items.push({
      label: `${num(unpriced)} turns are unpriced`,
      detail:
        'No rate exists for their (provider, model). They contribute nothing to cost totals, so spend below is understated rather than wrong. Add rows to model_pricing to include them.',
    });
  }

  const tools = Number(health.tool_calls_total);
  const withExit = Number(health.tool_calls_with_exit_code);
  if (tools > 0 && withExit < tools) {
    items.push({
      label: `${num(tools - withExit)} of ${num(tools)} commands have no exit code`,
      detail:
        'Agent transcripts do not record exit codes. Only the PostToolUse hook can supply them — run `make install-hooks` and start a new agent session.',
    });
  }

  const unknownTokens = Number(health.unknown_token_turns);
  if (unknownTokens > 0) {
    items.push({
      label: `${num(unknownTokens)} turns reported no token counts`,
      detail: 'Shown as “no tokens”, never as zero. These are excluded from token totals.',
    });
  }

  const partial = Number(health.partial_turns);
  if (partial > 0) {
    items.push({
      label: `${num(partial)} turns are still partial`,
      detail: 'Streaming turns that have not reached a terminal event. The reconciler closes stale ones after 30 minutes.',
    });
  }

  const uncertain = Number(health.uncertain_file_changes);
  if (uncertain > 0) {
    items.push({
      label: `${num(uncertain)} file changes are not confidently attributed`,
      detail: 'The file changed between the agent reading and writing it, or git was unusable for that repo. The changes are kept, flagged rather than dropped.',
    });
  }

  if (items.length === 0) return null;

  return (
    <details className="mb-4 rounded-lg border border-amber-500/40 bg-amber-500/5">
      <summary className="cursor-pointer select-none px-3 py-2 text-sm">
        <span className="font-medium text-amber-700 dark:text-amber-400">
          What these numbers don&apos;t know
        </span>
        <span className="ml-2 text-xs text-[--color-ink-2]">
          {items.length} caveat{items.length === 1 ? '' : 's'} — click to expand
        </span>
      </summary>
      <ul className="space-y-2 border-t border-amber-500/20 px-3 py-2.5">
        {items.map((item) => (
          <li key={item.label} className="text-sm">
            <span className="font-medium">{item.label}</span>
            <span className="block text-xs text-[--color-ink-2]">{item.detail}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}
