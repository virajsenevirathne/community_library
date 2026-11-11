import { type LibrarySettings, parseSettings } from "@community-library/core";
import { asc } from "drizzle-orm";
import type { Db } from "./db/client.ts";
import { schema } from "./db/client.ts";

export interface LibraryInfo {
  id: string;
  name: string;
  slug: string;
  settings: LibrarySettings;
}

/**
 * The library this deployment serves. Each deployment runs one library for now;
 * every table is already scoped by library_id so a shared, multi-library
 * instance can be added later (VIR-22) by resolving the library from the URL.
 */
export async function currentLibrary(db: Db): Promise<LibraryInfo | null> {
  const row = await db.query.libraries.findFirst({
    columns: { id: true, name: true, slug: true, settings: true },
    orderBy: [asc(schema.libraries.createdAt), asc(schema.libraries.id)],
  });
  if (!row) return null;
  return { id: row.id, name: row.name, slug: row.slug, settings: parseSettings(row.settings) };
}

/** A URL-friendly version of a name: "Little Owls Daycare" → "little-owls-daycare". */
export function slugify(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "library";
}
