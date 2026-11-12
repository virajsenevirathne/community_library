import { useEffect } from "react";

const KEY = "theme:";

/** The colour this browser last saw for a library, until its own arrives. */
export function storedTheme(slug: string | null): string | undefined {
  if (!slug) return undefined;
  try {
    return localStorage.getItem(KEY + slug) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * The library's colour on the whole page (green, the default, outside a
 * library). Each library's colour is remembered, so its pages open in it
 * straight away next time (public/theme.js) instead of flashing green.
 */
export function useTheme(
  theme: string | undefined,
  slug: string | null | undefined,
  /** False when another part of the page sets the colour (the kiosk). */
  enabled = true,
) {
  useEffect(() => {
    if (!enabled) return;
    const root = document.documentElement;
    if (theme && theme !== "green") root.dataset.accent = theme;
    else delete root.dataset.accent;
    if (theme && slug) {
      try {
        localStorage.setItem(KEY + slug, theme);
      } catch {
        // Private mode: the colour arrives a moment later instead.
      }
    }
    return () => {
      delete root.dataset.accent;
    };
  }, [theme, slug, enabled]);
}
