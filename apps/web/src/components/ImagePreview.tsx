'use client';

import { useEffect, useState } from 'react';
import { IconClose, IconExpand } from './icons';

/**
 * A screenshot the user attached, with a full-size preview.
 *
 * Screenshots are the one attachment that cannot be read as text — a prompt
 * that says "see the attached screenshot" is unreadable without it. The
 * thumbnail is deliberately the same `src` as the preview rather than a
 * server-side resize: the collector stores exactly what the agent was sent and
 * resizes nothing, so a separate thumbnail would be a second, different
 * artefact to reason about. They are at most a few hundred KB each.
 *
 * `loading="lazy"` keeps a turn with several of them from fetching all of them
 * before the page is interactive.
 */
export function ImagePreview({
  src,
  label,
  meta,
}: {
  src: string;
  label: string;
  meta: string;
}) {
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    // The overlay covers the page; letting the page behind it scroll under the
    // pointer is disorienting.
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [open]);

  if (failed) {
    return (
      <div className="rounded-lg border border-line bg-surface-2 p-3 text-xs text-warn">
        {label} could not be decoded from the stored record.
      </div>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={`${label} — click to preview`}
        className="group/img block w-full overflow-hidden rounded-lg border border-line bg-surface-2 text-left transition-colors hover:border-accent"
      >
        <span className="relative block">
          <img
            src={src}
            alt={label}
            loading="lazy"
            onError={() => setFailed(true)}
            className="block max-h-56 w-full object-cover object-top"
          />
          <span className="absolute top-1.5 right-1.5 flex items-center gap-1 rounded-md bg-[color-mix(in_oklab,var(--surface)_80%,transparent)] px-1.5 py-1 text-[10px] text-ink-2 opacity-0 backdrop-blur transition-opacity group-hover/img:opacity-100">
            <IconExpand className="h-3 w-3" />
            Preview
          </span>
        </span>
        <span className="mono block truncate border-t border-line px-2 py-1.5 text-[10px] text-ink-3">
          {meta}
        </span>
      </button>

      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={label}
          onClick={() => setOpen(false)}
          // Deliberately not themed. A screenshot is judged on its own colours,
          // and a light surround shifts how they read; every image viewer is
          // dark for that reason. Because the backdrop is dark in both themes,
          // the chrome on it is fixed light-on-dark rather than inheriting ink.
          className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-black/80 p-4 backdrop-blur-sm"
        >
          <div className="flex w-full max-w-[min(1400px,95vw)] items-center gap-3">
            <span className="mono truncate text-xs text-white/70">{meta}</span>
            <a
              href={src}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="ml-auto rounded-lg border border-white/20 bg-white/10 px-3 py-1.5 text-xs text-white hover:bg-white/20"
            >
              Open full size
            </a>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close preview"
              className="rounded-lg border border-white/20 bg-white/10 p-1.5 text-white hover:bg-white/20"
            >
              <IconClose className="h-4 w-4" />
            </button>
          </div>
          {/* Stops a click on the image itself from closing the overlay. */}
          <img
            src={src}
            alt={label}
            onClick={(e) => e.stopPropagation()}
            className="max-h-[85vh] max-w-[min(1400px,95vw)] rounded-lg object-contain shadow-2xl"
          />
          <p className="text-[11px] text-white/50">Esc or click the backdrop to close</p>
        </div>
      )}
    </>
  );
}
