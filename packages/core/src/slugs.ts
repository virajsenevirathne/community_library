/**
 * Library addresses. Each library lives at `/<slug>/...` on the shared site;
 * the first path segment is either one of the site's own pages (below) or a
 * library's slug.
 */

/** Site-wide pages that sit at the top level, outside any library. */
export const SITE_PAGES = [
  "account",
  "c",
  "invite",
  "join",
  "owner",
  "reminders-off",
  "setup",
  "signin",
] as const;

/**
 * Words a library slug may never be: the site's pages, paths the server or
 * build use, and Phase 1 library pages (old links to `/admin/...` still
 * arrive and are sent on to the right library).
 */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  ...SITE_PAGES,
  "about",
  "admin",
  "api",
  "app",
  "assets",
  "favicon.ico",
  "help",
  "login",
  "logout",
  "privacy",
  "robots.txt",
  "signup",
  "static",
  "support",
  "terms",
  "www",
]);

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;

/** True for a well-formed slug that is not reserved, like "little-owls". */
export function isLibrarySlug(value: string): boolean {
  return SLUG_PATTERN.test(value) && !RESERVED_SLUGS.has(value);
}

/** A URL-friendly, never-reserved version of a name: "Little Owls" → "little-owls". */
export function slugify(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  if (!slug) return "library";
  return RESERVED_SLUGS.has(slug) ? `${slug}-library` : slug;
}
