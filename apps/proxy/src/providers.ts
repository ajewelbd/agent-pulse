/**
 * Provider attribution from the upstream host.
 *
 * This is the ONLY authoritative rule in the whole system. The agent name does
 * not imply the provider and neither does the model id: `claude-opus-5` served
 * through OpenRouter, Bedrock or direct is the same string with three
 * different bills and three different data paths. Layer 1 transcripts record
 * neither the provider nor the resolved base URL, so everything backfilled
 * from logs can only ever reach provider_source='model_map' (inference).
 *
 * What the proxy knows that nothing else does is which host it actually
 * connected to. That is a fact, not an inference — hence provider_source='proxy'.
 */

export interface HostRule {
  /** Matched against the hostname, on label boundaries. */
  suffix: string;
  providerKey: string;
  /**
   * Also match when the suffix is joined to a prefix by a HYPHEN inside the
   * same DNS label, e.g. 'us-central1-aiplatform.googleapis.com' for the
   * suffix 'aiplatform.googleapis.com'.
   *
   * Opt-in per rule, never global: a blanket hyphen match would make
   * 'evil-anthropic.com' resolve to anthropic, which is exactly the kind of
   * lookalike this matcher exists to reject.
   */
  allowHyphenPrefix?: boolean;
  note?: string;
}

/**
 * Ordered most-specific-first. A gateway that resells another vendor's models
 * must be listed before any rule that could match the vendor, or traffic gets
 * attributed to the wrong bill.
 */
export const HOST_RULES: HostRule[] = [
  // Gateways first — these resell other vendors' models and price differently.
  { suffix: 'openrouter.ai', providerKey: 'openrouter' },
  { suffix: 'api.githubcopilot.com', providerKey: 'github-copilot' },
  { suffix: 'copilot-proxy.githubusercontent.com', providerKey: 'github-copilot' },

  // Cloud re-hosts. Bedrock and Vertex serve Anthropic models at their own
  // rates, so they must never fall through to the anthropic rule.
  { suffix: 'amazonaws.com', providerKey: 'aws-bedrock', note: 'bedrock-runtime.<region>.amazonaws.com' },
  // Vertex regional endpoints hyphen-join the region: us-central1-aiplatform…
  { suffix: 'aiplatform.googleapis.com', providerKey: 'google-vertex', allowHyphenPrefix: true },
  { suffix: 'openai.azure.com', providerKey: 'azure' },
  { suffix: 'azure.com', providerKey: 'azure' },
  { suffix: 'cognitiveservices.azure.com', providerKey: 'azure' },

  // First-party.
  { suffix: 'api.anthropic.com', providerKey: 'anthropic' },
  { suffix: 'anthropic.com', providerKey: 'anthropic' },
  { suffix: 'api.openai.com', providerKey: 'openai' },
  { suffix: 'openai.com', providerKey: 'openai' },
  { suffix: 'generativelanguage.googleapis.com', providerKey: 'google' },
  { suffix: 'googleapis.com', providerKey: 'google' },
  { suffix: 'dashscope.aliyuncs.com', providerKey: 'dashscope' },
  { suffix: 'dashscope-intl.aliyuncs.com', providerKey: 'dashscope' },
  { suffix: 'aliyuncs.com', providerKey: 'dashscope' },
];

/** Hosts that mean "inference is running on this machine". */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0', 'host.docker.internal']);

/** Match on label boundaries: 'notopenai.com' must not match 'openai.com'. */
function hostMatches(host: string, rule: HostRule): boolean {
  if (host === rule.suffix || host.endsWith(`.${rule.suffix}`)) return true;
  return rule.allowHyphenPrefix === true && host.endsWith(`-${rule.suffix}`);
}

/**
 * Resolve a provider key from an upstream host.
 *
 * Returns 'unknown' rather than guessing past the rules — the spec is explicit
 * that attribution stops at unknown rather than inventing a fourth tier.
 */
export function providerForHost(host: string): string {
  const clean = host.toLowerCase().split(':')[0] ?? '';
  if (clean === '') return 'unknown';

  // Local inference is genuinely free at the point of use, and that changes
  // cost handling (cost_source='free_local'), so it is decided before the
  // suffix table.
  if (LOCAL_HOSTS.has(clean) || clean.endsWith('.local')) return 'ollama';

  for (const rule of HOST_RULES) {
    if (hostMatches(clean, rule)) return rule.providerKey;
  }
  return 'unknown';
}

/** True when inference ran on this machine, so the turn costs nothing. */
export function isLocalProvider(providerKey: string): boolean {
  return providerKey === 'ollama';
}
