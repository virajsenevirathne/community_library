import { platformFetch } from "./fetch.ts";

/** What a book metadata provider returns for an ISBN. */
export interface BookMetadata {
  isbn: string;
  title: string;
  authors: string[];
  /** HTTPS link to a cover image on one of COVER_HOSTS, or null. */
  coverUrl: string | null;
  source: string;
}

/**
 * A provider's answer: the book, null when it definitely doesn't know the
 * ISBN, or "unavailable" when it couldn't answer (down, slow or rate-limited).
 */
export type ProviderAnswer = BookMetadata | null | "unavailable";

export interface MetadataProvider {
  readonly name: string;
  /** Looks up an ISBN-13. Never throws. */
  lookup(isbn13: string): Promise<ProviderAnswer>;
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

const UNAVAILABLE = Symbol("unavailable");

/** The JSON body, or UNAVAILABLE when the service failed, timed out or refused (rate limit). */
async function getJson(fetcher: typeof fetch, url: string): Promise<unknown> {
  try {
    const res = await fetcher(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "CommunityLibrary/1.0 (open-source library app)",
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      // Rate limits are expected; anything else (a bad API key, say) is worth a log line.
      // Only the host and status: the URL can carry the API key.
      if (res.status !== 429)
        console.warn(`Book lookup failed: ${new URL(url).host} HTTP ${res.status}`);
      return UNAVAILABLE;
    }
    return await res.json();
  } catch {
    return UNAVAILABLE;
  }
}

function clean(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

const SMALL_WORDS = new Set([
  "a",
  "an",
  "and",
  "at",
  "by",
  "for",
  "in",
  "of",
  "on",
  "or",
  "the",
  "to",
]);

const capitalise = (word: string) =>
  // Words with digits (such as "3d") are left as they are.
  /\d/.test(word)
    ? word
    : word
        .split("-")
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join("-");

/**
 * Tidies titles as catalogues store them: "charlotte's web" and "Goodnight
 * moon" become "Charlotte's Web" and "Goodnight Moon", and seller-style
 * extras such as "by Maurice Sendak (Special Edition, 1 Jan 1967) Hardcover"
 * are dropped. Titles with capitals inside ("iPhone", "McDonald's") or in
 * all capitals are left alone.
 */
export function tidyTitle(title: string, authors: string[]): string {
  let result = title.replace(/\s+(hardcover|hardback|paperback|board book)$/i, "");
  // Only the last " by ", and only when a listed author's full name follows it.
  const by = result.match(/^(.+)\s+by\s+(.+)$/i);
  if (by?.[1] && by[2]) {
    const tail = by[2].toLowerCase();
    if (authors.some((a) => a.trim() && tail.startsWith(a.trim().toLowerCase()))) result = by[1];
  }
  const rest = result.slice(1);
  const allLower = result === result.toLowerCase();
  const sentenceCase = rest === rest.toLowerCase() && result.includes(" ");
  if (/[a-z]/.test(result) && (allLower || sentenceCase)) {
    let afterColon = false;
    result = result
      .split(" ")
      .map((word, i) => {
        const keepSmall = i > 0 && !afterColon && SMALL_WORDS.has(word);
        afterColon = word.endsWith(":");
        return keepSmall ? word : capitalise(word);
      })
      .join(" ");
  }
  return result.trim() || title;
}

/**
 * Drops repeated authors, including reversed duplicates such as "Vivas Julie"
 * next to "Julie Vivas". Of two forms, the later one is kept: catalogues tend
 * to list the raw "Surname Given" form first.
 */
export function tidyAuthors(authors: string[]): string[] {
  const byKey = new Map<string, string>();
  for (const name of authors) {
    const key = name
      .toLowerCase()
      .replace(/[.,]/g, " ")
      .split(/\s+/)
      .filter(Boolean)
      .sort()
      .join(" ");
    if (!key) continue;
    // Deleting first keeps the list in order of each name's last appearance.
    byKey.delete(key);
    byKey.set(key, name);
  }
  return [...byKey.values()];
}

/** Open Library (https://openlibrary.org): free, no key needed. */
export class OpenLibraryProvider implements MetadataProvider {
  readonly name = "openlibrary";
  constructor(private readonly fetcher: typeof fetch = platformFetch) {}

  async lookup(isbn: string): Promise<ProviderAnswer> {
    const raw = await getJson(
      this.fetcher,
      `https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`,
    );
    if (raw === UNAVAILABLE) return "unavailable";
    const data = raw as Record<
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
    const authors = tidyAuthors(
      (book.authors ?? []).map((a) => clean(a.name, 100)).filter(Boolean),
    ).slice(0, 10);
    return {
      isbn,
      title: tidyTitle(title, authors),
      authors,
      coverUrl: isAllowedCoverUrl(cover) ? cover : null,
      source: this.name,
    };
  }
}

/**
 * Google Books: a second source for books Open Library does not know (many
 * recent Australian editions, for example). Without an API key every site
 * shares one anonymous daily quota that is usually used up, so set a free
 * key (GOOGLE_BOOKS_API_KEY) for this to work reliably.
 */
export class GoogleBooksProvider implements MetadataProvider {
  readonly name = "googlebooks";
  constructor(
    private readonly fetcher: typeof fetch = platformFetch,
    private readonly apiKey?: string,
  ) {}

  async lookup(isbn: string): Promise<ProviderAnswer> {
    const key = this.apiKey ? `&key=${encodeURIComponent(this.apiKey)}` : "";
    const raw = await getJson(
      this.fetcher,
      `https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn}&maxResults=1${key}`,
    );
    if (raw === UNAVAILABLE) return "unavailable";
    const data = raw as {
      items?: {
        volumeInfo?: { title?: unknown; authors?: unknown[]; imageLinks?: { thumbnail?: unknown } };
      }[];
    } | null;
    const info = data?.items?.[0]?.volumeInfo;
    const title = clean(info?.title, 200);
    if (!info || !title) return null;
    const cover = clean(info.imageLinks?.thumbnail, 500).replace(/^http:/, "https:");
    const authors = tidyAuthors(
      (info.authors ?? []).map((a) => clean(a, 100)).filter(Boolean),
    ).slice(0, 10);
    return {
      isbn,
      title: tidyTitle(title, authors),
      authors,
      coverUrl: isAllowedCoverUrl(cover) ? cover : null,
      source: this.name,
    };
  }
}

export interface LookupResult {
  book: BookMetadata | null;
  /** No book, and at least one provider couldn't answer: worth trying again later. */
  unavailable: boolean;
}

/** Keeps `book`, taking only a missing author list or cover from `extra`. */
function fillGaps(book: BookMetadata, extra: BookMetadata): BookMetadata {
  return {
    ...book,
    authors: book.authors.length > 0 ? book.authors : extra.authors,
    coverUrl: book.coverUrl ?? extra.coverUrl,
  };
}

/**
 * Asks each provider in turn and returns the first book found. When that book
 * has no author or no cover, the remaining providers are asked to fill in
 * just those gaps (the first provider's title is kept).
 */
export async function lookupIsbn(
  providers: MetadataProvider[],
  isbn13: string,
): Promise<LookupResult> {
  let unavailable = false;
  let book: BookMetadata | null = null;
  for (const provider of providers) {
    if (book && book.authors.length > 0 && book.coverUrl) break;
    const answer = await provider.lookup(isbn13);
    if (answer === "unavailable") unavailable = true;
    else if (answer) book = book ? fillGaps(book, answer) : answer;
  }
  return book ? { book, unavailable: false } : { book: null, unavailable };
}
