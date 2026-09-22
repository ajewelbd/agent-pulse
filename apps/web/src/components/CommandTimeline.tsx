import { bytes, duration, utc } from '@/lib/format';
import { Chip } from './Chips';
import type { ToolCallRow } from '@/lib/queries';

/**
 * Ordered command / tool-call timeline for one turn.
 *
 * The exit-code column is the important honesty point. Layer 1 transcripts
 * record no exit codes, so NULL is the norm here — and NULL is rendered as
 * "unknown", never as 0. Rendering it as success would report every failed
 * command in the archive as having passed.
 *
 * Durations are likewise labelled: a 'derived' duration is wall-clock between
 * the tool_use record and its result, which includes model latency around the
 * call. It is an upper bound, not an execution time, and the UI says so rather
 * than presenting it as a measurement.
 */
export function CommandTimeline({ calls }: { calls: ToolCallRow[] }) {
  if (calls.length === 0) {
    return (
      <p className="rounded-lg border border-line p-4 text-sm text-ink-2">
        No tool calls recorded for this turn.
      </p>
    );
  }

  return (
    <ol className="space-y-2">
      {calls.map((c) => (
        <li key={c.id} className="overflow-hidden rounded-lg border border-line">
          <div className="flex flex-wrap items-center gap-2 bg-surface-2 px-3 py-2">
            <span className="mono text-xs text-ink-2">{String(c.seq).padStart(2, '0')}</span>
            <span className="text-sm font-medium">{c.tool_name}</span>

            {c.exit_code === null ? (
              <Chip tone="warn" title="No exit code was captured. Transcripts do not record one, so tool calls from before hooks were installed can never have it. Never read this as exit 0.">
                exit unknown
              </Chip>
            ) : c.exit_code === 0 ? (
              <Chip tone="good">exit 0</Chip>
            ) : (
              <Chip tone="bad">exit {c.exit_code}</Chip>
            )}

            {c.interrupted && <Chip tone="warn">interrupted</Chip>}
            {c.is_background && <Chip>background</Chip>}

            <span className="ml-auto flex items-center gap-2 text-xs text-ink-2">
              {c.started_at && <span className="mono">{utc(c.started_at)}</span>}
              {c.duration_ms !== null && (
                <span
                  className="mono"
                  title={
                    c.duration_source === 'derived'
                      ? 'Derived from timestamps around the call — includes model latency, so it is an upper bound, not execution time.'
                      : 'Reported by the agent.'
                  }
                >
                  {duration(c.duration_ms)}
                  {c.duration_source === 'derived' && '*'}
                </span>
              )}
            </span>
          </div>

          {c.command && (
            <pre className="mono overflow-x-auto border-t border-line px-3 py-2 text-[12px] leading-relaxed">
              <code>{c.command}</code>
            </pre>
          )}

          {c.cwd && (
            <div className="mono border-t border-line px-3 py-1 text-[11px] text-ink-2">
              cwd: {c.cwd}
            </div>
          )}

          {c.stdout_excerpt && c.stdout_excerpt.trim() !== '' && (
            <details className="border-t border-line">
              <summary className="cursor-pointer select-none px-3 py-1.5 text-xs text-ink-2">
                Output
                {c.stdout_truncated && (
                  <span className="ml-2 text-warn">
                    capped — {bytes(c.stdout_bytes_total)} produced
                  </span>
                )}
              </summary>
              <pre className="mono max-h-96 overflow-auto bg-surface px-3 py-2 text-[12px] leading-[1.45]">
                <code>{c.stdout_excerpt}</code>
              </pre>
            </details>
          )}
        </li>
      ))}
      <li className="px-1 text-[11px] text-ink-2">
        * duration derived from surrounding timestamps — an upper bound that includes model latency.
      </li>
    </ol>
  );
}
