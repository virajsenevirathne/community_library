import { describe, expect, it } from "vitest";
import { LABEL_TEMPLATES, labelsPerSheet } from "./labels.ts";
import {
  GoogleBooksProvider,
  isAllowedCoverUrl,
  lookupIsbn,
  OpenLibraryProvider,
} from "./metadata.ts";

const fakeFetch = (body: unknown, status = 200) =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe("metadata providers", () => {
  it("read a book from Open Library", async () => {
    const provider = new OpenLibraryProvider(
      fakeFetch({
        "ISBN:9780140328721": {
          title: "  Fantastic   Mr Fox ",
          authors: [{ name: "Roald Dahl" }],
          cover: { medium: "http://covers.openlibrary.org/b/id/1-M.jpg" },
        },
      }),
    );
    expect(await provider.lookup("9780140328721")).toEqual({
      isbn: "9780140328721",
      title: "Fantastic Mr Fox",
      authors: ["Roald Dahl"],
      coverUrl: "https://covers.openlibrary.org/b/id/1-M.jpg",
      source: "openlibrary",
    });
  });

  it("drop cover links on hosts we do not trust", async () => {
    const provider = new GoogleBooksProvider(
      fakeFetch({
        items: [
          { volumeInfo: { title: "X", imageLinks: { thumbnail: "https://evil.example/x.png" } } },
        ],
      }),
    );
    expect((await provider.lookup("9780140328721"))?.coverUrl).toBeNull();
    expect(isAllowedCoverUrl("http://covers.openlibrary.org/x.jpg")).toBe(false);
    expect(isAllowedCoverUrl("javascript:alert(1)")).toBe(false);
  });

  it("fall back to the next provider, and survive failures", async () => {
    const failing = new OpenLibraryProvider(fakeFetch({}, 500));
    const empty = new OpenLibraryProvider(fakeFetch({}));
    const google = new GoogleBooksProvider(
      fakeFetch({ items: [{ volumeInfo: { title: "Found" } }] }),
    );
    expect((await lookupIsbn([failing, empty, google], "9780140328721"))?.title).toBe("Found");
    expect(await lookupIsbn([failing, empty], "9780140328721")).toBeNull();
  });
});

describe("label templates", () => {
  it("fit on their page", () => {
    for (const t of LABEL_TEMPLATES) {
      const right = t.margin.left + (t.columns - 1) * t.pitch.x + t.label.width;
      const bottom = t.margin.top + (t.rows - 1) * t.pitch.y + t.label.height;
      expect(right, t.id).toBeLessThanOrEqual(t.page.width);
      expect(bottom, t.id).toBeLessThanOrEqual(t.page.height + 0.01);
      expect(labelsPerSheet(t)).toBeGreaterThan(0);
    }
  });
});
