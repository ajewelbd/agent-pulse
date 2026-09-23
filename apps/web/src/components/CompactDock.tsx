'use client';

import { useState } from 'react';
import { DRAG_MIME, useCompact, type CompactTurnRef } from './CompactSelection';
import { IconChevronRight, IconCompact } from './icons';

/**
 * The floating dock — drop target and the way into the compact panel.
 *
 * Four states, and the shape of the control says which one it is in:
 *
 *   resting   a 60px circle, parked 30px from the bottom-right corner
 *   armed     expands to a pill as soon as a turn is staged, badged with the count
 *   drag over a dashed accent ring while a row is held over it
 *   working   a spinning ring while the model runs
 *
 * `dragOver` is counted rather than set to a boolean. dragenter/dragleave fire
 * for every child element the pointer crosses, so a boolean flickers off the
 * moment the cursor moves from the pill onto the badge inside it. The depth
 * counter only reaches zero when the pointer has actually left the dock.
 */
export function CompactDock({ working }: { working: boolean }) {
  const { entries, add, dragging, setDragging, setOpen, ready } = useCompact();
  const [depth, setDepth] = useState(0);
  const over = depth > 0;

  // Nothing at all until the tray has been read back, so the dock does not
  // render resting and then jump to armed on the same page load.
  if (!ready) return null;

  const count = entries.length;
  const armed = count > 0;

  const accept = (event: React.DragEvent): CompactTurnRef | null => {
    const raw = event.dataTransfer.getData(DRAG_MIME);
    if (!raw) return null;
    try {
      const ref: unknown = JSON.parse(raw);
      if (ref && typeof ref === 'object' && typeof (ref as CompactTurnRef).id === 'string') {
        return ref as CompactTurnRef;
      }
    } catch {
      // A drag carrying our mime type but not our payload is not ours.
    }
    return null;
  };

  return (
    <div
      onDragEnter={(event) => {
        if (event.dataTransfer.types.includes(DRAG_MIME)) setDepth((d) => d + 1);
      }}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes(DRAG_MIME)) return;
        // Without this the browser's default handling runs and the drop event
        // never fires at all.
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
      }}
      onDragLeave={() => setDepth((d) => Math.max(0, d - 1))}
      onDrop={(event) => {
        event.preventDefault();
        setDepth(0);
        setDragging(null);
        const ref = accept(event);
        if (ref) add(ref);
      }}
      className="fixed right-[30px] bottom-[30px] z-40"
    >
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={armed ? `Compact ${count} turns` : 'Compact turns — drag turns here to start'}
        title={armed ? `Open the compact panel (${count} staged)` : 'Drag turns here, or tick their checkboxes'}
        className={`group relative flex items-center gap-3 border bg-surface shadow-[0_8px_30px_rgb(0_0_0/0.16)] transition-all duration-200 ${
          armed || over ? 'rounded-full py-2.5 pr-2.5 pl-3' : 'h-15 w-15 justify-center rounded-full'
        } ${
          over
            ? 'border-2 border-dashed border-accent ring-4 ring-accent/20'
            : armed
              ? 'border-accent/40 hover:border-accent'
              : 'border-line hover:border-ink-3'
        }`}
      >
        <span className="relative flex h-10 w-10 shrink-0 items-center justify-center">
          {/* The ring is the working indicator. It sits behind the mark so the
              mark itself never moves between states. */}
          {working && (
            <span className="absolute inset-0 animate-spin rounded-full border-2 border-line border-t-accent" />
          )}
          <span
            className={`flex h-9 w-9 items-center justify-center rounded-full ${
              armed || over ? 'bg-accent-soft text-accent' : 'text-ink-2 group-hover:text-ink'
            }`}
          >
            <IconCompact className="h-5 w-5" />
          </span>
          {armed && !working && (
            <span className="mono absolute -top-1.5 -left-1.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-semibold text-accent-ink">
              {count}
            </span>
          )}
        </span>

        {(armed || over) && (
          <span className="flex flex-col items-start pr-1 text-left">
            <span className="text-[13px] leading-tight font-semibold whitespace-nowrap">
              {working ? 'Compacting…' : over ? 'Drop to add' : `Compact ${count} turn${count === 1 ? '' : 's'}`}
            </span>
            <span className="mono text-[11px] leading-tight whitespace-nowrap text-ink-3">
              {working
                ? `${count} turn${count === 1 ? '' : 's'}`
                : over && dragging
                  ? `turn #${dragging.seq} · ${dragging.costLabel}`
                  : 'Drag turns here to add'}
            </span>
          </span>
        )}

        {(armed || over) && (
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent text-accent-ink">
            <IconChevronRight className="h-4 w-4" />
          </span>
        )}
      </button>
    </div>
  );
}
