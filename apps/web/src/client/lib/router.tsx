import { type AnchorHTMLAttributes, type MouseEvent, useEffect, useState } from "react";

/**
 * A tiny router: paths are plain URLs (so QR links like /c/K7R2 work), and
 * links update history without reloading the page.
 */
const listeners = new Set<() => void>();
let navigatedInApp = false;

export function navigate(to: string, options: { replace?: boolean } = {}): void {
  if (options.replace) history.replaceState(null, "", to);
  else history.pushState(null, "", to);
  navigatedInApp = true;
  for (const listener of listeners) listener();
  window.scrollTo(0, 0);
}

/** True once the person has moved between pages without a full reload. */
export function hasNavigated(): boolean {
  return navigatedInApp;
}

if (typeof window !== "undefined") {
  window.addEventListener("popstate", () => {
    navigatedInApp = true;
  });
}

export function useLocation(): { path: string; query: URLSearchParams } {
  const [, setTick] = useState(0);
  useEffect(() => {
    const update = () => setTick((t) => t + 1);
    listeners.add(update);
    window.addEventListener("popstate", update);
    return () => {
      listeners.delete(update);
      window.removeEventListener("popstate", update);
    };
  }, []);
  return { path: window.location.pathname, query: new URLSearchParams(window.location.search) };
}

/** Only allow same-site paths as a "go here after sign-in" target. */
export function safeNext(value: string | null): string {
  if (!value?.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return "/";
  return value;
}

export function Link(props: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  const { href, onClick, ...rest } = props;
  const handle = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey
    )
      return;
    event.preventDefault();
    navigate(href);
  };
  return <a href={href} onClick={handle} {...rest} />;
}
