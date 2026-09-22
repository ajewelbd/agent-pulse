import { AttributionChip } from './Chips';
import { bytes } from '@/lib/format';
import type { FileChangeRow } from '@/lib/queries';

/**
 * Unified-diff renderer.
 *
 * Syntax highlighting here is DIFF syntax — hunk headers, additions, removals,
 * context — which is the structure that carries the meaning in a diff. Per
 * language tokenizing would mean shipping a highlighter and a grammar set for
 * every language in the corpus, for a marginal gain over the +/- colouring
 * that reviewers actually read.
 *
 * Collapsed by default via <details>: a turn can touch dozens of files, and
 * rendering every diff open makes the page unusable. No client JavaScript is
 * needed for that — <details> is native.
 */

function DiffBody({ diff }: { diff: string }) {
  const lines = diff.split('\n');
  return (
    <pre className="mono overflow-x-auto rounded-b-lg bg-surface text-[12px] leading-[1.5]">
      <code className="block">
        {lines.map((line, i) => {
          let cls = 'text-ink-2';
          if (line.startsWith('@@')) cls = 'text-accent bg-surface-2';
          else if (line.startsWith('+++') || line.startsWith('---')) cls = 'text-ink-2 font-medium';
          else if (line.startsWith('+')) cls = 'text-add bg-add-bg';
          else if (line.startsWith('-')) cls = 'text-del bg-del-bg';
          else cls = 'text-ink';
          return (
            <span key={i} className={`block whitespace-pre px-3 ${cls}`}>
              {line === '' ? ' ' : line}
            </span>
          );
        })}
      </code>
    </pre>
  );
}

const CHANGE_TONE: Record<string, string> = {
  add: 'text-add',
  delete: 'text-del',
  modify: 'text-ink-2',
  rename: 'text-accent',
};

export function FileChangeList({ changes }: { changes: FileChangeRow[] }) {
  if (changes.length === 0) {
    return (
      <p className="rounded-lg border border-line p-4 text-sm text-ink-2">
        No file changes recorded for this turn.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {changes.map((fc) => (
        <details key={fc.id} className="overflow-hidden rounded-lg border border-line">
          <summary className="flex cursor-pointer select-none flex-wrap items-center gap-2 bg-surface-2 px-3 py-2 text-sm">
            <span className={`text-[11px] font-semibold uppercase ${CHANGE_TONE[fc.change_type] ?? ''}`}>
              {fc.change_type}
            </span>
            <span className="mono truncate text-xs" title={fc.path}>
              {fc.old_path ? `${fc.old_path} → ${fc.path}` : fc.path}
            </span>
            <span className="ml-auto flex items-center gap-2 text-xs">
              {fc.lines_added !== null && <span className="text-add">+{fc.lines_added}</span>}
              {fc.lines_removed !== null && <span className="text-del">−{fc.lines_removed}</span>}
              <AttributionChip attribution={fc.attribution} />
            </span>
          </summary>

          {fc.is_binary ? (
            <p className="px-3 py-2 text-xs text-ink-2">
              Binary file — change type and sizes recorded, no diff body stored.
            </p>
          ) : fc.unified_diff ? (
            <>
              {fc.is_truncated && (
                <p className="border-b border-line bg-warn-bg px-3 py-1.5 text-xs text-warn">
                  Diff truncated to fit the size cap — showing head and tail of {bytes(fc.byte_size)}.
                  The change itself was recorded in full; only the stored body is abbreviated.
                </p>
              )}
              <DiffBody diff={fc.unified_diff} />
            </>
          ) : (
            <p className="px-3 py-2 text-xs text-ink-2">
              No diff body was captured for this change.
            </p>
          )}
        </details>
      ))}
    </div>
  );
}
