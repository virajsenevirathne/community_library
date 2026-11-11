import { type LibrarySettings, normalizeShortCode, parseSettings } from "@community-library/core";
import { eq } from "drizzle-orm";
import type { Db } from "./db/client.ts";
import { schema } from "./db/client.ts";

export interface LibraryInfo {
  id: string;
  name: string;
  slug: string;
  settings: LibrarySettings;
}

/**
 * The request header that names the library a page belongs to. The browser
 * sets it from the address (`/little-owls/...`), so the API never guesses.
 */
export const LIBRARY_HEADER = "X-Library";

const columns = { id: true, name: true, slug: true, settings: true } as const;
type Row = { id: string; name: string; slug: string; settings: string };
const toInfo = (row: Row | undefined): LibraryInfo | null =>
  row
    ? { id: row.id, name: row.name, slug: row.slug, settings: parseSettings(row.settings) }
    : null;

/**
 * Looks a library up by its stored slug. Only the shape is checked here, not
 * the reserved words: those apply when a slug is chosen, and a library saved
 * before a word was reserved must still open.
 */
export async function libraryBySlug(db: Db, slug: string): Promise<LibraryInfo | null> {
  if (!/^[a-z0-9-]{1,64}$/.test(slug)) return null;
  return toInfo(
    await db.query.libraries.findFirst({ columns, where: eq(schema.libraries.slug, slug) }),
  );
}

export async function libraryById(db: Db, id: string): Promise<LibraryInfo | null> {
  return toInfo(
    await db.query.libraries.findFirst({ columns, where: eq(schema.libraries.id, id) }),
  );
}

/** A book's QR code is unique across the site, so it names its library. */
export async function libraryForCopyCode(db: Db, code: string): Promise<LibraryInfo | null> {
  const shortCode = normalizeShortCode(code);
  if (!shortCode) return null;
  const copy = await db.query.copies.findFirst({
    columns: { libraryId: true },
    where: eq(schema.copies.shortCode, shortCode),
  });
  return copy ? libraryById(db, copy.libraryId) : null;
}

/**
 * The library a request is about: for a book's own page
 * (`/api/copies/<code>/...`) the book's library, otherwise the one the page
 * names (the header).
 * Site-wide requests (account, sign-in) have none.
 */
export async function libraryForRequest(
  db: Db,
  path: string,
  header: string | undefined,
): Promise<LibraryInfo | null> {
  const copy = path.match(/^\/api\/copies\/([^/]+)/);
  let code: string | null = null;
  try {
    code = copy?.[1] ? decodeURIComponent(copy[1]) : null;
  } catch {
    // A malformed address (bad % escape) is just an unknown code.
  }
  const fromCopy = code ? await libraryForCopyCode(db, code) : null;
  if (fromCopy) return fromCopy;
  // An unknown code is answered by the page's own library ("not found").
  if (header) return libraryBySlug(db, header.trim().toLowerCase());
  return null;
}

/** The address of a library's home page, for links in emails. */
export function libraryHome(origin: string, library: Pick<LibraryInfo, "slug">): string {
  return `${origin}/${library.slug}`;
}
