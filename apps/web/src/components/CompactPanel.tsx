'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { CompactDock } from './CompactDock';
import { DRAG_MIME, trayTotals, useCompact, type CompactTurnRef } from './CompactSelection';
import { CopyButton } from './CopyButton';
import {
  COMPACT_PARTS,
  DEFAULT_COMPACT_MODEL,
  DEFAULT_COMPACT_PROVIDER,
  DEFAULT_PARTS,
  type CompactLength,
  type CompactModel,
  type CompactPart,
  type CompactProviderKey,
} from '@/lib/compact';
import { compactNum } from '@/lib/format';
import { IconChevronDown, IconClose, IconCompact, IconDownload, IconGrip, IconPlus, IconSparkle, IconWarning } from './icons';

/**
 * The compact panel: pick turns, choose what goes in, fold them into one block.
 *
 * What the panel has to keep straight is that TWO different things can come out
 * of the button, and conflating them would be the whole feature's undoing:
 *
 *   the assembled record — built from the database, always, locally
 *   a summary of it     — only when a model is configured and actually answered
 *
 * The output header says which one is on screen every time. A summary that
 * silently stood in for the record, or a record that looked like a summary,
 * would be a claim about what happened that nobody could check.
 */

interface Result {
  output: string;
  assembled: string;
  summarized: boolean;
  reason?: string;
  provider: CompactProviderKey;
  model: string;
  turns: number;
  missing: number;
  outputTruncated?: boolean;
  estimatedInputTokens: number;
  usage?: { inputTokens: number | null; outputTokens: number | null; cacheReadTokens: number | null };
}

interface ProviderStatus {
  key: CompactProviderKey;
  label: string;
  local: boolean;
  available: boolean;
  reason?: string;
  models: CompactModel[];
}

const LENGTHS: Array<{ key: CompactLength; label: string }> = [
  { key: 'brief', label: 'Brief' },
  { key: 'standard', label: 'Standard' },
  { key: 'detailed', label: 'Detailed' },
];

function Select({
  label,
  value,
  onChange,
  children,
  title,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: React.ReactNode;
  title?: string;
}) {
  return (
    <label
      title={title}
      className="relative inline-flex items-center gap-2 rounded-lg border border-line bg-surface py-2 pr-7 pl-3 text-xs"
    >
      <span className="shrink-0 text-ink-3">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="pill-select cursor-pointer truncate bg-transparent font-medium text-ink outline-none"
      >
        {children}
      </select>
      <IconChevronDown className="pointer-events-none absolute right-2 h-3.5 w-3.5 text-ink-3" />
    </label>
  );
}

/** One staged turn. Reorderable, because the block reads in this order. */
function TrayRow({
  entry,
  index,
  onDropAt,
}: {
  entry: { ref: CompactTurnRef; enabled: boolean };
  index: number;
  onDropAt: (id: string, index: number) => void;
}) {
  const { remove, setEnabled } = useCompact();
  const [over, setOver] = useState(false);
  const { ref, enabled } = entry;

  return (
    <li
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes(DRAG_MIME)) return;
        event.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => {
        event.preventDefault();
        setOver(false);
        const raw = event.dataTransfer.getData(DRAG_MIME);
        if (!raw) return;
        try {
          const dropped: unknown = JSON.parse(raw);
          if (dropped && typeof dropped === 'object' && typeof (dropped as CompactTurnRef).id === 'string') {
            onDropAt((dropped as CompactTurnRef).id, index);
          }
        } catch {
          // Not our payload.
        }
      }}
      className={`flex items-center gap-2.5 border-b border-line-soft px-3 py-2.5 last:border-0 ${
        over ? 'bg-accent-soft' : ''
      } ${enabled ? '' : 'opacity-50'}`}
    >
      <span
        draggable
        aria-hidden="true"
        title="Drag to reorder — the block reads in this order"
        onDragStart={(event) => {
          event.dataTransfer.setData(DRAG_MIME, JSON.stringify(ref));
          event.dataTransfer.effectAllowed = 'move';
        }}
        className="cursor-grab text-ink-3 active:cursor-grabbing"
      >
        <IconGrip className="h-3.5 w-3.5" />
      </span>

      <input
        type="checkbox"
        checked={enabled}
        onChange={(event) => setEnabled(ref.id, event.target.checked)}
        aria-label={`Include turn #${ref.seq} in this compaction`}
        title="Unticking keeps the turn staged but leaves it out of this block"
        className="h-4 w-4 shrink-0 accent-[var(--accent)]"
      />

      {ref.ideKind && (
        <span
          title="This turn carried an editor-context block alongside the prompt."
          className="mono shrink-0 rounded border border-line bg-surface-2 px-1.5 py-0.5 text-[10px] text-ink-3"
        >
          {ref.ideKind === 'ide_selection' ? 'selection' : 'ide context'}
        </span>
      )}

      <span className="min-w-0 flex-1 truncate text-[13px]" title={ref.label}>
        {ref.label}
      </span>

      <span className="mono shrink-0 text-[11px] text-ink-3">#{ref.seq}</span>
      <span className="mono w-16 shrink-0 text-right text-[11px] text-ink-2">{ref.tokensLabel}</span>
      <span className="mono w-20 shrink-0 text-right text-xs font-medium">{ref.costLabel}</span>

      <button
        type="button"
        onClick={() => remove(ref.id)}
        aria-label={`Remove turn #${ref.seq} from the tray`}
        className="shrink-0 rounded p-1 text-ink-3 hover:bg-surface-2 hover:text-ink"
      >
        <IconClose className="h-3.5 w-3.5" />
      </button>
    </li>
  );
}

