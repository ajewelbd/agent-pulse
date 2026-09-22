import Link from 'next/link';
import { IconChevronLeft, IconChevronRight } from './icons';
import { listHref } from '@/lib/filters';
import type { TurnFilters } from '@/lib/queries';

/**
 * Page numbers, windowed.
 *
 * Always shows the first and last page plus a window around the current one,
 * so the control stays one line whether there are 3 pages or 300. Gaps are
 * rendered as an inert ellipsis rather than a link to a guessed page.
 */
function pageWindow(current: number, count: number): (number | 'gap')[] {
  if (count <= 7) return Array.from({ length: count }, (_, i) => i + 1);

  const pages = new Set([1, count, current, current - 1, current + 1]);
  if (current <= 3) [2, 3, 4].forEach((p) => pages.add(p));
  if (current >= count - 2) [count - 3, count - 2, count - 1].forEach((p) => pages.add(p));

  const sorted = [...pages].filter((p) => p >= 1 && p <= count).sort((a, b) => a - b);
  const out: (number | 'gap')[] = [];
  let prev = 0;
  for (const p of sorted) {
    if (prev && p - prev > 1) out.push('gap');
    out.push(p);
    prev = p;
  }
  return out;
}

const cell =
  'mono flex h-8 min-w-8 items-center justify-center rounded-lg px-2 text-xs transition-colors';

export function Pagination({
  filters,
  page,
  pageCount,
}: {
  filters: TurnFilters;
  page: number;
  pageCount: number;
}) {
  if (pageCount <= 1) return null;

  const Step = ({ to, label, children }: { to: number; label: string; children: React.ReactNode }) =>
    to >= 1 && to <= pageCount ? (
      <Link href={listHref(filters, to)} aria-label={label} className={`${cell} border border-line text-ink-2 hover:bg-surface-2 hover:text-ink`}>
        {children}
      </Link>
    ) : (
      <span aria-hidden="true" className={`${cell} border border-line-soft text-ink-3 opacity-40`}>
        {children}
      </span>
    );

  return (
    <nav aria-label="Pagination" className="flex items-center gap-1">
      <Step to={page - 1} label="Previous page"><IconChevronLeft className="h-3.5 w-3.5" /></Step>

      {pageWindow(page, pageCount).map((entry, i) =>
        entry === 'gap' ? (
          <span key={`gap-${i}`} className={`${cell} text-ink-3`}>…</span>
        ) : entry === page ? (
          <span key={entry} aria-current="page" className={`${cell} border border-accent/50 bg-accent/10 font-medium text-accent`}>
            {entry}
          </span>
        ) : (
          <Link key={entry} href={listHref(filters, entry)} className={`${cell} text-ink-2 hover:bg-surface-2 hover:text-ink`}>
            {entry}
          </Link>
        ),
      )}

      <Step to={page + 1} label="Next page"><IconChevronRight className="h-3.5 w-3.5" /></Step>
    </nav>
  );
}
