import Link from 'next/link';
import { SearchHotkey } from './SearchHotkey';
import { IconCalendar, IconChevronDown, IconFilter, IconSearch } from './icons';
import { hasActiveFilters } from '@/lib/filters';
import { shortId, utcClock, utcDay } from '@/lib/format';
import { SESSION_OPTION_LIMIT, type FilterOptions, type SessionOption, type TurnFilters } from '@/lib/queries';

/**
 * Filter bar.
 *
 * A plain GET form: filter state lives in the URL, so every view is linkable,
 * bookmarkable and reproducible — which matters for a tool whose whole purpose
 * is going back and finding what happened. The only client JavaScript is the
 * `/` focus shortcut, which the hint next to the box promises.
 *
 * No hidden `page` field: changing a filter changes which rows exist, so
 * staying on page 7 of the previous result set would be meaningless.
 */
function PillSelect({
  label,
  name,
  value,
  children,
  /** Caps the closed pill's width. The open dropdown is unaffected. */
  maxWidth,
}: {
  label: string;
  name: string;
  value: string;
  children: React.ReactNode;
  maxWidth?: string;
}) {
  const active = value !== '';
  return (
    <label
      className={`relative inline-flex items-center gap-2 rounded-lg border py-1.5 pr-7 pl-3 text-xs transition-colors ${
        active ? 'border-line bg-surface-2' : 'border-line bg-surface hover:bg-surface-2'
      }`}
    >
      <span className="shrink-0 text-ink-3">{label}</span>
      <select
        name={name}
        defaultValue={value}
        style={maxWidth ? { maxWidth } : undefined}
        className={`pill-select cursor-pointer truncate bg-transparent outline-none ${
          active ? 'font-medium text-ink' : 'text-ink-2'
        }`}
      >
        {children}
      </select>
      <IconChevronDown className="pointer-events-none absolute right-2 h-3.5 w-3.5 text-ink-3" />
    </label>
  );
}

/**
 * How a session is named in the dropdown.
 *
 * A session id is a UUID: it identifies the transcript file on disk, and
 * nothing to a person. What someone actually remembers is when it was and what
 * they asked first, so that leads, with the turn count for size and the short
 * id last as the handle back to the file.
 */
function sessionLabel(s: SessionOption): string {
  const opening = s.first_prompt?.replace(/\s+/g, ' ').trim();
  const parts = [
    `${utcDay(s.started_at)} ${utcClock(s.started_at)}`,
    `${s.turns} turn${s.turns === '1' ? '' : 's'}`,
    opening ? `“${opening}”` : `(no prompt text) ${shortId(s.external_session_id)}`,
  ];
  return parts.join(' · ');
}

