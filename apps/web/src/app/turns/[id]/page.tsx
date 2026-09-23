import Link from 'next/link';
import { notFound } from 'next/navigation';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Collapsible } from '@/components/Collapsible';
import { CommandTimeline } from '@/components/CommandTimeline';
import { CopyButton } from '@/components/CopyButton';
import { FileChangeList } from '@/components/DiffView';
import { PromptAttachments } from '@/components/PromptAttachments';
import { ProviderChip, StatusChip, TokenSourceChip } from '@/components/Chips';
import {
  IconAgent,
  IconArrowLeft,
  IconBranch,
  IconChip,
  IconClock,
  IconDownload,
  IconExternal,
  IconFile,
  IconFolder,
  IconLayers,
  IconPaperclip,
  IconSpend,
  IconTerminal,
} from '@/components/icons';
import { CostTip } from '@/components/CostTip';
import { ideContextPath, parsePrompt } from '@/lib/attachments';
import { costWorking, sumParts } from '@/lib/cost';
import { listHref, readFilters } from '@/lib/filters';
import { compactNum, cost, duration, num, shortId, tailPath, utcClock, utcLong } from '@/lib/format';
import {
  getCostInputs,
  getFileChanges,
  getPromptMedia,
  getSessionSummary,
  getToolCalls,
  getTurn,
  getTurnNeighbours,
  getTurnRank,
  countTurns,
  type FileChangeRow,
  type NeighbourTurn,
  type ToolCallRow,
} from '@/lib/queries';

export const dynamic = 'force-dynamic';

const CARD_HEAD = 'flex items-center gap-2 border-b border-line px-4 py-3';

function Card({
  children,
  className = '',
  id,
}: {
  children: React.ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <section id={id} className={`card ${className}`}>
      {children}
    </section>
  );
}

function RailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-line-soft py-2 last:border-0">
      <span className="text-xs text-ink-2">{label}</span>
      <span className="min-w-0 truncate text-right text-xs font-medium">{children}</span>
    </div>
  );
}

function Pill({ icon, children, title }: { icon: React.ReactNode; children: React.ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface-2 px-2.5 py-1 text-xs text-ink-2"
    >
      <span className="text-ink-3">{icon}</span>
      <span className="mono truncate text-ink">{children}</span>
    </span>
  );
}

/** The four things a turn's cost is actually made of, as one bar. */
function CostBar({
  parts,
}: {
  parts: { label: string; usd: number; color: string }[];
}) {
  const total = parts.reduce((s, p) => s + p.usd, 0);
  if (total <= 0) return null;
  return (
    <>
      <div className="mt-3 flex h-2 overflow-hidden rounded-full bg-line">
        {parts.map((p) => (
          <span
            key={p.label}
            title={`${p.label}: ${cost(String(p.usd))}`}
            style={{ width: `${(p.usd / total) * 100}%`, background: p.color }}
          />
        ))}
      </div>
      <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1">
        {parts.map((p) => (
          <span key={p.label} className="flex items-center gap-1.5 text-[11px] text-ink-2">
            <span className="h-2 w-2 rounded-full" style={{ background: p.color }} />
            {p.label}
            <span className="mono text-ink">{cost(String(p.usd))}</span>
          </span>
        ))}
      </div>
    </>
  );
}

function NeighbourCard({ turn, label, filters }: { turn: NeighbourTurn | null; label: string; filters: string }) {
  if (!turn) {
    return (
      <div className="card p-3 opacity-50">
        <div className="eyebrow">{label}</div>
        <div className="mt-1 text-xs text-ink-3">none in this session</div>
      </div>
    );
  }
  return (
    <Link href={filters ? `/turns/${turn.id}?${filters}` : `/turns/${turn.id}`} className="card p-3 transition-colors hover:bg-surface-2">
      <div className="eyebrow">{label}</div>
      <div className="mono mt-1 text-sm font-medium">turn #{turn.seq}</div>
      <div className="mono mt-0.5 text-[11px] text-ink-2">
        {cost(turn.cost_usd, turn.cost_source)} · {duration(turn.duration_ms)}
      </div>
    </Link>
  );
}

