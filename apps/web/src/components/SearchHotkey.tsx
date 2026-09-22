'use client';

import { useEffect } from 'react';

/**
 * `/` focuses the search box — the hint rendered inside the box promises it,
 * so it has to exist. Renders nothing; it is only here for the listener.
 */
export function SearchHotkey() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      // Never steal the key from something the user is typing into.
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      const input = document.getElementById('turn-search');
      if (input instanceof HTMLInputElement) {
        e.preventDefault();
        input.focus();
        input.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return null;
}
