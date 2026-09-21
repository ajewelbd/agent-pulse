import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';

export const metadata: Metadata = {
  title: 'AI Usage Observability',
  description: 'Local-first record of every CLI coding agent interaction',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        <header className="border-b border-[--color-line] bg-[--color-surface-2]">
          <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
            <Link href="/" className="text-sm font-semibold tracking-tight">
              AI Usage Observability
            </Link>
            <nav className="flex gap-4 text-sm">
              <Link href="/" className="text-[--color-ink-2] hover:text-[--color-accent]">
                Turns
              </Link>
              <Link href="/aggregates" className="text-[--color-ink-2] hover:text-[--color-accent]">
                Aggregates
              </Link>
            </nav>
            <span className="ml-auto text-xs text-[--color-ink-2]">
              read-only · localhost · all times UTC
            </span>
          </div>
        </header>
        <main className="mx-auto max-w-[1600px] px-4 py-6">{children}</main>
      </body>
    </html>
  );
}
