/**
 * Inline stroke icons.
 *
 * Inline rather than an icon package: the dashboard uses about twenty glyphs,
 * and a dependency that ships a thousand of them is a bigger surface than the
 * paths themselves. `currentColor` throughout, so every icon inherits the
 * theme without a per-icon colour prop.
 */
type P = { className?: string };

function Svg({ className = 'h-4 w-4', children }: P & { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      {children}
    </svg>
  );
}

export const IconSpend = (p: P) => (
  <Svg {...p}><circle cx="12" cy="12" r="9" /><path d="M14.5 9.2a2.6 2.6 0 0 0-2.4-1.2c-1.4 0-2.4.7-2.4 1.9 0 2.6 5 1.4 5 4.1 0 1.2-1.1 2-2.6 2a2.8 2.8 0 0 1-2.6-1.4M12 6.4v11.2" /></Svg>
);

export const IconIn = (p: P) => (
  <Svg {...p}><path d="M12 19V5M6 11l6-6 6 6" /></Svg>
);

export const IconOut = (p: P) => (
  <Svg {...p}><path d="m12 3 9 4.5-9 4.5L3 7.5 12 3Z" /><path d="m3 12 9 4.5L21 12M3 16.5 12 21l9-4.5" /></Svg>
);

export const IconTerminal = (p: P) => (
  <Svg {...p}><path d="m4 7 4 4-4 4M12 15h8" /></Svg>
);

export const IconFile = (p: P) => (
  <Svg {...p}><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z" /><path d="M14 3v5h5" /></Svg>
);

export const IconSearch = (p: P) => (
  <Svg {...p}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></Svg>
);

export const IconCalendar = (p: P) => (
  <Svg {...p}><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" /></Svg>
);

export const IconFilter = (p: P) => (
  <Svg {...p}><path d="M3 5h18l-7 8v6l-4 2v-8L3 5Z" /></Svg>
);

export const IconChevronDown = (p: P) => (
  <Svg {...p}><path d="m6 9 6 6 6-6" /></Svg>
);

export const IconChevronLeft = (p: P) => (
  <Svg {...p}><path d="m15 18-6-6 6-6" /></Svg>
);

export const IconChevronRight = (p: P) => (
  <Svg {...p}><path d="m9 18 6-6-6-6" /></Svg>
);

export const IconSun = (p: P) => (
  <Svg {...p}><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></Svg>
);

export const IconMoon = (p: P) => (
  <Svg {...p}><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" /></Svg>
);

export const IconCopy = (p: P) => (
  <Svg {...p}><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V6a2 2 0 0 1 2-2h9" /></Svg>
);

export const IconExternal = (p: P) => (
  <Svg {...p}><path d="M14 4h6v6M20 4l-8 8" /><path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" /></Svg>
);

export const IconDownload = (p: P) => (
  <Svg {...p}><path d="M12 3v11M8 10l4 4 4-4M4 19h16" /></Svg>
);

export const IconClock = (p: P) => (
  <Svg {...p}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></Svg>
);

export const IconWarning = (p: P) => (
  <Svg {...p}><path d="M12 4 2.5 20h19L12 4Z" /><path d="M12 10v4M12 17.2v.1" /></Svg>
);

export const IconFolder = (p: P) => (
  <Svg {...p}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" /></Svg>
);

export const IconAgent = (p: P) => (
  <Svg {...p}><path d="m12 3 1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3Z" /></Svg>
);

export const IconBranch = (p: P) => (
  <Svg {...p}><circle cx="7" cy="5" r="2" /><circle cx="7" cy="19" r="2" /><circle cx="17" cy="9" r="2" /><path d="M7 7v10M17 11a5 5 0 0 1-5 5H7" /></Svg>
);

export const IconChip = (p: P) => (
  <Svg {...p}><rect x="6" y="6" width="12" height="12" rx="2" /><path d="M10 3v3M14 3v3M10 18v3M14 18v3M3 10h3M3 14h3M18 10h3M18 14h3" /></Svg>
);

export const IconLayers = (p: P) => (
  <Svg {...p}><path d="m12 3 8 4-8 4-8-4 8-4Z" /><path d="m4 13 8 4 8-4" /></Svg>
);

export const IconTable = (p: P) => (
  <Svg {...p}><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 10h18M9 10v9" /></Svg>
);

export const IconArrowLeft = (p: P) => (
  <Svg {...p}><path d="M19 12H5M11 6l-6 6 6 6" /></Svg>
);

export const IconInfo = (p: P) => (
  <Svg {...p}><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8v.1" /></Svg>
);

/**
 * The app mark.
 *
 * Its two strokes are literal hex, not theme tokens: this is brand colour, and
 * the mark has to stay the same in light and dark. Both read at 4.5:1 or better
 * against either surface, so nothing is lost by pinning them.
 */
export const AppLogo = ({ className = 'h-[22px] w-[22px]' }: P) => (
  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
    <circle cx="12" cy="4.6" r="2.3" stroke="#12c998" strokeWidth="1.7" />
    <circle cx="4.8" cy="17.4" r="2.3" stroke="#12c998" strokeWidth="1.7" />
    <circle cx="19.2" cy="17.4" r="2.3" stroke="#8b6cf6" strokeWidth="1.7" />
    <path
      d="M10.6 6.6 6.2 15.2M13.4 6.6l4.4 8.6M7.1 17.4h9.8"
      stroke="#12c998"
      strokeWidth="1.7"
      strokeLinecap="round"
    />
  </svg>
);
