'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
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
import { compactNum, utcLong } from '@/lib/format';
import { IconChevronDown, IconClock, IconCompact, IconDownload, IconSparkle, IconWarning } from './icons';

/**
 * Compacting one turn, from its own detail page.
 *
 * Same two stages as the list page's panel — assemble locally, optionally hand
 * the block to a model — with one addition: the result is filed into this
 * turn's history, settings included.
 *
 * Storing the settings is the point of storing anything. The same turn at
 * length 'brief' with prompts only, and at 'detailed' with diffs, produce two
 * documents that look equally authoritative and say very different amounts.
 * A history row without its parameters would be a paragraph with no way to
 * know what it left out.
 *
 * The write does not happen here or anywhere in the dashboard. This POSTs to
 * /api/compact, which hands the finished record to the collector — the
 * dashboard's own pool is read-only and stays that way.
 */

export interface StoredCompaction {
  id: string;
  created_at: string;
  provider: string;
  model: string;
  length: string;
  parts: string[];
  summarized: boolean;
  reason: string | null;
  output: string;
  input_tokens: string | null;
  output_tokens: string | null;
  estimated_input_tokens: string;
}

interface Result {
  output: string;
  summarized: boolean;
  reason?: string;
  provider: CompactProviderKey;
  model: string;
  outputTruncated?: boolean;
  estimatedInputTokens: number;
  usage?: { inputTokens: number | null; outputTokens: number | null; cacheReadTokens: number | null };
  saved?: boolean;
  saveError?: string;
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

function download(text: string, name: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

/** A stored count, rendered as "—" when the provider reported none. */
function count(value: string | number | null | undefined): string {
  return value === null || value === undefined ? '—' : compactNum(value);
}

function Settings({ parts, length, model, provider }: { parts: string[]; length: string; model: string; provider: string }) {
  return (
    <span className="mono flex flex-wrap items-center gap-1.5 text-[10px] text-ink-3">
      <span className="rounded border border-line bg-surface-2 px-1.5 py-0.5">{length}</span>
      <span className="rounded border border-line bg-surface-2 px-1.5 py-0.5" title={`provider: ${provider}`}>
        {model}
      </span>
      {parts.map((p) => (
        <span key={p} className="rounded border border-line bg-surface-2 px-1.5 py-0.5">
          {p}
        </span>
      ))}
    </span>
  );
}

function HistoryRow({ row }: { row: StoredCompaction }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="border-b border-line-soft last:border-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-1.5 text-left text-xs font-medium hover:text-accent"
        >
          <IconChevronDown className={`h-3.5 w-3.5 text-ink-3 ${open ? '' : '-rotate-90'}`} />
          {/* The distinction the whole feature rests on, stated on every row. */}
          {row.summarized ? 'Summary' : 'Assembled record'}
        </button>
        <span className="mono text-[11px] text-ink-3">{utcLong(row.created_at)}</span>
        <span className="mono text-[11px] text-ink-2">
          {count(row.input_tokens)} in / {count(row.output_tokens)} out
        </span>
        <div className="ml-auto flex items-center gap-2">
          <CopyButton
            value={row.output}
            label="Copy"
            title="Copy this compaction"
            className="rounded-lg border border-line px-2 py-1 text-[11px] text-ink-2 hover:bg-surface-2 hover:text-ink"
          />
          <button
            type="button"
            onClick={() => download(row.output, `compaction-${row.id}.md`)}
            className="rounded-lg border border-line px-2 py-1 text-[11px] text-ink-2 hover:bg-surface-2 hover:text-ink"
          >
            .md
          </button>
        </div>
        <div className="w-full">
          <Settings parts={row.parts} length={row.length} model={row.model} provider={row.provider} />
        </div>
      </div>
      {open && (
        <div className="px-4 pb-4">
          {row.reason && (
            <p className="mb-2 rounded-lg border border-warn-line bg-warn-bg px-3 py-2 text-[11px] text-warn">
              {row.reason}
            </p>
          )}
          <pre className="mono max-h-72 overflow-auto rounded-lg border border-line bg-surface-2 p-3 text-[12px] leading-relaxed whitespace-pre-wrap">
            {row.output}
          </pre>
        </div>
      )}
    </li>
  );
}

export function TurnCompact({ turnId, history }: { turnId: string; history: StoredCompaction[] }) {
  const [choice, setChoice] = useState(`${DEFAULT_COMPACT_PROVIDER}:${DEFAULT_COMPACT_MODEL}`);
  const [providers, setProviders] = useState<ProviderStatus[] | null>(null);
  const [length, setLength] = useState<CompactLength>('brief');
  const [parts, setParts] = useState<CompactPart[]>(DEFAULT_PARTS);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  // Rows saved during this visit, newest first. The server-rendered history is
  // a snapshot from page load, so a fresh compaction is shown from here rather
  // than by silently reloading the page under the user.
  const [added, setAdded] = useState<StoredCompaction[]>([]);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => () => abort.current?.abort(), []);

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/compact/models', { signal: controller.signal })
      .then((r) => r.json())
      .then((data: { providers?: ProviderStatus[] }) => {
        const list = data.providers ?? [];
        setProviders(list);
        const usable = list.filter((p) => p.available && p.models.length > 0);
        const current = list.find((p) => p.key === choice.slice(0, choice.indexOf(':')));
        const stillThere =
          current?.available && current.models.some((m) => m.id === choice.slice(choice.indexOf(':') + 1));
        if (!stillThere && usable[0]?.models[0]) setChoice(`${usable[0].key}:${usable[0].models[0].id}`);
      })
      .catch(() => {
        // Assembly does not depend on this; the dropdown keeps its default.
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const chosenProvider = providers?.find((p) => p.key === choice.slice(0, choice.indexOf(':')));
  const chosenModel = chosenProvider?.models.find((m) => m.id === choice.slice(choice.indexOf(':') + 1));

  const submit = useCallback(async () => {
    if (parts.length === 0) return;
    const controller = new AbortController();
    abort.current = controller;
    setWorking(true);
    setError(null);
    try {
      const response = await fetch('/api/compact', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          turnIds: [turnId],
          parts,
          length,
          provider: choice.slice(0, choice.indexOf(':')),
          model: choice.slice(choice.indexOf(':') + 1),
          saveToTurnId: turnId,
        }),
      });
      const data: unknown = await response.json();
      if (!response.ok) {
        setError(
          data && typeof data === 'object' && 'error' in data
            ? String((data as { error: unknown }).error)
            : 'request failed',
        );
        return;
      }
      const r = data as Result;
      setResult(r);
      // Only shown as history once the collector confirmed it. An unsaved
      // result is still on screen above, labelled as unsaved — it must not
      // appear in a list of what was stored.
      if (r.saved) {
        setAdded((prev) => [
          {
            id: `new-${prev.length}`,
            created_at: new Date().toISOString(),
            provider: r.provider,
            model: r.model,
            length,
            parts,
            summarized: r.summarized,
            reason: r.reason ?? null,
            output: r.output,
            input_tokens: r.usage?.inputTokens != null ? String(r.usage.inputTokens) : null,
            output_tokens: r.usage?.outputTokens != null ? String(r.usage.outputTokens) : null,
            estimated_input_tokens: String(r.estimatedInputTokens),
          },
          ...prev,
        ]);
      }
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === 'AbortError') return;
      setError(caught instanceof Error ? caught.message : 'request failed');
    } finally {
      abort.current = null;
      setWorking(false);
    }
  }, [choice, length, parts, turnId]);

  const rows = [...added, ...history];

  return (
    <section id="compact" className="card mb-10 scroll-mt-20">
      <div className="flex items-start gap-3 border-b border-line px-4 py-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent">
          <IconCompact className="h-4.5 w-4.5" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold">Compact this turn</h2>
          <p className="mt-0.5 text-xs text-ink-2">
            Fold it into one context block. Each run is kept below with the settings that made it.
          </p>
        </div>
      </div>

      <div className="px-4 py-4">
        <div className="flex flex-wrap items-center gap-2">
          <label className="relative inline-flex items-center gap-2 rounded-lg border border-line bg-surface py-2 pr-7 pl-3 text-xs">
            <span className="shrink-0 text-ink-3">Compact with</span>
            <select
              value={choice}
              onChange={(e) => setChoice(e.target.value)}
              className="pill-select cursor-pointer truncate bg-transparent font-medium text-ink outline-none"
            >
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
            </select>
            <IconChevronDown className="pointer-events-none absolute right-2 h-3.5 w-3.5 text-ink-3" />
          </label>

          <label className="relative inline-flex items-center gap-2 rounded-lg border border-line bg-surface py-2 pr-7 pl-3 text-xs">
            <span className="shrink-0 text-ink-3">Length</span>
            <select
              value={length}
              onChange={(e) => setLength(e.target.value as CompactLength)}
              className="pill-select cursor-pointer bg-transparent font-medium text-ink outline-none"
            >
              {LENGTHS.map((l) => (
                <option key={l.key} value={l.key}>
                  {l.label}
                </option>
              ))}
            </select>
            <IconChevronDown className="pointer-events-none absolute right-2 h-3.5 w-3.5 text-ink-3" />
          </label>

          <button
            type="button"
            onClick={submit}
            disabled={working || parts.length === 0}
            className="ml-auto flex items-center gap-2 rounded-full bg-accent px-5 py-2.5 text-sm font-medium text-accent-ink transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <IconSparkle className="h-4 w-4" />
            {working ? 'Compacting…' : 'Compact turn'}
          </button>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line-soft pt-3">
          <span className="eyebrow">Include</span>
          {COMPACT_PARTS.map((part) => (
            <label key={part.key} title={part.hint} className="flex items-center gap-1.5 text-xs text-ink-2">
              <input
                type="checkbox"
                checked={parts.includes(part.key)}
                onChange={() =>
                  setParts((prev) =>
                    prev.includes(part.key) ? prev.filter((p) => p !== part.key) : [...prev, part.key],
                  )
                }
                className="h-3.5 w-3.5 accent-[var(--accent)]"
              />
              {part.label}
            </label>
          ))}
          {parts.length === 0 && <span className="text-xs text-warn">Pick at least one.</span>}
        </div>

        {chosenProvider && (
          <p className={`mt-2 text-[11px] ${chosenProvider.local ? 'text-ink-3' : 'text-warn'}`}>
            {chosenProvider.local
              ? `Runs on this machine — the block stays local.${
                  chosenModel?.contextTokens
                    ? ` ${chosenModel.label} holds ${chosenModel.contextTokens.toLocaleString('en-US')} tokens.`
                    : ''
                }`
              : 'Sends this turn’s prompt and response to the Anthropic API, and bills this key for the call.'}
          </p>
        )}

        {error && (
          <p className="mt-3 flex items-start gap-2 rounded-lg border border-del/40 bg-del-bg px-3 py-2 text-xs text-del">
            <IconWarning className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {error}
          </p>
        )}

        {result && (
          <div className="mt-4 border-t border-line pt-4">
            <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-2">
              <span className="eyebrow">Result</span>
              <span className="mono text-[11px] text-ink-2">
                {result.summarized ? `${result.model} · ${result.provider}` : 'assembled record — no model'}
                {' · '}
                {result.usage?.outputTokens != null
                  ? `${compactNum(result.usage.outputTokens)} tokens out`
                  : `~${compactNum(result.estimatedInputTokens)} tokens (est.)`}
              </span>
              <div className="ml-auto flex items-center gap-2">
                <CopyButton value={result.output} title="Copy this compaction" />
                <button
                  type="button"
                  onClick={() => download(result.output, `turn-${turnId}-compaction.md`)}
                  className="flex items-center gap-1.5 rounded-lg border border-line bg-surface px-3 py-1.5 text-xs text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink"
                >
                  <IconDownload className="h-3.5 w-3.5" />
                  Download .md
                </button>
              </div>
            </div>

            {result.reason && (
              <p className="mb-2 flex items-start gap-2 rounded-lg border border-warn-line bg-warn-bg px-3 py-2 text-xs text-warn">
                <IconWarning className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                {result.reason}
              </p>
            )}
            {result.outputTruncated && (
              <p className="mb-2 text-xs text-warn">The model hit its output limit — this block is cut off at the end.</p>
            )}
            {/* Saving is best effort and never hides the result, so when it
                fails the result stays on screen and says it was not kept. */}
            {result.saved === false && (
              <p className="mb-2 flex items-start gap-2 rounded-lg border border-warn-line bg-warn-bg px-3 py-2 text-xs text-warn">
                <IconWarning className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                Not saved to history — {result.saveError ?? 'the collector did not accept it'}. Copy it now if you want to keep it.
              </p>
            )}

            <pre className="mono max-h-80 overflow-auto rounded-lg border border-line bg-surface-2 p-4 text-[12px] leading-relaxed whitespace-pre-wrap">
              {result.output}
            </pre>
          </div>
        )}
      </div>

      <div className="border-t border-line">
        <div className="flex items-center gap-2 px-4 py-3">
          <IconClock className="h-3.5 w-3.5 text-ink-3" />
          <h3 className="text-xs font-semibold">Compact history</h3>
          <span className="mono rounded border border-line bg-surface-2 px-1.5 py-0.5 text-[10px] text-ink-2">
            {rows.length}
          </span>
        </div>
        {rows.length === 0 ? (
          <p className="px-4 pb-4 text-xs text-ink-3">
            Nothing compacted from this turn yet. Each run is kept here with its model, length and included parts.
          </p>
        ) : (
          <ul>
            {rows.map((row) => (
              <HistoryRow key={row.id} row={row} />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
