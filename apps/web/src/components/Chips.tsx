/**
 * Small status chips.
 *
 * Every one of these exists to make a *known unknown* visible. The pipeline
 * genuinely cannot determine some things — the provider when only logs were
 * available, a price when no rate is seeded, an exit code that Layer 1 never
 * records — and a dashboard that renders those the same as known values is
 * quietly lying about its own confidence.
 */

function Chip({
  children,
  tone = 'neutral',
  title,
}: {
  children: React.ReactNode;
  tone?: 'neutral' | 'warn' | 'good' | 'bad';
  title?: string;
}) {
  const tones = {
    neutral: 'border-[--color-line] text-[--color-ink-2]',
    good: 'border-[--color-add] text-[--color-add]',
    warn: 'border-amber-500/60 text-amber-600 dark:text-amber-400',
    bad: 'border-[--color-del] text-[--color-del]',
  } as const;
  return (
    <span
      title={title}
      className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-medium leading-none whitespace-nowrap ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

/** `proxy` is observed fact; `model_map` is inference and says so. */
export function ProviderChip({
  provider,
  source,
}: {
  provider: string | null;
  source: string;
}) {
  if (!provider) return <Chip tone="warn" title="Provider could not be resolved">unknown</Chip>;
  if (source === 'proxy') {
    return <Chip tone="good" title="Observed by the proxy — the API host actually connected to">{provider} ✓</Chip>;
  }
  if (source === 'config') {
    return <Chip title="Resolved from the agent's configured base URL">{provider}</Chip>;
  }
  return (
    <Chip tone="warn" title="Inferred from the model id prefix. A gateway serving the same model would look identical — route the agent through the proxy for certainty.">
      {provider}?
    </Chip>
  );
}

export function StatusChip({ status }: { status: string }) {
  const tone = status === 'complete' ? 'good' : status === 'error' ? 'bad' : 'warn';
  const title =
    status === 'partial'
      ? 'Turn never reached a terminal event. The reconciler closes stale partials after 30 minutes.'
      : status === 'aborted'
        ? 'Interrupted before completing.'
        : undefined;
  return <Chip tone={tone} title={title}>{status}</Chip>;
}

export function TokenSourceChip({ source }: { source: string }) {
  if (source === 'provider') {
    return <Chip tone="good" title="Counts reported by the provider in the agent's own transcript">provider</Chip>;
  }
  if (source === 'proxy') {
    return <Chip tone="good" title="Counts observed in transit by the local proxy">proxy</Chip>;
  }
  if (source === 'estimated') {
    return <Chip tone="warn" title="Estimated locally — NOT provider-reported. Never mix with reported counts.">estimated</Chip>;
  }
  return <Chip tone="warn" title="No token counts were reported for this turn. Not the same as zero.">no tokens</Chip>;
}

export function CostChip({ source }: { source: string }) {
  if (source === 'free_local') {
    return <Chip tone="good" title="Local inference — genuinely zero cost">free</Chip>;
  }
  if (source === 'unpriced') {
    return (
      <Chip tone="warn" title="No rate exists for this (provider, model) at this time. Shown as 'not priced', never as $0.00.">
        unpriced
      </Chip>
    );
  }
  return null;
}

export function AttributionChip({ attribution }: { attribution: string }) {
  if (attribution === 'agent') return null;
  return (
    <Chip tone="warn" title="The file changed between the agent reading and writing it, or git was unusable for this repo. The change is kept but not confidently attributed to the agent.">
      uncertain
    </Chip>
  );
}

export { Chip };
