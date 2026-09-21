import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="rounded-lg border border-[--color-line] p-8 text-center">
      <p className="text-sm">That turn does not exist.</p>
      <Link href="/" className="mt-2 inline-block text-sm text-[--color-accent]">← All turns</Link>
    </div>
  );
}
