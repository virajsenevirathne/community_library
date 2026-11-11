import { isLibrarySlug } from "@community-library/core";
import { type AnchorHTMLAttributes, type MouseEvent, useEffect, useState } from "react";

/**
 * A tiny router: paths are plain URLs (so QR links like /c/K7R2 work), and
 * links update history without reloading the page.
 *
 * Each library lives under its own address, `/little-owls/...`. Pages are
 * written as if the library were the whole site (`/admin/loans`); inside a
 * library, links and navigation add its address for them, and `useLocation`
 * gives the path without it. Site-wide pages (sign-in, account, sign-up and
 * invite links) stay at the top level.
 */
const listeners = new Set<() => void>();
let navigatedInApp = false;

/**
 * Pages that belong to the whole site, never to one library. (Account opens
 * inside a library too, so a family's settings for it are at hand.)
 */
const SITE_ONLY = new Set([
  "signin",
  "owner",
  "privacy",
  "terms",
  "about",
  "setup",
  "join",
  "invite",
  "reminders-off",
]);

/** The library the address belongs to ("little-owls" in /little-owls/admin), or null. */
export function libraryBase(pathname: string = window.location.pathname): string | null {
  const first = pathname.split("/")[1] ?? "";
  return isLibrarySlug(first) ? first : null;
}

/** Where a page's link really goes: inside the current library, unless it's a site-wide page. */
export function resolveHref(to: string): string {
  if (!to.startsWith("/") || to.startsWith("//")) return to;
  const base = libraryBase();
  const first = to.split(/[/?#]/)[1] ?? "";
  if (!base || SITE_ONLY.has(first)) return to;
  return `/${base}${to}`;
}

/**
 * Goes to `to`. Paths are placed in the current library (see above); pass
 * `absolute` for a full address such as another library's (`/brown-bears/`).
 */
export function navigate(
  to: string,
  options: { replace?: boolean; absolute?: boolean } = {},
): void {
  const target = options.absolute ? to : resolveHref(to);
  if (options.replace) history.replaceState(null, "", target);
  else history.pushState(null, "", target);
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

/**
 * The current page: `path` without the library's part of the address (so
 * `/little-owls/admin` gives `/admin`), and `base`, the library's slug or null.
 */
export function useLocation(): { path: string; base: string | null; query: URLSearchParams } {
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
  const full = window.location.pathname;
  const base = libraryBase(full);
  const path = base ? full.slice(base.length + 1) || "/" : full;
  return { path, base, query: new URLSearchParams(window.location.search) };
}

/** Only allow same-site paths as a "go here after sign-in" target. */
export function safeNext(value: string | null): string {
  if (!value?.startsWith("/") || value.startsWith("//")) return "/";
  // Backslashes and control characters can turn into "//elsewhere" in a browser.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this refuses
  if (/[\\\u0000-\u001f\u007f]/.test(value)) return "/";
  if (value === "/signin" || value.startsWith("/signin?")) return "/";
  return value;
}

export function Link(
  props: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; absolute?: boolean },
) {
  const { href: to, absolute, onClick, ...rest } = props;
  const href = absolute ? to : resolveHref(to);
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
    navigate(href, { absolute: true });
  };
  return <a href={href} onClick={handle} {...rest} />;
}
