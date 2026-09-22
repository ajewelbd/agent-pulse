'use client';

import { useEffect, useRef, useState } from 'react';
import { IconCopy } from './icons';

/**
 * Copy-to-clipboard.
 *
 * The clipboard API needs a secure context; over plain http on anything but
 * localhost it is simply absent. The button says so rather than appearing to
 * work and silently doing nothing.
 */
export function CopyButton({
  value,
  label = 'Copy',
  className,
}: {
  value: string;
  label?: string;
  className?: string;
}) {
  const [state, setState] = useState<'idle' | 'done' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setState('done');
    } catch {
      setState('failed');
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), 1800);
  };

  return (
    <button
      type="button"
      onClick={copy}
      title={value}
      className={
        className ??
        'flex items-center gap-1.5 rounded-lg border border-line bg-surface px-3 py-1.5 text-xs text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink'
      }
    >
      <IconCopy className="h-3.5 w-3.5" />
      {state === 'done' ? 'Copied' : state === 'failed' ? 'Clipboard blocked' : label}
    </button>
  );
}
