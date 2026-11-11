/**
 * Small inline icons (24×24, stroke uses the text colour). Decorative unless
 * a label is given: icons always sit next to words, so meaning never depends
 * on the picture alone.
 */
const PATHS = {
  book: "M4 5a2 2 0 0 1 2-2h12v16H6a2 2 0 0 0-2 2V5Zm0 16a2 2 0 0 1 2-2h12v2H6",
  scan: "M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M7 12h10",
  user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 8a7 7 0 0 1 14 0",
  grid: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z",
  return: "M9 14 4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3",
  list: "M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01",
  plus: "M12 5v14M5 12h14",
  chevron: "M9 6l6 6-6 6",
  keyboard:
    "M3 7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Zm4 3h.01M11 10h.01M15 10h.01M8 15h8",
  library: "M4 19V5M9 19V5M14 19l-1-14M19 19 16 5",
  tag: "M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9-9-9Zm5-4h.01",
  family:
    "M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm8 0a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM3 20a6 6 0 0 1 12 0M15 20a5 5 0 0 1 6-4.9",
  settings:
    "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7.4-3a7.4 7.4 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7.5 7.5 0 0 0-2-1.2L14.5 3h-5l-.4 2.6a7.5 7.5 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6a7.4 7.4 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1a7.5 7.5 0 0 0 2 1.2l.4 2.6h5l.4-2.6a7.5 7.5 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2Z",
  info: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Zm0-11v6m0-9h.01",
  warning:
    "M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0ZM12 9v4m0 4h.01",
  error: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Zm3-13-6 6m0-6 6 6",
  check: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Zm-4-10 3 3 5-6",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      width="24"
      height="24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}

/** The site's mark: a joey (baby kangaroo) peeking over a book. Matches public/favicon.svg. */
export function JoeyMark({ className }: { className?: string }) {
  const fur = "#c98a5a";
  const ear = "#b8784a";
  const light = "#f2c9a5";
  const ink = "#3d2a00";
  return (
    <svg className={className} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <circle cx="16" cy="16" r="16" fill="var(--sun)" />
      <ellipse cx="9" cy="8.6" rx="2.9" ry="4.4" transform="rotate(-32 9 8.6)" fill={ear} />
      <ellipse cx="23" cy="8.6" rx="2.9" ry="4.4" transform="rotate(32 23 8.6)" fill={ear} />
      <ellipse cx="9.3" cy="9" rx="1.3" ry="2.6" transform="rotate(-32 9.3 9)" fill={light} />
      <ellipse cx="22.7" cy="9" rx="1.3" ry="2.6" transform="rotate(32 22.7 9)" fill={light} />
      <ellipse cx="16" cy="14.2" rx="7" ry="6.4" fill={fur} />
      <ellipse cx="16" cy="16.4" rx="3.6" ry="2.8" fill={light} />
      <circle cx="13" cy="13" r="1.2" fill={ink} />
      <circle cx="19" cy="13" r="1.2" fill={ink} />
      <ellipse cx="16" cy="15.4" rx="1.3" ry="0.95" fill={ink} />
      <rect x="5.5" y="18.5" width="21" height="9" rx="2.6" fill="var(--sky)" />
      <rect x="15.4" y="18.5" width="1.2" height="9" fill="#ffffff" opacity="0.55" />
    </svg>
  );
}

/**
 * The site's cheerful picture: a stack of colourful books under a smiling
 * sun. Decorative; colours come from the theme so it suits light and dark.
 */
export function BookStack({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 200 170"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      {/* sun */}
      <g stroke="var(--sun)" strokeWidth="5" strokeLinecap="round">
        <path d="M150 12v10M178 22l-7 7M190 50h-10M122 22l7 7" />
      </g>
      <circle cx="150" cy="50" r="22" fill="var(--sun)" />
      <circle cx="142" cy="46" r="2.6" fill="#3d2a00" />
      <circle cx="158" cy="46" r="2.6" fill="#3d2a00" />
      <path d="M141 56c5 6 13 6 18 0" stroke="#3d2a00" strokeWidth="3" strokeLinecap="round" />
      {/* books */}
      <rect x="22" y="128" width="150" height="26" rx="6" fill="var(--sky)" />
      <rect x="30" y="134" width="96" height="5" rx="2.5" fill="#ffffff" opacity="0.75" />
      <rect x="150" y="128" width="8" height="26" fill="#ffffff" opacity="0.35" />
      <rect x="34" y="100" width="128" height="26" rx="6" fill="var(--coral)" />
      <rect x="42" y="106" width="70" height="5" rx="2.5" fill="#ffffff" opacity="0.75" />
      <rect x="140" y="100" width="8" height="26" fill="#ffffff" opacity="0.35" />
      <rect x="26" y="72" width="118" height="26" rx="6" fill="var(--accent)" />
      <rect x="34" y="78" width="60" height="5" rx="2.5" fill="#ffffff" opacity="0.75" />
      <rect x="122" y="72" width="8" height="26" fill="#ffffff" opacity="0.35" />
      {/* open book on top */}
      <path d="M48 66c14-12 28-12 38-2v-30c-10-10-24-10-38 2v30Z" fill="var(--plum)" />
      <path d="M124 66c-14-12-28-12-38-2v-30c10-10 24-10 38 2v30Z" fill="var(--plum)" />
      <path d="M86 34v30" stroke="#ffffff" strokeWidth="2.5" opacity="0.7" />
      <path
        d="M56 44c8-5 15-5 22 0M56 52c8-5 15-5 22 0M94 44c7-5 14-5 22 0M94 52c7-5 14-5 22 0"
        stroke="#ffffff"
        strokeWidth="2.5"
        strokeLinecap="round"
        opacity="0.8"
      />
      {/* sparkles */}
      <path
        d="M18 40l3 8 8 3-8 3-3 8-3-8-8-3 8-3 3-8ZM180 96l2 5 5 2-5 2-2 5-2-5-5-2 5-2 2-5Z"
        fill="var(--sun)"
      />
    </svg>
  );
}
