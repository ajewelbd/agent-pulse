'use client';

import { useState } from 'react';
import { IconChevronDown } from './icons';

/**
 * Height-clamped block with a reveal.
 *
 * A single turn's response can run to tens of thousands of characters, which
 * pushes everything below it — commands, file changes — off the page. The body
 * is already on the client, so this only hides it; nothing is fetched on
 * expand, and the button says "show", not "load".
 */
export function Collapsible({
  children,
  maxHeight = 420,
  showLabel = 'Show full response',
  hideLabel = 'Collapse',
}: {
  children: React.ReactNode;
  maxHeight?: number;
  showLabel?: string;
  hideLabel?: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div>
      <div className="relative overflow-hidden" style={open ? undefined : { maxHeight }}>
        {children}
        {!open && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-20 bg-gradient-to-t from-[var(--surface)] to-transparent" />
        )}
      </div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="mt-3 flex items-center gap-1.5 rounded-lg border border-line bg-surface px-3 py-1.5 text-xs text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink"
      >
        <IconChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? 'rotate-180' : ''}`} />
        {open ? hideLabel : showLabel}
      </button>
    </div>
  );
}