function FilePreview({ changes }: { changes: FileChangeRow[] }) {
  return (
    <ul className="space-y-1">
      {changes.slice(0, 5).map((fc) => (
        <li key={fc.id} className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-surface-2">
          <IconFile className="h-3.5 w-3.5 shrink-0 text-ink-3" />
          <span className="mono min-w-0 flex-1 truncate text-xs" title={fc.path}>
            {tailPath(fc.path)}
          </span>
          <span className="mono shrink-0 rounded border border-line px-1.5 py-0.5 text-[10px] text-ink-2">
            {fc.change_type}
          </span>
        </li>
      ))}
    </ul>
  );
}

function CommandPreview({ calls }: { calls: ToolCallRow[] }) {
  return (
    <ul className="space-y-1">
      {calls.slice(0, 5).map((c) => (
        <li key={c.id} className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-surface-2">
          <IconTerminal className="h-3.5 w-3.5 shrink-0 text-ink-3" />
          <span className="mono min-w-0 flex-1 truncate text-xs" title={c.command ?? c.tool_name}>
            {c.command ?? c.tool_name}
          </span>
          <span className="mono shrink-0 text-[10px] text-ink-3">{duration(c.duration_ms)}</span>
        </li>
      ))}
    </ul>
  );
}

export default async function TurnDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  if (!/^\d+$/.test(id)) notFound();

  const turn = await getTurn(id);
  if (!turn) notFound();

  const filters = readFilters(sp);
  const filterQs = new URLSearchParams(
    Object.entries(sp).flatMap(([k, v]) =>
      v && k !== 'page' ? [[k, Array.isArray(v) ? v[0]! : v] as [string, string]] : [],
    ),
  ).toString();

  const [calls, changes, costInputs, session, neighbours, rank, filterTotal, media] =
    await Promise.all([
      getToolCalls(id),
      getFileChanges(id),
      getCostInputs(id),
      getSessionSummary(turn.session_id),
      getTurnNeighbours(turn.session_id, turn.seq),
      getTurnRank(filters, turn),
      countTurns(filters),
      getPromptMedia(id),
    ]);

  // The editor-focus block is a prefix the user never typed; the heading is
  // what they did type. Nothing is hidden by splitting it off — the block's
  // file, line range and selected text all render as attachments beside the
  // prompt, and Copy still yields the raw text the model was given.
  const { body: asked, attachments } = parsePrompt(turn.prompt_text);
  const idePath = ideContextPath(attachments);
  const title =
    asked.split('\n').find((l) => l.trim() !== '')?.slice(0, 160) ??
    (idePath ? `IDE context · ${tailPath(idePath, 2)}` : '(no prompt text recorded)');
  const attachmentCount = attachments.length + media.length;
  const working = costWorking(costInputs);

  // Only a session with every turn priced can give an honest share; otherwise
  // the denominator is missing turns and every percentage from it is inflated.
  const sessionCost = session?.session_cost_usd === null ? null : Number(session?.session_cost_usd);
  const sessionFullyPriced = session !== null && Number(session.unpriced_turns) === 0;
  const share =
    turn.cost_usd !== null && sessionCost && sessionCost > 0 && sessionFullyPriced
      ? (Number(turn.cost_usd) / sessionCost) * 100
      : null;

  const outTokens = Number(turn.output_tokens ?? 0);
  const inTokens = Number(turn.total_input_tokens ?? 0);
  const ratio = outTokens > 0 && inTokens > 0 ? Math.round(inTokens / outTokens) : null;

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-2 text-xs">
        <Link href={listHref(filters, Number(sp.page) || undefined)} className="flex items-center gap-1.5 font-medium text-ink-2 hover:text-ink">
          <IconArrowLeft className="h-3.5 w-3.5" />
          All turns
        </Link>
        <span className="text-ink-3">/</span>
        <span className="mono text-ink-2" title={turn.external_session_id}>
          {shortId(turn.external_session_id)}
        </span>
        <span className="text-ink-3">/</span>
        <span className="mono text-ink">turn #{turn.seq}</span>

        {rank !== null && (
          <span className="mono ml-auto text-ink-3">
            {rank.toLocaleString('en-US')} of {filterTotal.toLocaleString('en-US')} in this filter
          </span>
        )}
      </div>

      <header className="card mb-5 p-5">
        <div className="flex flex-wrap items-center gap-3">
          <StatusChip status={turn.status} />
          <span className="mono text-xs text-ink-2">{utcLong(turn.started_at)}</span>
          {attachmentCount > 0 && (
            <a
              href="#prompt"
              title="Screenshots, editor context and files that were sent with this prompt."
              className="mono flex items-center gap-1 rounded border border-line bg-surface-2 px-1.5 py-0.5 text-[10px] text-ink-3 hover:text-ink"
            >
              <IconPaperclip className="h-3 w-3" />
              {attachmentCount} attached
            </a>
          )}

          <div className="ml-auto flex flex-wrap items-center gap-2">
            {turn.external_turn_id && <CopyButton value={turn.external_turn_id} label="Copy turn id" />}
            <Link
              href={`/?sessionId=${turn.session_id}`}
              className="flex items-center gap-1.5 rounded-lg border border-line bg-surface px-3 py-1.5 text-xs text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink"
            >
              <IconExternal className="h-3.5 w-3.5" />
              Open session
            </Link>
            <a
              href={`/turns/${turn.id}/export`}
              className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-accent-ink transition-opacity hover:opacity-90"
            >
              <IconDownload className="h-3.5 w-3.5" />
              Export JSON
            </a>
          </div>
        </div>

        <h1 className="mt-3 text-xl font-semibold tracking-tight">{title}</h1>

        <div className="mt-3 flex flex-wrap gap-2">
          <Pill icon={<IconFolder className="h-3.5 w-3.5" />} title={turn.project_path}>
            {turn.project_name}
          </Pill>
          <Pill icon={<IconAgent className="h-3.5 w-3.5" />} title={turn.agent_version ?? undefined}>
            {turn.agent_key}
          </Pill>
          <Pill icon={<IconBranch className="h-3.5 w-3.5" />} title={turn.git_head_sha ?? undefined}>
            {turn.git_branch ?? 'detached / none'}
          </Pill>
          <Pill icon={<IconChip className="h-3.5 w-3.5" />}>{turn.model_raw ?? '—'}</Pill>
          <Pill icon={<IconLayers className="h-3.5 w-3.5" />} title={turn.external_session_id}>
            {shortId(turn.external_session_id)} · turn #{turn.seq}
          </Pill>
        </div>
      </header>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-5">
          <Card className="scroll-mt-20" id="prompt">
            <div className={CARD_HEAD}>
              <h2 className="text-sm font-semibold">Prompt</h2>
              {turn.prompt_text && (
                <div className="ml-auto">
                  {/* The RAW text, editor block included — what the model was
                      given, not the reading view. */}
                  <CopyButton value={turn.prompt_text} label="Copy raw" />
                </div>
              )}
            </div>
            {/* Attachments sit beside the prompt on a wide screen and stack
                under it on a narrow one. */}
            <div
              className={`grid items-start gap-4 p-4 ${
                attachmentCount > 0 ? 'lg:grid-cols-[minmax(0,1fr)_280px]' : ''
              }`}
            >
              <pre className="mono overflow-x-auto rounded-lg border border-line bg-surface-2 p-3 text-[13px] leading-relaxed whitespace-pre-wrap">
                {turn.prompt_text === null
                  ? '(no prompt text recorded)'
                  : asked === ''
                    ? '(the editor context was the whole prompt — nothing was typed)'
                    : asked}
              </pre>
              <PromptAttachments turnId={turn.id} attachments={attachments} media={media} />
            </div>
          </Card>

          <Card>
            <div className={CARD_HEAD}>
              <h2 className="text-sm font-semibold">Response</h2>
              <span className="mono ml-auto flex items-center gap-2 text-xs text-ink-2">
                {compactNum(turn.output_tokens)} tokens
                <TokenSourceChip source={turn.token_source} />
              </span>
            </div>
            <div className="p-4">
              {turn.response_text ? (
                // Rendered as markdown, which is how the agent wrote it. React
                // escapes by default and no raw-HTML plugin is enabled, so
                // stored text cannot inject markup into this page.
                <Collapsible>
                  <div className="md text-[14px]">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{turn.response_text}</ReactMarkdown>
                  </div>
                </Collapsible>
              ) : (
                <p className="text-sm text-ink-2">(no response text recorded)</p>
              )}
            </div>
          </Card>

          <Card>
            <div className={CARD_HEAD}>
              <h2 className="text-sm font-semibold">Activity</h2>
              <span className="mono ml-auto text-xs text-ink-2">
                {calls.length} command{calls.length === 1 ? '' : 's'} · {changes.length} file
                {changes.length === 1 ? '' : 's'}
              </span>
            </div>
            <div className="grid grid-cols-1 gap-5 p-4 md:grid-cols-2">
              <div>
                <div className="eyebrow mb-2 flex items-center gap-1.5">
                  <IconFile className="h-3.5 w-3.5" /> Files touched
                  <span className="mono text-ink-3">{changes.length}</span>
                </div>
                {changes.length === 0 ? (
                  <p className="px-2 text-xs text-ink-3">No file changes recorded.</p>
                ) : (
                  <>
                    <FilePreview changes={changes} />
                    {changes.length > 5 && (
                      <a href="#file-changes" className="mt-2 inline-block px-2 text-xs text-accent hover:underline">
                        View all {changes.length} files →
                      </a>
                    )}
                  </>
                )}
              </div>

              <div>
                <div className="eyebrow mb-2 flex items-center gap-1.5">
                  <IconTerminal className="h-3.5 w-3.5" /> Commands run
                  <span className="mono text-ink-3">{calls.length}</span>
                </div>
                {calls.length === 0 ? (
                  <p className="px-2 text-xs text-ink-3">No tool calls recorded.</p>
                ) : (
                  <>
                    <CommandPreview calls={calls} />
                    {calls.length > 5 && (
                      <a href="#commands" className="mt-2 inline-block px-2 text-xs text-accent hover:underline">
                        View all {calls.length} commands →
                      </a>
                    )}
                  </>
                )}
              </div>
            </div>
          </Card>

          <section id="commands" className="scroll-mt-20">
            <h2 className="mb-2 text-sm font-semibold">
              Commands <span className="font-normal text-ink-2">({calls.length})</span>
            </h2>
            <CommandTimeline calls={calls} />
          </section>

          <section id="file-changes" className="mb-10 scroll-mt-20">
            <h2 className="mb-2 text-sm font-semibold">
              File changes <span className="font-normal text-ink-2">({changes.length})</span>
            </h2>
            <FileChangeList changes={changes} />
          </section>
        </div>

        <aside className="space-y-4 xl:sticky xl:top-20 xl:self-start">
          <Card className="p-4">
            <div className="eyebrow flex items-center gap-1.5">
              <IconSpend className="h-3.5 w-3.5" /> Estimated cost
              <span className="ml-auto">
                <CostTip
                  row={costInputs}
                  storedCostUsd={turn.cost_usd}
                  costSource={turn.cost_source}
                  width={330}
                />
              </span>
            </div>
            <div className="mt-2 flex flex-wrap items-baseline gap-2">
              <span className="mono text-3xl leading-none font-semibold tracking-tight">
                {cost(turn.cost_usd, turn.cost_source)}
              </span>
              {share !== null && (
                <span className="text-xs text-ink-2">{share.toFixed(0)}% of this session</span>
              )}
            </div>

            {working ? (
              // Both the bar and the info panel read from the same
              // `costWorking()` result, so the legend can never disagree with
              // the arithmetic behind the icon.
              <CostBar
                parts={[
                  { label: 'Input', usd: sumParts(working, ['input']), color: 'var(--accent)' },
                  { label: 'Cache read', usd: sumParts(working, ['cache_read']), color: 'color-mix(in oklab, var(--accent) 45%, var(--surface-3))' },
                  {
                    label: 'Cache write',
                    usd: sumParts(working, ['cache_write_5m', 'cache_write_1h', 'cache_write_unsplit']),
                    color: 'color-mix(in oklab, var(--out) 55%, var(--surface-3))',
                  },
                  { label: 'Output', usd: sumParts(working, ['output']), color: 'var(--out)' },
                ]}
              />
            ) : (
              <p className="mt-2 text-xs text-warn">
                No rate exists for this (provider, model), so this turn is unpriced — not free.
              </p>
            )}

            <p className="mt-3 border-t border-line-soft pt-3 text-[11px] leading-relaxed text-ink-2">
              List-price estimate, priced against the rate in force when the turn ran. Batch
              discounts and contract rates are not modelled, and this has never been checked
              against an invoice.
            </p>
          </Card>

          <Card className="p-4">
            <div className="eyebrow flex items-center gap-1.5">
              <IconLayers className="h-3.5 w-3.5" /> Tokens
            </div>
            <div className="mt-2 flex items-end gap-5">
              <div>
                <div className="mono text-2xl leading-none font-semibold">{compactNum(turn.total_input_tokens)}</div>
                <div className="mt-1 text-[11px] text-ink-2">in</div>
              </div>
              <div>
                <div className="mono text-2xl leading-none font-semibold text-out">{compactNum(turn.output_tokens)}</div>
                <div className="mt-1 text-[11px] text-ink-2">out</div>
              </div>
              {ratio !== null && (
                <span
                  className="mono mb-1 ml-auto rounded-md border border-line bg-surface-2 px-2 py-1 text-[11px] text-ink-2"
                  title="Output : input. Agent turns are read-heavy — almost all of the bill is context."
                >
                  1 : {ratio}
                </span>
              )}
            </div>
            <dl className="mt-3 border-t border-line-soft pt-2">
              <RailRow label="Input (uncached)">
                <span className="mono">{num(turn.input_tokens)}</span>
              </RailRow>
              <RailRow label="Cache read">
                <span className="mono">{num(turn.cache_read_tokens)}</span>
              </RailRow>
              <RailRow label="Cache write 5m">
                <span className="mono">{num(turn.cache_write_5m_tokens)}</span>
              </RailRow>
              <RailRow label="Cache write 1h">
                <span className="mono">{num(turn.cache_write_1h_tokens)}</span>
              </RailRow>
            </dl>
          </Card>

          <Card className="p-4">
            <div className="eyebrow flex items-center gap-1.5">
              <IconClock className="h-3.5 w-3.5" /> Duration
            </div>
            <div className="mono mt-2 text-2xl leading-none font-semibold">{duration(turn.duration_ms)}</div>
            <div className="mt-3 flex items-center gap-2">
              <span className="mono text-[11px] text-ink-2">{utcClock(turn.started_at)}</span>
              <span className="h-1 flex-1 rounded-full bg-accent/70" />
              <span className="mono text-[11px] text-ink-2">
                {turn.ended_at ? utcClock(turn.ended_at) : 'open'}
              </span>
            </div>
            {!turn.ended_at && (
              <p className="mt-2 text-[11px] text-warn">
                No terminal event was recorded, so this turn has no end time — the duration is
                unknown, not zero.
              </p>
            )}
          </Card>

          <Card className="p-4">
            <div className="eyebrow flex items-center gap-1.5">
              <IconLayers className="h-3.5 w-3.5" /> Session
            </div>
            <dl className="mt-2">
              <RailRow label="Session id">
                <span className="mono" title={turn.external_session_id}>{shortId(turn.external_session_id)}</span>
              </RailRow>
              <RailRow label="Turn">
                <span className="mono">{turn.seq} of {session?.max_seq ?? turn.seq}</span>
              </RailRow>
              <RailRow label="Project">{turn.project_name}</RailRow>
              <RailRow label="Agent">{turn.agent_key}</RailRow>
              <RailRow label="Branch">
                <span className="mono">{turn.git_branch ?? 'detached / none'}</span>
              </RailRow>
              <RailRow label="Model">
                <span className="mono">{turn.model_raw ?? '—'}</span>
              </RailRow>
              <RailRow label="Provider">
                <ProviderChip provider={turn.provider_key} source={turn.provider_source} />
              </RailRow>
              <RailRow label="Captured via">
                <span className="mono">{turn.source} · redaction v{turn.redaction_version}</span>
              </RailRow>
            </dl>
          </Card>

          <div className="grid grid-cols-2 gap-3">
            <NeighbourCard turn={neighbours.prev} label="Previous" filters={filterQs} />
            <NeighbourCard turn={neighbours.next} label="Next" filters={filterQs} />
          </div>
        </aside>
      </div>
    </>
  );
}
