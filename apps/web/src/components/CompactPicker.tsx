'use client';

import { DRAG_MIME, useCompact, type CompactTurnRef } from './CompactSelection';
import { IconCheck, IconGrip } from './icons';

/**
 * The controls that put a turn in the tray: a checkbox and a drag handle.
 *
 * Both exist because they answer different questions. The checkbox is how you
 * pick six rows while reading down the list, and it is the only one a keyboard
 * or a screen reader can use. The drag handle is how you pick one row you are
 * already looking at, without moving your eye to a target.
 *
 * The handle is what carries `draggable`, not the row. A table row is full of
 * links, and links are natively draggable — making the row draggable too means
 * every drag that starts on a link drags the link's href instead of the turn,
 * intermittently and depending on exactly where the pointer went down.
 */

function Checkbox({ turn }: { turn: CompactTurnRef }) {
  const { has, toggle, ready } = useCompact();
  const checked = has(turn.id);

  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={`Stage turn #${turn.seq} for compaction`}
      // Until the tray is read back from sessionStorage every box would render
      // unchecked, then snap — the same flash the theme boot script exists to
      // prevent. Disabled for that one frame instead.
      disabled={!ready}
      onClick={() => toggle(turn)}
      className={`flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded-[5px] border transition-colors ${
        checked
          ? 'border-accent bg-accent text-accent-ink'
          : 'border-line bg-surface hover:border-ink-3'
      }`}
    >
      {checked && <IconCheck className="h-3 w-3" strokeWidth={3} />}
    </button>
  );
}

export function CompactPicker({ turn }: { turn: CompactTurnRef }) {
  const { setDragging } = useCompact();

  return (
    <td className="w-13 py-3 pr-0 pl-3 align-top">
      <div className="flex items-center gap-1.5">
        <span
          draggable
          role="button"
          tabIndex={-1}
          aria-hidden="true"
          title="Drag this turn onto the compact dock"
          onDragStart={(event) => {
            event.dataTransfer.setData(DRAG_MIME, JSON.stringify(turn));
            // A plain-text copy so dropping outside the app does something
            // sensible rather than nothing.
            event.dataTransfer.setData('text/plain', `turn #${turn.seq}: ${turn.label}`);
            event.dataTransfer.effectAllowed = 'copy';
            // Drag the row, not the four-pixel handle the pointer is on.
            const row = event.currentTarget.closest('tr');
            if (row) event.dataTransfer.setDragImage(row, 40, 20);
            setDragging(turn);
          }}
          onDragEnd={() => setDragging(null)}
          className="cursor-grab text-ink-3 opacity-0 transition-opacity group-hover:opacity-100 active:cursor-grabbing"
        >
          <IconGrip className="h-3.5 w-3.5" />
        </span>
        <Checkbox turn={turn} />
      </div>
    </td>
  );
}

/**
 * The header box: stage or clear every turn on this page.
 *
 * "Every turn on this page", never every turn in the filter — a filter can hold
 * thousands, and a control that silently staged them would produce a block no
 * context could hold. The title says which it is.
 */
export function CompactPickerAll({ turns }: { turns: CompactTurnRef[] }) {
  const { entries, add, remove, ready } = useCompact();
  const staged = turns.filter((t) => entries.some((e) => e.ref.id === t.id)).length;
  const all = turns.length > 0 && staged === turns.length;
  const some = staged > 0 && !all;

  return (
    <th className="w-13 py-2.5 pr-0 pl-3 text-left">
      <button
        type="button"
        role="checkbox"
        aria-checked={all ? 'true' : some ? 'mixed' : 'false'}
        aria-label="Stage every turn on this page for compaction"
        title={`Stage all ${turns.length} turns on this page`}
        disabled={!ready}
        onClick={() => {
          if (all) turns.forEach((t) => remove(t.id));
          else turns.forEach((t) => add(t));
        }}
        className={`flex h-4.5 w-4.5 items-center justify-center rounded-[5px] border transition-colors ${
          all || some ? 'border-accent bg-accent text-accent-ink' : 'border-line bg-surface hover:border-ink-3'
        }`}
      >
        {all && <IconCheck className="h-3 w-3" strokeWidth={3} />}
        {some && <span className="h-0.5 w-2 rounded-full bg-accent-ink" />}
      </button>
    </th>
  );
}

/** "4 selected" beside the results count. Absent when nothing is staged. */
export function CompactCount() {
  const { entries, setOpen } = useCompact();
  if (entries.length === 0) return null;
  return (
    <button
      type="button"
      onClick={() => setOpen(true)}
      className="mono rounded-md border border-accent/40 bg-accent-soft px-2 py-0.5 text-[11px] text-accent hover:border-accent"
    >
      {entries.length} selected
    </button>
  );
}
