/**
 * Small status chips.
 *
 * Every one of these exists to make a *known unknown* visible. The pipeline
 * genuinely cannot determine some things — the provider when only logs were
 * available, a price when no rate is seeded, an exit code that Layer 1 never
 * records — and a dashboard that renders those the same as known values is
 * quietly lying about its own confidence.
 *
 * The visual grammar carries that: a DASHED border means the value was
 * inferred, a solid one means it was observed. The list footer states the rule
 * once so the border alone is readable everywhere else.
 */

function Chip({
  children,
  tone = 'neutral',
  inferred = false,
  title,
}: {
  children: React.ReactNode;
  tone?: 'neutral' | 'warn' | 'good' | 'bad';
  inferred?: boolean;
  title?: string;
}) {
  const tones = {
    neutral: 'border-line bg-surface-2 text-ink-2',
    good: 'border-accent/45 bg-accent/10 text-accent',
    warn: 'border-warn-line bg-warn-bg text-warn',
    bad: 'border-del/45 bg-del/10 text-del',
  } as const;
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] leading-none font-medium whitespace-nowrap ${
        inferred ? 'border-dashed' : ''
      } ${tones[tone]}`}
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
  if (!provider) {
    return <Chip tone="warn" inferred title="Provider could not be resolved">unknown</Chip>;
  }
  if (source === 'proxy') {
    return (
      <Chip tone="good" title="Observed by the proxy — the API host actually connected to">
        {provider} ✓
      </Chip>
    );
  }
  if (source === 'config') {
    return <Chip title="Resolved from the agent's configured base URL">{provider}</Chip>;
  }
  return (
    <Chip
      tone="warn"
      inferred
      title="Inferred from the model id prefix. A gateway serving the same model would look identical — route the agent through the proxy for certainty."
    >
      {provider} ?
    </Chip>
  );
}

const STATUS_TONE: Record<string, string> = {
  complete: 'text-accent',
  error: 'text-del',
  partial: 'text-warn',
  aborted: 'text-warn',
};

const STATUS_TITLE: Record<string, string> = {
  partial:
    'Turn never reached a terminal event. The reconciler closes stale partials after 30 minutes.',
  aborted: 'Interrupted before completing.',
};

/** Dot + label. Used in the list, where a full pill per row is too heavy. */
export function StatusDot({ status }: { status: string }) {
  const tone = STATUS_TONE[status] ?? 'text-ink-2';
  return (
    <span
      title={STATUS_TITLE[status]}
      className={`mono inline-flex items-center gap-1.5 text-[10px] tracking-[0.08em] uppercase ${tone}`}
    >
      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" />
      {status}
    </span>
  );
}

export function StatusChip({ status }: { status: string }) {
  const tone = status === 'complete' ? 'good' : status === 'error' ? 'bad' : 'warn';
  return <Chip tone={tone} title={STATUS_TITLE[status]}>{status}</Chip>;
}

export function TokenSourceChip({ source }: { source: string }) {
  if (source === 'provider') {
    return <Chip tone="good" title="Counts reported by the provider in the agent's own transcript">provider</Chip>;
  }
  if (source === 'proxy') {
    return <Chip tone="good" title="Counts observed in transit by the local proxy">proxy</Chip>;
  }
  if (source === 'estimated') {
    return (
      <Chip tone="warn" inferred title="Estimated locally — NOT provider-reported. Never mix with reported counts.">
        estimated
      </Chip>
    );
  }
  return (
    <Chip tone="warn" inferred title="No token counts were reported for this turn. Not the same as zero.">
      no tokens
    </Chip>
  );
}

export function CostChip({ source }: { source: string }) {
  if (source === 'free_local') {
    return <Chip tone="good" title="Local inference — genuinely zero cost">free</Chip>;
  }
  if (source === 'unpriced') {
    return (
      <Chip tone="warn" inferred title="No rate exists for this (provider, model) at this time. Shown as 'not priced', never as $0.00.">
        unpriced
      </Chip>
    );
  }
  return null;
}

export function AttributionChip({ attribution }: { attribution: string }) {
  if (attribution === 'agent') return null;
  return (
    <Chip tone="warn" inferred title="The file changed between the agent reading and writing it, or git was unusable for this repo. The change is kept but not confidently attributed to the agent.">
      uncertain
    </Chip>
  );
}

/** Neutral metadata pill used in the detail header and the top bar. */
export function MetaPill({
  icon,
  children,
  title,
}: {
  icon?: React.ReactNode;
  children: React.ReactNode;
  title?: string;
}) {
  return (
    <span
      title={title}
      className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface-2 px-2 py-1 text-xs text-ink-2"
    >
      {icon}
      <span className="text-ink">{children}</span>
    </span>
  );
}

export { Chip };
