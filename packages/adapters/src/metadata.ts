/** What a book metadata provider returns for an ISBN. */
export interface BookMetadata {
  isbn: string;
  title: string;
  authors: string[];
  /** HTTPS link to a cover image on one of COVER_HOSTS, or null. */
  coverUrl: string | null;
  source: string;
}

export interface MetadataProvider {
  readonly name: string;
  /** Looks up an ISBN-13. Returns null when the book is not found or the service fails. */
  lookup(isbn13: string): Promise<BookMetadata | null>;
}

/** Cover images are only accepted from these hosts, so a stored link cannot point anywhere else. */
export const COVER_HOSTS = [
  "covers.openlibrary.org",
  "books.google.com",
  "books.googleusercontent.com",
];

export function isAllowedCoverUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && COVER_HOSTS.includes(url.hostname);
  } catch {
    return false;
  }
}

const TIMEOUT_MS = 5000;

async function getJson(fetcher: typeof fetch, url: string): Promise<unknown> {
  try {
    const res = await fetcher(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "CommunityLibrary/1.0 (open-source library app)",
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function clean(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

/** Open Library (https://openlibrary.org): free, no key needed. */
export class OpenLibraryProvider implements MetadataProvider {
  readonly name = "openlibrary";
  constructor(private readonly fetcher: typeof fetch = fetch) {}

  async lookup(isbn: string): Promise<BookMetadata | null> {
    const data = (await getJson(
      this.fetcher,
      `https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`,
    )) as Record<
      string,
      {
        title?: unknown;
        subtitle?: unknown;
        authors?: { name?: unknown }[];
        cover?: { medium?: unknown };
      }
    > | null;
    const book = data?.[`ISBN:${isbn}`];
    const title = clean(book?.title, 200);
    if (!book || !title) return null;
    const cover = clean(book.cover?.medium, 500).replace(/^http:/, "https:");
    return {
      isbn,
      title,
      authors: (book.authors ?? [])
        .map((a) => clean(a.name, 100))
        .filter(Boolean)
        .slice(0, 10),
      coverUrl: isAllowedCoverUrl(cover) ? cover : null,
      source: this.name,
    };
  }
}

/** Google Books: a second source for books Open Library does not know. Free for low volume. */
export class GoogleBooksProvider implements MetadataProvider {
  readonly name = "googlebooks";
  constructor(private readonly fetcher: typeof fetch = fetch) {}

  async lookup(isbn: string): Promise<BookMetadata | null> {
    const data = (await getJson(
      this.fetcher,
      `https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn}&maxResults=1`,
    )) as {
      items?: {
        volumeInfo?: { title?: unknown; authors?: unknown[]; imageLinks?: { thumbnail?: unknown } };
      }[];
    } | null;
    const info = data?.items?.[0]?.volumeInfo;
    const title = clean(info?.title, 200);
    if (!info || !title) return null;
    const cover = clean(info.imageLinks?.thumbnail, 500).replace(/^http:/, "https:");
    return {
      isbn,
      title,
      authors: (info.authors ?? [])
        .map((a) => clean(a, 100))
        .filter(Boolean)
        .slice(0, 10),
      coverUrl: isAllowedCoverUrl(cover) ? cover : null,
      source: this.name,
    };
  }
}

/** Asks each provider in turn and returns the first answer. */
export async function lookupIsbn(
  providers: MetadataProvider[],
  isbn13: string,
): Promise<BookMetadata | null> {
  for (const provider of providers) {
    const result = await provider.lookup(isbn13);
    if (result) return result;
  }
  return null;
}
