import { describe, expect, it } from "vitest";
import { LABEL_TEMPLATES, labelsPerSheet } from "./labels.ts";
import {
  GoogleBooksProvider,
  isAllowedCoverUrl,
  lookupIsbn,
  OpenLibraryProvider,
  tidyAuthors,
  tidyTitle,
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
    expect(await provider.lookup("9780140328721")).toMatchObject({ title: "X", coverUrl: null });
    expect(isAllowedCoverUrl("http://covers.openlibrary.org/x.jpg")).toBe(false);
    expect(isAllowedCoverUrl("javascript:alert(1)")).toBe(false);
  });

  it("fall back to the next provider, and survive failures", async () => {
    const failing = new OpenLibraryProvider(fakeFetch({}, 500));
    const empty = new OpenLibraryProvider(fakeFetch({}));
    const google = new GoogleBooksProvider(
      fakeFetch({ items: [{ volumeInfo: { title: "Found" } }] }),
    );
    expect((await lookupIsbn([failing, empty, google], "9780140328721")).book?.title).toBe("Found");
    // A failed provider means "try again later", not "this ISBN doesn't exist".
    expect(await lookupIsbn([failing, empty], "9780140328721")).toEqual({
      book: null,
      unavailable: true,
    });
    expect(await lookupIsbn([empty, failing], "9780140328721")).toEqual({
      book: null,
      unavailable: true,
    });
    expect(await lookupIsbn([empty], "9780140328721")).toEqual({
      book: null,
      unavailable: false,
    });
  });

  it("fill a found book's missing author and cover from the next provider", async () => {
    const bare = new OpenLibraryProvider(
      fakeFetch({ "ISBN:9781742990057": { title: "Possum Magic" } }),
    );
    const google = new GoogleBooksProvider(
      fakeFetch({
        items: [
          {
            volumeInfo: {
              title: "Possum Magic (Board Book)",
              authors: ["Mem Fox"],
              imageLinks: { thumbnail: "http://books.google.com/books/content?id=x" },
            },
          },
        ],
      }),
    );
    expect((await lookupIsbn([bare, google], "9781742990057")).book).toMatchObject({
      title: "Possum Magic",
      authors: ["Mem Fox"],
      coverUrl: "https://books.google.com/books/content?id=x",
      source: "openlibrary",
    });
    // A complete first answer doesn't ask anyone else.
    let asked = false;
    const spy = { name: "spy", lookup: async () => ((asked = true), null) };
    const full = new OpenLibraryProvider(
      fakeFetch({
        "ISBN:9780140328721": {
          title: "Fantastic Mr Fox",
          authors: [{ name: "Roald Dahl" }],
          cover: { medium: "https://covers.openlibrary.org/b/id/1-M.jpg" },
        },
      }),
    );
    await lookupIsbn([full, spy], "9780140328721");
    expect(asked).toBe(false);
  });

  it("treat a rate-limited Google Books as unavailable, and send the key when set", async () => {
    const urls: string[] = [];
    const limited = (async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify({ error: { code: 429 } }), { status: 429 });
    }) as unknown as typeof fetch;
    expect(await new GoogleBooksProvider(limited).lookup("9781742990040")).toBe("unavailable");
    expect(urls[0]).not.toContain("key=");
    await new GoogleBooksProvider(limited, "k e/y").lookup("9781742990040");
    expect(urls[1]).toContain("&key=k%20e%2Fy");
  });

  it("tidy catalogue titles", () => {
    expect(tidyTitle("charlotte's web", ["E. B. White"])).toBe("Charlotte's Web");
    expect(tidyTitle("the cat in the hat", ["Dr. Seuss"])).toBe("The Cat in the Hat");
    expect(
      tidyTitle(
        "Where The Wild Things Are by Maurice Sendak (Special Edition, 1 Jan 1967) Hardcover",
        ["Maurice Sendak"],
      ),
    ).toBe("Where The Wild Things Are");
    // "by" that isn't the author stays.
    expect(tidyTitle("Stand by Me", ["Ben E. King"])).toBe("Stand by Me");
    expect(tidyTitle("Possum Magic", ["Mem Fox"])).toBe("Possum Magic");
    expect(tidyTitle("Goodnight moon", [])).toBe("Goodnight Moon");
    expect(tidyTitle("Possum magic", [])).toBe("Possum Magic");
    expect(tidyTitle("Matilda", [])).toBe("Matilda");
    expect(tidyTitle("matilda", [])).toBe("Matilda");
    // "by" in the title itself is kept, even when a short surname appears after it.
    expect(tidyTitle("Learning by Doing", ["Ng"])).toBe("Learning by Doing");
    expect(tidyTitle("Ruled by Fear by Joe Smith", ["Joe Smith"])).toBe("Ruled by Fear");
    expect(tidyTitle("HARRY POTTER", [])).toBe("HARRY POTTER");
    expect(tidyTitle("iPhone for kids", [])).toBe("iPhone for kids");
    expect(tidyTitle("web: a tale", [])).toBe("Web: A Tale");
    expect(tidyTitle("spider-man and friends", [])).toBe("Spider-Man and Friends");
    expect(tidyTitle("my 3d book", [])).toBe("My 3d Book");
  });

  it("drop repeated authors", () => {
    expect(tidyAuthors(["Mem Fox", "Vivas Julie", "Julie Vivas"])).toEqual([
      "Mem Fox",
      "Julie Vivas",
    ]);
    expect(tidyAuthors(["E. B. White", "E.B. White"])).toEqual(["E.B. White"]);
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
