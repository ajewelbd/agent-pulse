'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { IconInfo } from './icons';

/**
 * An info icon whose panel explains the number beside it.
 *
 * Fixed-positioned and portalled to `document.body`, for two separate reasons:
 *
 *   - most of the triggers sit inside `overflow-x-auto` table wrappers, which
 *     clip a positioned child — the panel would be cut off at the cell edge
 *     exactly where it is most needed;
 *   - the triggers sit in headings and eyebrow rows, which set
 *     `text-transform: uppercase` and letter-spacing. Rendered in place the
 *     panel inherited them and shouted its whole body in caps.
 *
 * The cost is having to place it by hand and to close on scroll, since a fixed
 * panel does not travel with its anchor.
 *
 * Hover is the ask, but hover alone excludes keyboard and touch, so the
 * trigger is a real button: focus opens it and Escape closes it.
 */
export function InfoTip({
  label,
  children,
  width = 320,
}: {
  /** What the panel explains, for screen readers: "how this cost was calculated". */
  label: string;
  children: React.ReactNode;
  width?: number;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelClose = useCallback(() => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = null;
  }, []);

  // A short grace period so the pointer can travel from the icon into the
  // panel — these hold text worth selecting, not one-word labels.
  const scheduleClose = useCallback(() => {
    cancelClose();
    closeTimer.current = setTimeout(() => setOpen(false), 120);
  }, [cancelClose]);

  useEffect(() => cancelClose, [cancelClose]);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const place = () => {
      const anchor = anchorRef.current?.getBoundingClientRect();
      if (!anchor) return;
      const height = panelRef.current?.offsetHeight ?? 0;
      const gap = 8;
      const below = anchor.bottom + gap;
      // Flip above when the panel would run off the bottom, unless there is
      // even less room up there.
      const fitsBelow = below + height <= window.innerHeight - gap;
      const top = fitsBelow || anchor.top - gap - height < gap ? below : anchor.top - gap - height;
      // Centre on the icon, then pull back inside the viewport.
      const wanted = anchor.left + anchor.width / 2 - width / 2;
      const left = Math.max(gap, Math.min(wanted, window.innerWidth - width - gap));
      setPos({ top, left });
    };
    place();

    // A fixed panel does not follow its anchor, so a scroll would leave it
    // stranded next to an unrelated row.
    const onScroll = () => setOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', place);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', place);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, width]);

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        aria-label={label}
        aria-expanded={open}
        onMouseEnter={() => {
          cancelClose();
          setOpen(true);
        }}
        onMouseLeave={scheduleClose}
        onFocus={() => setOpen(true)}
        onBlur={scheduleClose}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex shrink-0 items-center text-ink-3 transition-colors hover:text-accent focus-visible:text-accent"
      >
        <IconInfo className="h-3.5 w-3.5" />
      </button>

      {open &&
        createPortal(
          <div
            ref={panelRef}
            role="tooltip"
            onMouseEnter={cancelClose}
            onMouseLeave={scheduleClose}
            style={{
              top: pos?.top ?? 0,
              left: pos?.left ?? 0,
              width,
              // Measured on the first paint, placed on the second. Hidden
              // until then, so it never flashes in the top-left corner.
              visibility: pos ? 'visible' : 'hidden',
            }}
            className="fixed z-50 rounded-xl border border-line bg-surface p-3 text-left text-sm normal-case tracking-normal text-ink shadow-xl"
          >
            {children}
          </div>,
          document.body,
        )}
    </>
  );
}

/** The shared shape of an InfoTip's contents: a heading, a body, a footnote. */
export function TipTitle({ children }: { children: React.ReactNode }) {
  return <div className="eyebrow mb-2">{children}</div>;
}

export function TipNote({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-2 border-t border-line-soft pt-2 text-[11px] leading-relaxed text-ink-2">
      {children}
    </p>
  );
}