export function TurnFiltersBar({
  options,
  filters,
  total,
}: {
  options: FilterOptions;
  filters: TurnFilters;
  total: number;
}) {
  const active = hasActiveFilters(filters);

  // The option list narrows by project, so a session filter carried over from
  // another project would vanish from it — and a `defaultValue` matching no
  // option silently reverts to "All" on the next submit, clearing a filter the
  // user never touched. Pinning the active one in keeps it selectable.
  const listed = options.sessions;
  const activeMissing =
    options.activeSession && !listed.some((s) => s.id === options.activeSession!.id);
  const sessions = activeMissing ? [options.activeSession!, ...listed] : listed;

  const sessionsByProject = sessions.reduce<Record<string, SessionOption[]>>((acc, s) => {
    (acc[s.project_name] ??= []).push(s);
    return acc;
  }, {});

  return (
    <form method="GET" className="card mb-5 p-4">
      <SearchHotkey />

      <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
        <div className="relative flex-1">
          <IconSearch className="pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-ink-3" />
          <input
            id="turn-search"
            type="search"
            name="q"
            defaultValue={filters.q ?? ''}
            placeholder="Search prompt and response…"
            aria-label="Search prompt and response"
            className="h-11 w-full rounded-xl border border-line bg-surface-2 pr-12 pl-10 text-sm outline-none placeholder:text-ink-3 focus:border-accent"
          />
          <kbd className="mono absolute top-1/2 right-3 -translate-y-1/2 rounded border border-line bg-surface px-1.5 py-0.5 text-[10px] text-ink-3">
            /
          </kbd>
        </div>

        <div className="flex h-11 items-center gap-2 rounded-xl border border-line bg-surface-2 px-3">
          <IconCalendar className="h-4 w-4 shrink-0 text-ink-3" />
          <input
            type="date"
            name="from"
            defaultValue={filters.from ?? ''}
            aria-label="From date (UTC)"
            className="mono w-[8.5rem] bg-transparent text-xs text-ink outline-none"
          />
          <span className="text-ink-3">–</span>
          <input
            type="date"
            name="to"
            defaultValue={filters.to ?? ''}
            aria-label="To date (UTC)"
            className="mono w-[8.5rem] bg-transparent text-xs text-ink outline-none"
          />
        </div>

        <button
          type="submit"
          className="h-11 rounded-xl bg-accent px-6 text-sm font-medium text-accent-ink transition-opacity hover:opacity-90"
        >
          Apply filters
        </button>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line-soft pt-3">
        <span className="eyebrow mr-1 flex items-center gap-1.5">
          <IconFilter className="h-3.5 w-3.5" />
          Filters
        </span>

        <PillSelect label="Project" name="projectId" value={filters.projectId ?? ''}>
          <option value="">All</option>
          {options.projects.map((p) => (
            <option key={p.id} value={p.id} title={p.path}>{p.name}</option>
          ))}
        </PillSelect>

        {/* Sessions sit next to Project because a session belongs to exactly
            one, and the list narrows with it. Grouped by project so an
            unnarrowed list is still readable. */}
        <PillSelect label="Session" name="sessionId" value={filters.sessionId ?? ''} maxWidth="19rem">
          <option value="">All</option>
          {Object.entries(sessionsByProject).map(([project, group]) => (
            <optgroup key={project} label={project}>
              {group.map((s) => (
                <option key={s.id} value={s.id} title={s.external_session_id}>
                  {sessionLabel(s)}
                </option>
              ))}
            </optgroup>
          ))}
          {/* Say the list is a prefix rather than letting it look complete.
              Narrowing by project is the way to reach what is not here. */}
          {options.sessionsTruncated && (
            <option value="" disabled>
              — newest {SESSION_OPTION_LIMIT} only; narrow by project to see more —
            </option>
          )}
        </PillSelect>

        <PillSelect label="Agent" name="agentId" value={filters.agentId ?? ''}>
          <option value="">All</option>
          {options.agents.map((a) => (
            <option key={a.id} value={a.id}>{a.key}</option>
          ))}
        </PillSelect>

        <PillSelect label="Provider" name="providerId" value={filters.providerId ?? ''}>
          <option value="">All</option>
          {options.providers.map((p) => (
            <option key={p.id} value={p.id}>{p.key}</option>
          ))}
        </PillSelect>

        <PillSelect label="Model" name="model" value={filters.model ?? ''}>
          <option value="">All</option>
          {options.models.map((m) => (
            <option key={m.model_normalized} value={m.model_normalized}>{m.model_normalized}</option>
          ))}
        </PillSelect>

        {/* Branch names only mean something inside one project ("main" spans
            repos), so the option list narrows once a project is chosen. */}
        <PillSelect label="Branch" name="branch" value={filters.branch ?? ''}>
          <option value="">All</option>
          {options.branches.map((b) => (
            <option key={b.git_branch} value={b.git_branch}>{b.git_branch}</option>
          ))}
        </PillSelect>

        <PillSelect label="Status" name="status" value={filters.status ?? ''}>
          <option value="">All</option>
          <option value="complete">complete</option>
          <option value="partial">partial</option>
          <option value="error">error</option>
          <option value="aborted">aborted</option>
        </PillSelect>

        {active && (
          <Link href="/" className="flex items-center gap-1.5 px-2 text-xs text-ink-2 hover:text-ink">
            <span aria-hidden="true">✕</span> Clear all
          </Link>
        )}

        <span className="mono ml-auto text-xs text-ink-2">
          <span className="font-medium text-ink">{total.toLocaleString('en-US')}</span> turn
          {total === 1 ? '' : 's'} match
        </span>
      </div>
    </form>
  );
}