function OutputPanel({ result }: { result: Result }) {
  const download = useCallback(() => {
    const blob = new Blob([result.output], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `compacted-${result.turns}-turns.md`;
    a.click();
    URL.revokeObjectURL(url);
  }, [result]);

  return (
    <div className="border-t border-line px-5 py-4">
      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="eyebrow">Compacted output</span>
        <span className="mono text-[11px] text-ink-2">
          {result.summarized ? `${result.model} · ${result.provider}` : 'assembled record — no model'}
          {' · '}
          {/* Real counts when a model ran and reported them — the Anthropic
              usage block, or Ollama's own eval counts. The char/4 estimate is
              labelled as one, so the two are never read as the same thing. */}
          {result.usage?.outputTokens != null
            ? `${compactNum(result.usage.outputTokens)} tokens out`
            : `~${compactNum(result.estimatedInputTokens)} tokens (est.)`}
        </span>

        <div className="ml-auto flex items-center gap-2">
          <CopyButton value={result.output} title="Copy the block to the clipboard" />
          <button
            type="button"
            onClick={download}
            className="flex items-center gap-1.5 rounded-lg border border-line bg-surface px-3 py-1.5 text-xs text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink"
          >
            <IconDownload className="h-3.5 w-3.5" />
            Download .md
          </button>
        </div>
      </div>

      {/* Every way this could be less than it appears, said out loud. */}
      {result.reason && (
        <p className="mb-2 flex items-start gap-2 rounded-lg border border-warn-line bg-warn-bg px-3 py-2 text-xs text-warn">
          <IconWarning className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {result.reason}
        </p>
      )}
      {result.outputTruncated && (
        <p className="mb-2 text-xs text-warn">
          The model hit its output limit — this block is cut off at the end.
        </p>
      )}
      {result.missing > 0 && (
        <p className="mb-2 text-xs text-warn">
          {result.missing} staged turn{result.missing === 1 ? '' : 's'} no longer exist in the database and
          {result.missing === 1 ? ' was' : ' were'} left out.
        </p>
      )}

      <pre className="mono max-h-80 overflow-auto rounded-lg border border-line bg-surface-2 p-4 text-[12px] leading-relaxed whitespace-pre-wrap">
        {result.output}
      </pre>
    </div>
  );
}

function Modal({
  working,
  setWorking,
}: {
  working: boolean;
  setWorking: (working: boolean) => void;
}) {
  const { entries, add, move, clear, setOpen } = useCompact();
  // "provider:model", so one <select> can span both lists without the two
  // halves of the choice ever drifting apart.
  const [choice, setChoice] = useState(`${DEFAULT_COMPACT_PROVIDER}:${DEFAULT_COMPACT_MODEL}`);
  const [providers, setProviders] = useState<ProviderStatus[] | null>(null);
  const [length, setLength] = useState<CompactLength>('brief');
  const [parts, setParts] = useState<CompactPart[]>(DEFAULT_PARTS);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dropping, setDropping] = useState(false);
  const abort = useRef<AbortController | null>(null);

  const totals = trayTotals(entries);
  const enabled = entries.filter((e) => e.enabled);
  const chosenProvider = providers?.find((p) => p.key === choice.slice(0, choice.indexOf(':')));
  const chosenModel = chosenProvider?.models.find((m) => m.id === choice.slice(choice.indexOf(':') + 1));

  const close = useCallback(() => {
    abort.current?.abort();
    setOpen(false);
  }, [setOpen]);

  // Esc cancels a run in progress and keeps the tray, exactly as the dock's
  // working state promises; a second Esc closes the panel.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (abort.current) {
        abort.current.abort();
        return;
      }
      close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);

  // The page behind the panel must not scroll under it.
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  useEffect(() => () => abort.current?.abort(), []);

  // Asked for when the panel opens, not at build time: which Ollama models
  // exist is a fact about this machine right now, and the daemon may have been
  // started since the page loaded.
  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/compact/models', { signal: controller.signal })
      .then((r) => r.json())
      .then((data: { providers?: ProviderStatus[] }) => {
        const list = data.providers ?? [];
        setProviders(list);
        // Move off the default only if it is not actually available, so the
        // panel opens on something that can run rather than on a dead choice.
        const usable = list.filter((p) => p.available && p.models.length > 0);
        const current = list.find((p) => p.key === choice.split(':')[0]);
        const stillThere = current?.available && current.models.some((m) => m.id === choice.slice(choice.indexOf(':') + 1));
        if (!stillThere && usable[0]?.models[0]) {
          setChoice(`${usable[0].key}:${usable[0].models[0].id}`);
        }
      })
      .catch(() => {
        // The dropdown falls back to the built-in Anthropic list; assembly
        // does not depend on this call at all.
      });
    return () => controller.abort();
    // Deliberately once per open: re-running on every choice change would
    // fight the user's own selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = async () => {
    if (enabled.length === 0 || parts.length === 0) return;
    const controller = new AbortController();
    abort.current = controller;
    setWorking(true);
    setError(null);
    try {
      const response = await fetch('/api/compact', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          turnIds: enabled.map((e) => e.ref.id),
          parts,
          length,
          provider: choice.slice(0, choice.indexOf(':')),
          model: choice.slice(choice.indexOf(':') + 1),
        }),
        signal: controller.signal,
      });
      const data: unknown = await response.json();
      if (!response.ok) {
        const message =
          data && typeof data === 'object' && 'error' in data ? String((data as { error: unknown }).error) : 'request failed';
        setError(message);
        return;
      }
      setResult(data as Result);
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === 'AbortError') return;
      setError(caught instanceof Error ? caught.message : 'request failed');
    } finally {
      abort.current = null;
      setWorking(false);
    }
  };

  const togglePart = (part: CompactPart) =>
    setParts((prev) => (prev.includes(part) ? prev.filter((p) => p !== part) : [...prev, part]));

  const dropZone = (event: React.DragEvent) => {
    event.preventDefault();
    setDropping(false);
    const raw = event.dataTransfer.getData(DRAG_MIME);
    if (!raw) return;
    try {
      const ref: unknown = JSON.parse(raw);
      if (ref && typeof ref === 'object' && typeof (ref as CompactTurnRef).id === 'string') {
        add(ref as CompactTurnRef);
      }
    } catch {
      // Not our payload.
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4 backdrop-blur-sm sm:p-8">
      {/* The backdrop closes the panel; the card stops the click reaching it. */}
      <div className="absolute inset-0" onClick={close} aria-hidden="true" />

      <div
        role="dialog"
        aria-modal="true"
        aria-label="Compact turns"
        className="card relative z-10 my-auto w-full max-w-4xl overflow-hidden"
      >
        <div className="flex items-start gap-3 border-b border-line px-5 py-4">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent">
            <IconCompact className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold">
              Compact {entries.length} turn{entries.length === 1 ? '' : 's'}
            </h2>
            <p className="mt-0.5 text-xs text-ink-2">
              Fold a run of turns into one context block you can carry into a new session.
            </p>
          </div>
          <button
            type="button"
            onClick={close}
            aria-label="Close"
            className="rounded-lg border border-line p-2 text-ink-2 hover:bg-surface-2 hover:text-ink"
          >
            <IconClose className="h-4 w-4" />
          </button>
        </div>

        <div className="px-5 py-4">
          <div className="mb-2 flex items-center gap-2">
            <span className="eyebrow">Turns to compact</span>
            <span className="mono rounded border border-line bg-surface-2 px-1.5 py-0.5 text-[10px] text-ink-2">
              {entries.length}
            </span>
            {entries.length > 0 && (
              <button type="button" onClick={clear} className="ml-auto text-xs text-ink-2 hover:text-ink">
                Clear all
              </button>
            )}
          </div>

          <div className="rounded-xl border border-line">
            {entries.length > 0 && (
              <ul className="max-h-64 overflow-y-auto">
                {entries.map((entry, index) => (
                  <TrayRow key={entry.ref.id} entry={entry} index={index} onDropAt={move} />
                ))}
              </ul>
            )}

            <div
              onDragOver={(event) => {
                if (!event.dataTransfer.types.includes(DRAG_MIME)) return;
                event.preventDefault();
                setDropping(true);
              }}
              onDragLeave={() => setDropping(false)}
              onDrop={dropZone}
              className={`m-2 flex items-center justify-center gap-2 rounded-lg border-2 border-dashed py-4 text-xs transition-colors ${
                dropping ? 'border-accent bg-accent-soft text-accent' : 'border-line text-ink-3'
              }`}
            >
              <IconPlus className="h-3.5 w-3.5" />
              Drag turns from the list here, or drop them on the dock
            </div>
          </div>

          <p className="mono mt-2 text-[11px] text-ink-2">
            {totals.turns} turn{totals.turns === 1 ? '' : 's'} · {compactNum(totals.tokensIn)} tokens in
            {totals.unknownTokens > 0 && ` (${totals.unknownTokens} unreported)`} ·{' '}
            {totals.costUsd > 0 || totals.unpriced === 0
              ? `$${totals.costUsd.toFixed(2)} spent`
              : 'nothing priced'}
            {totals.unpriced > 0 && totals.costUsd > 0 && ` · ${totals.unpriced} not priced`}
          </p>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Select
              label="Compact with"
              value={choice}
              onChange={setChoice}
              title={chosenModel?.note ?? 'Which model writes the summary. The block itself is always assembled locally.'}
            >
              {/* Until the list arrives, the built-in Anthropic models are the
                  only ones that can be named without asking the machine. */}
              {providers === null ? (
                <option value={choice}>{choice.slice(choice.indexOf(':') + 1)}</option>
              ) : (
                providers.map((p) => (
                  <optgroup key={p.key} label={p.available ? p.label : `${p.label} — unavailable`}>
                    {p.models.map((m) => (
                      <option key={`${p.key}:${m.id}`} value={`${p.key}:${m.id}`} title={m.note}>
                        {m.label}
                      </option>
                    ))}
                    {p.models.length === 0 && (
                      <option value={`${p.key}:`} disabled>
                        {p.reason ?? 'none available'}
                      </option>
                    )}
                  </optgroup>
                ))
              )}
            </Select>

            <Select label="Length" value={length} onChange={(v) => setLength(v as CompactLength)}>
              {LENGTHS.map((l) => (
                <option key={l.key} value={l.key}>
                  {l.label}
                </option>
              ))}
            </Select>

            <button
              type="button"
              onClick={submit}
              disabled={working || enabled.length === 0 || parts.length === 0}
              className="ml-auto flex items-center gap-2 rounded-full bg-accent px-5 py-2.5 text-sm font-medium text-accent-ink transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <IconSparkle className="h-4 w-4" />
              {working ? 'Compacting…' : 'Compact turns'}
            </button>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line-soft pt-3">
            <span className="eyebrow">Include</span>
            {COMPACT_PARTS.map((part) => (
              <label key={part.key} title={part.hint} className="flex items-center gap-1.5 text-xs text-ink-2">
                <input
                  type="checkbox"
                  checked={parts.includes(part.key)}
                  onChange={() => togglePart(part.key)}
                  className="h-3.5 w-3.5 accent-[var(--accent)]"
                />
                {part.label}
              </label>
            ))}
            {parts.length === 0 && <span className="text-xs text-warn">Pick at least one.</span>}
          </div>

          {/*
            The one thing worth saying out loud before the button is pressed.
            Everything else in this dashboard is local by construction — the
            header pill says so — and summarising is the single step that can
            change that. Which way it goes depends entirely on this dropdown.
          */}
          {chosenProvider && (
            <p className={`mt-2 text-[11px] ${chosenProvider.local ? 'text-ink-3' : 'text-warn'}`}>
              {chosenProvider.local
                ? `Runs on this machine — the block stays local.${
                    chosenModel?.contextTokens
                      ? ` ${chosenModel.label} holds ${chosenModel.contextTokens.toLocaleString('en-US')} tokens; a block too big for it is refused rather than quietly cut.`
                      : ''
                  }`
                : 'Sends the selected prompts and responses to the Anthropic API, and bills this key for the call.'}
            </p>
          )}

          {error && (
            <p className="mt-3 flex items-start gap-2 rounded-lg border border-del/40 bg-del-bg px-3 py-2 text-xs text-del">
              <IconWarning className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {error}
            </p>
          )}
        </div>

        {result && <OutputPanel result={result} />}
      </div>
    </div>
  );
}

/**
 * Mounted once on the turn list. Owns the one piece of state the dock and the
 * panel share — whether a model is running — because the dock shows it as a
 * spinning ring while the panel is what started it.
 */
export function CompactPanel() {
  const { open } = useCompact();
  const [working, setWorking] = useState(false);
  return (
    <>
      <CompactDock working={working} />
      {open && <Modal working={working} setWorking={setWorking} />}
    </>
  );
}
