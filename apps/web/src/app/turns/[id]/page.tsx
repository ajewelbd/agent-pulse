import Link from 'next/link';
import { notFound } from 'next/navigation';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CommandTimeline } from '@/components/CommandTimeline';
import { FileChangeList } from '@/components/DiffView';
import { CostChip, ProviderChip, StatusChip, TokenSourceChip } from '@/components/Chips';
import { cost, duration, num, utc } from '@/lib/format';
import { getFileChanges, getToolCalls, getTurn } from '@/lib/queries';

export const dynamic = 'force-dynamic';

function Field({ label, children, title }: { label: string; children: React.ReactNode; title?: string }) {
  return (
    <div title={title}>
      <dt className="text-[11px] uppercase tracking-wide text-[--color-ink-2]">{label}</dt>
      <dd className="mt-0.5 text-sm">{children}</dd>
    </div>
  );
}

export default async function TurnDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^\d+$/.test(id)) notFound();

  const turn = await getTurn(id);
  if (!turn) notFound();

  const [calls, changes] = await Promise.all([getToolCalls(id), getFileChanges(id)]);

  return (
    <>
      <Link href="/" className="text-sm text-[--color-ink-2] hover:text-[--color-accent]">
        ← All turns
      </Link>

      <header className="mt-3 rounded-lg border border-[--color-line] bg-[--color-surface-2] p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-base font-semibold">
            {turn.project_name} <span className="text-[--color-ink-2]">· turn {turn.seq}</span>
          </h1>
          <StatusChip status={turn.status} />
          <ProviderChip provider={turn.provider_key} source={turn.provider_source} />
          <TokenSourceChip source={turn.token_source} />
          <CostChip source={turn.cost_source} />
        </div>
        <p className="mono mt-1 text-xs text-[--color-ink-2]">{turn.project_path}</p>

        <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-6">
          <Field label="Agent">
            {turn.agent_key}
            {turn.agent_version && <span className="text-[--color-ink-2]"> {turn.agent_version}</span>}
          </Field>
          <Field label="Model (raw)" title="Stored verbatim as the provider reported it">
            <span className="mono text-xs">{turn.model_raw ?? '—'}</span>
            {turn.model_normalized && turn.model_normalized !== turn.model_raw && (
              <span className="mono block text-[11px] text-[--color-ink-2]">→ {turn.model_normalized}</span>
            )}
          </Field>
          <Field label="Branch">
            <span className="mono text-xs">{turn.git_branch ?? <span className="text-[--color-ink-2]">detached / none</span>}</span>
            {turn.git_head_sha && (
              <span className="mono block text-[11px] text-[--color-ink-2]">{turn.git_head_sha.slice(0, 12)}</span>
            )}
            {turn.git_dirty !== null && (
              <span className="block text-[11px] text-[--color-ink-2]">{turn.git_dirty ? 'dirty tree' : 'clean tree'}</span>
            )}
          </Field>
          <Field label="Started (UTC)"><span className="mono text-xs">{utc(turn.started_at)}</span></Field>
          <Field label="Ended (UTC)"><span className="mono text-xs">{utc(turn.ended_at)}</span></Field>
          <Field label="Duration"><span className="mono text-xs">{duration(turn.duration_ms)}</span></Field>
        </dl>

        <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 border-t border-[--color-line] pt-4 sm:grid-cols-4 lg:grid-cols-7">
          <Field label="Input" title="Uncached input tokens only — see Total input for the billable figure">
            <span className="mono text-xs">{num(turn.input_tokens)}</span>
          </Field>
          <Field label="Cache read"><span className="mono text-xs">{num(turn.cache_read_tokens)}</span></Field>
          <Field label="Cache write 5m" title="Billed at 1.25x input"><span className="mono text-xs">{num(turn.cache_write_5m_tokens)}</span></Field>
          <Field label="Cache write 1h" title="Billed at 2x input"><span className="mono text-xs">{num(turn.cache_write_1h_tokens)}</span></Field>
          <Field
            label="Total input"
            title="input + cache read + cache write. This is the billable figure — input alone is near-zero on a cached turn."
          >
            <span className="mono text-xs font-semibold">{num(turn.total_input_tokens)}</span>
          </Field>
          <Field label="Output"><span className="mono text-xs">{num(turn.output_tokens)}</span></Field>
          <Field label="Cost"><span className="mono text-xs">{cost(turn.cost_usd, turn.cost_source)}</span></Field>
        </dl>

        <p className="mt-3 border-t border-[--color-line] pt-2 text-[11px] text-[--color-ink-2]">
          session <span className="mono">{turn.external_session_id}</span> · captured via {turn.source} ·
          redaction v{turn.redaction_version}
        </p>
      </header>

      <section className="mt-6">
        <h2 className="mb-2 text-sm font-semibold">Prompt</h2>
        <pre className="mono overflow-x-auto whitespace-pre-wrap rounded-lg border border-[--color-line] bg-[--color-surface-2] p-3 text-[13px] leading-relaxed">
          {turn.prompt_text ?? '(no prompt text recorded)'}
        </pre>
      </section>

      <section className="mt-6">
        <h2 className="mb-2 text-sm font-semibold">Response</h2>
        <div className="md rounded-lg border border-[--color-line] p-4 text-[14px]">
          {turn.response_text ? (
            // Rendered as markdown, which is how the agent wrote it. React
            // escapes by default and no raw-HTML plugin is enabled, so stored
            // text cannot inject markup into this page.
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{turn.response_text}</ReactMarkdown>
          ) : (
            <p className="text-sm text-[--color-ink-2]">(no response text recorded)</p>
          )}
        </div>
      </section>

      <section className="mt-6">
        <h2 className="mb-2 text-sm font-semibold">
          Commands <span className="font-normal text-[--color-ink-2]">({calls.length})</span>
        </h2>
        <CommandTimeline calls={calls} />
      </section>

      <section className="mt-6 mb-10">
        <h2 className="mb-2 text-sm font-semibold">
          File changes <span className="font-normal text-[--color-ink-2]">({changes.length})</span>
        </h2>
        <FileChangeList changes={changes} />
      </section>
    </>
  );
}
