import { useEffect } from "react";

/** The library's colour on the whole page (green, the default, outside a library). */
export function useTheme(theme: string | undefined) {
  useEffect(() => {
    const root = document.documentElement;
    if (theme && theme !== "green") root.dataset.accent = theme;
    else delete root.dataset.accent;
  }, [theme]);
}
