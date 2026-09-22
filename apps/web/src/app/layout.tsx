import type { Metadata } from 'next';
import Link from 'next/link';
import { AppLogo } from '@/components/icons';
import { NavTabs } from '@/components/NavTabs';
import { ThemeToggle } from '@/components/ThemeToggle';
import './globals.css';

export const metadata: Metadata = {
  title: 'AI usage observability',
  description: 'Local-first record of every CLI coding agent interaction',
};

/*
 * Replays the saved theme onto <html> before the first paint. Without it the
 * page renders in the system theme and then snaps to the chosen one, which on
 * a dark-preferring machine is a full-screen white flash.
 */
const THEME_BOOT = `try{var t=localStorage.getItem('aiuo.theme');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch(e){}`;

/** Decorative only — the operator's own label, if they set one in .env. */
function Avatar() {
  const name = process.env.AIUO_OPERATOR?.trim();
  const initials = name
    ? name
        .split(/[\s._-]+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((part) => part[0]!.toUpperCase())
        .join('')
    : null;

  return (
    <span
      title={name ?? 'Local operator — set AIUO_OPERATOR in .env to label this'}
      className="mono flex h-8 w-8 items-center justify-center rounded-full border border-line bg-surface-2 text-[11px] font-medium text-ink-2"
    >
      {initials ?? (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true" className="h-4 w-4">
          <circle cx="12" cy="8.5" r="3.5" />
          <path d="M4.5 20a7.5 7.5 0 0 1 15 0" strokeLinecap="round" />
        </svg>
      )}
    </span>
  );
}

function StatusPill({ children, title }: { children: React.ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className="mono hidden rounded-full border border-line bg-surface-2 px-2.5 py-1 text-[10px] text-ink-2 md:inline-block"
    >
      {children}
    </span>
  );
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
      </head>
      <body className="min-h-screen bg-canvas antialiased">
        <header className="sticky top-0 z-30 border-b border-line bg-surface/90 backdrop-blur">
          <div className="mx-auto flex max-w-[1400px] items-center gap-6 px-5">
            <Link href="/" className="flex items-center gap-2.5 py-3">
              <AppLogo />
              <span className="text-sm font-semibold tracking-tight">AI usage observability</span>
            </Link>

            <NavTabs />

            <div className="ml-auto flex items-center gap-2">
              <StatusPill title="The dashboard connects with default_transaction_read_only — it cannot write to the record it displays.">
                read-only
              </StatusPill>
              <StatusPill title="Nothing here leaves this machine.">localhost</StatusPill>
              <StatusPill title="Every timestamp in the schema is UTC and is rendered as UTC, never converted.">
                all times UTC
              </StatusPill>
              <ThemeToggle />
              <Avatar />
            </div>
          </div>
        </header>

        <main className="mx-auto max-w-[1400px] px-5 py-6">{children}</main>
      </body>
    </html>
  );
}
