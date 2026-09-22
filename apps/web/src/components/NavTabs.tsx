'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * Top-level tabs.
 *
 * A client component only because the active tab depends on the path, and the
 * layout that renders it is shared by every route.
 */
const TABS = [
  { href: '/', label: 'Turns', match: (p: string) => p === '/' || p.startsWith('/turns') },
  { href: '/aggregates', label: 'Aggregates', match: (p: string) => p.startsWith('/aggregates') },
];

export function NavTabs() {
  const pathname = usePathname();

  return (
    <nav className="flex items-center gap-1 text-sm">
      {TABS.map((tab) => {
        const active = tab.match(pathname);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? 'page' : undefined}
            className={`relative px-3 py-3 transition-colors ${
              active ? 'font-medium text-ink' : 'text-ink-2 hover:text-ink'
            }`}
          >
            {tab.label}
            {active && (
              <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-accent" />
            )}
          </Link>
        );
      })}
    </nav>
  );
}
