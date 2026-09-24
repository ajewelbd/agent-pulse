import { randomUUID } from 'node:crypto';

/**
 * Handing a finished compaction to the collector to store.
 *
 * The dashboard does not write to its own database. That is not an oversight to
 * route around — the pool sets `default_transaction_read_only=on` precisely so
 * that a future feature cannot quietly start mutating ingested history, and
 * this is that future feature. So the write goes where writes already live: the
 * collector, over the same authenticated endpoint the hooks use.
 *
 * Saving is BEST EFFORT and deliberately so. A compaction that ran is a result
 * the user is entitled to see; failing to file it away afterwards must not take
 * that result off the screen. Every failure is returned, named, for the panel
 * to show beside the output rather than swallowed.
 */

export interface SaveResult {
  saved: boolean;
  /** Why not, when not. Shown to the user; never silently dropped. */
  error?: string;
}

function collectorUrl(): string {
  return (process.env.COLLECTOR_URL ?? 'http://127.0.0.1:4317').replace(/\/+$/, '');
}

export function compactionSavingConfigured(): boolean {
  return Boolean(process.env.COLLECTOR_SHARED_SECRET);
}

export async function saveCompaction(record: {
  turnId: string;
  provider: string;
  model: string;
  length: string;
  parts: string[];
  summarized: boolean;
  reason: string | null;
  output: string;
  inputTokens: number | null;
  outputTokens: number | null;
  estimatedInputTokens: number;
}): Promise<SaveResult> {
  const secret = process.env.COLLECTOR_SHARED_SECRET;
  if (!secret) {
    return {
      saved: false,
      error:
        'COLLECTOR_SHARED_SECRET is not set for the dashboard, so this compaction was not saved to history.',
    };
  }

  try {
    const response = await fetch(`${collectorUrl()}/v1/compactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-aiuo-secret': secret },
      // Generated here rather than by the browser: it is what makes a retry
      // free, and a client-supplied id would let one page write twice under
      // two ids for a single press.
      body: JSON.stringify({ requestId: randomUUID(), ...record }),
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      return { saved: false, error: `collector refused it (${response.status})${detail ? `: ${detail.slice(0, 200)}` : ''}` };
    }
    return { saved: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error';
    return { saved: false, error: `could not reach the collector at ${collectorUrl()} — ${message}` };
  }
}
