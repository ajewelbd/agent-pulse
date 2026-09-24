'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

/**
 * Which turns are staged for compaction.
 *
 * State lives here rather than in the URL, unlike every filter in this app.
 * That is a deliberate exception and worth saying why: a filter describes a
 * view, and the whole point of putting it in the URL is that the view is
 * linkable and reproducible. A compaction tray is a scratch pad — turns go in
 * and out while the user reads the list — and a URL that rewrote itself on
 * every checkbox would fill the back button with states nobody wants to return
 * to.
 *
 * sessionStorage, not localStorage: the tray survives paging through the list
 * and following a turn into its detail page and back, which is the span of one
 * piece of work. It does not survive closing the tab, because a tray of turns
 * someone assembled last week is not something to silently resurrect.
 */

/**
 * What the tray remembers about a turn.
 *
 * The numbers arrive pre-formatted from the server because the formatters are
 * the ones that enforce "absence is not zero" — `tokensLabel` is already "—"
 * for an unreported turn and `costLabel` already "not priced". The raw values
 * alongside them are nullable for the same reason: they are what the tray's
 * totals sum, and a null is excluded from the sum rather than counted as zero.
 */
export interface CompactTurnRef {
  id: string;
  seq: number;
  label: string;
  ideKind: string | null;
  tokensLabel: string;
  costLabel: string;
  /** NULL when the turn reported no usage — not 0. */
  tokensIn: number | null;
  /** NULL when no rate covered this (provider, model) — not 0. */
  costUsd: number | null;
  sessionShort: string;
}

/** A staged turn. `enabled` is the row checkbox inside the panel: unticking
 *  leaves it in the tray but out of this compaction. */
export interface CompactEntry {
  ref: CompactTurnRef;
  enabled: boolean;
}

export const DRAG_MIME = 'application/x-agentpulse-turn';
const STORE_KEY = 'aiuo.compact';

interface CompactContextValue {
  entries: CompactEntry[];
  /** Null until the tray has been read back from sessionStorage. */
  ready: boolean;
  has: (id: string) => boolean;
  add: (ref: CompactTurnRef) => void;
  remove: (id: string) => void;
  toggle: (ref: CompactTurnRef) => void;
  setEnabled: (id: string, enabled: boolean) => void;
  move: (id: string, toIndex: number) => void;
  clear: () => void;
  /** The turn currently under the cursor in a drag, for the dock's label. */
  dragging: CompactTurnRef | null;
  setDragging: (ref: CompactTurnRef | null) => void;
  open: boolean;
  setOpen: (open: boolean) => void;
}

const CompactContext = createContext<CompactContextValue | null>(null);

export function useCompact(): CompactContextValue {
  const value = useContext(CompactContext);
  if (!value) throw new Error('useCompact used outside <CompactProvider>');
  return value;
}

function read(): CompactEntry[] {
  try {
    const raw = window.sessionStorage.getItem(STORE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Shape-checked rather than trusted: this came back from storage a browser
    // session ago and may predate a change to CompactTurnRef.
    return parsed.filter(
      (e): e is CompactEntry =>
        !!e && typeof e === 'object' && 'ref' in e && typeof (e as CompactEntry).ref?.id === 'string',
    );
  } catch {
    return [];
  }
}

export function CompactProvider({ children }: { children: React.ReactNode }) {
  const [entries, setEntries] = useState<CompactEntry[]>([]);
  const [ready, setReady] = useState(false);
  const [dragging, setDragging] = useState<CompactTurnRef | null>(null);
  const [open, setOpen] = useState(false);

  // Read after mount, not during render: the server has no sessionStorage, so
  // seeding from it directly would hydrate against markup that never had it.
  useEffect(() => {
    setEntries(read());
    setReady(true);
  }, []);

  useEffect(() => {
    if (!ready) return;
    try {
      window.sessionStorage.setItem(STORE_KEY, JSON.stringify(entries));
    } catch {
      // A storage denial costs the tray its persistence across pages, which is
      // not worth breaking the tray itself over.
    }
  }, [entries, ready]);

  const has = useCallback((id: string) => entries.some((e) => e.ref.id === id), [entries]);

  const add = useCallback((ref: CompactTurnRef) => {
    setEntries((prev) => (prev.some((e) => e.ref.id === ref.id) ? prev : [...prev, { ref, enabled: true }]));
  }, []);

  const remove = useCallback((id: string) => {
    setEntries((prev) => prev.filter((e) => e.ref.id !== id));
  }, []);

  const toggle = useCallback((ref: CompactTurnRef) => {
    setEntries((prev) =>
      prev.some((e) => e.ref.id === ref.id)
        ? prev.filter((e) => e.ref.id !== ref.id)
        : [...prev, { ref, enabled: true }],
    );
  }, []);

  const setEnabled = useCallback((id: string, enabled: boolean) => {
    setEntries((prev) => prev.map((e) => (e.ref.id === id ? { ...e, enabled } : e)));
  }, []);

  const move = useCallback((id: string, toIndex: number) => {
    setEntries((prev) => {
      const from = prev.findIndex((e) => e.ref.id === id);
      if (from === -1 || toIndex < 0 || toIndex >= prev.length || from === toIndex) return prev;
      const next = [...prev];
      const [entry] = next.splice(from, 1);
      next.splice(toIndex, 0, entry!);
      return next;
    });
  }, []);

  const clear = useCallback(() => setEntries([]), []);

  const value = useMemo(
    () => ({ entries, ready, has, add, remove, toggle, setEnabled, move, clear, dragging, setDragging, open, setOpen }),
    [entries, ready, has, add, remove, toggle, setEnabled, move, clear, dragging, open],
  );

  return <CompactContext.Provider value={value}>{children}</CompactContext.Provider>;
}

/**
 * What the tray adds up to.
 *
 * Unknown values are counted separately rather than folded in as zero, so a
 * tray holding three priced turns and one unpriced one says "$9.12 · 1 not
 * priced" instead of implying the fourth turn was free. Same rule the
 * aggregates page follows for `unpriced_turns`.
 */
export function trayTotals(entries: CompactEntry[]): {
  turns: number;
  tokensIn: number;
  unknownTokens: number;
  costUsd: number;
  unpriced: number;
} {
  const on = entries.filter((e) => e.enabled);
  let tokensIn = 0;
  let unknownTokens = 0;
  let costUsd = 0;
  let unpriced = 0;
  for (const { ref } of on) {
    if (ref.tokensIn === null) unknownTokens += 1;
    else tokensIn += ref.tokensIn;
    if (ref.costUsd === null) unpriced += 1;
    else costUsd += ref.costUsd;
  }
  return { turns: on.length, tokensIn, unknownTokens, costUsd, unpriced };
}
