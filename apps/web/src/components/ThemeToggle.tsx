'use client';

import { useEffect, useState } from 'react';
import { IconMoon, IconSun } from './icons';

/**
 * Light / dark switch.
 *
 * The chosen theme is written to <html data-theme> and to localStorage; the
 * inline script in the layout replays it before first paint so there is no
 * flash. Until this component hydrates it renders neither side as active,
 * because the server cannot know which one is — guessing would mean the
 * highlight visibly jumps on load.
 */
export const THEME_KEY = 'aiuo.theme';

type Theme = 'light' | 'dark';

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme | null>(null);

  useEffect(() => {
    const stored = window.localStorage.getItem(THEME_KEY);
    if (stored === 'light' || stored === 'dark') {
      setTheme(stored);
      return;
    }
    setTheme(window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  }, []);

  const choose = (next: Theme) => {
    setTheme(next);
    document.documentElement.dataset.theme = next;
    try {
      window.localStorage.setItem(THEME_KEY, next);
    } catch {
      // Private-mode storage denial is not worth breaking the toggle over;
      // the theme still applies for this page view.
    }
  };

  const btn = (active: boolean) =>
    `flex h-7 w-8 items-center justify-center rounded-full transition-colors ${
      active ? 'bg-surface text-ink shadow-[var(--shadow)]' : 'text-ink-3 hover:text-ink-2'
    }`;

  return (
    <div className="flex items-center gap-0.5 rounded-full border border-line bg-surface-2 p-0.5">
      <button type="button" aria-label="Light theme" aria-pressed={theme === 'light'} onClick={() => choose('light')} className={btn(theme === 'light')}>
        <IconSun className="h-3.5 w-3.5" />
      </button>
      <button type="button" aria-label="Dark theme" aria-pressed={theme === 'dark'} onClick={() => choose('dark')} className={btn(theme === 'dark')}>
        <IconMoon className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
