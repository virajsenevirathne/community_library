import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestApp } from "../test/client.ts";
import { createTestEnv } from "../test/env.ts";
import { createLibrary, person } from "../test/fixtures.ts";

let env: Env;
let dispose: () => Promise<void>;
let ctx: ReturnType<typeof createTestApp>;
let staff: Awaited<ReturnType<typeof person>>;

beforeEach(async () => {
  ({ env, dispose } = await createTestEnv());
  ctx = createTestApp(env);
  await createLibrary(env);
  staff = await person(ctx, { role: "staff" });
});
afterEach(() => dispose());

interface Title {
  id: string;
  isbn: string | null;
  title: string;
  copies: { id: string; shortCode: string; status: string; labelPrinted: boolean }[];
}

describe("looking up an ISBN", () => {
  it("finds book details online, accepting ISBN-10 and dashes", async () => {
    const res = await staff.json("/api/catalog/lookup/0-14-032872-6");
    expect(res.body).toMatchObject({
      isbn: "9780140328721",
      found: true,
      title: "Fantastic Mr Fox",
      authors: "Roald Dahl",
    });
  });

  it("says when a book is not found, so staff can type it in", async () => {
    const res = await staff.json("/api/catalog/lookup/9781234567897");
    expect(res.body).toEqual({ isbn: "9781234567897", found: false });
  });

  it("rejects something that is not an ISBN", async () => {
    expect((await staff.json("/api/catalog/lookup/12345")).status).toBe(422);
  });

  it("reports a book already in the catalog", async () => {
    await staff.json("/api/catalog/titles", {
      body: { isbn: "9780140328721", title: "Fantastic Mr Fox" },
    });
    const res = await staff.json("/api/catalog/lookup/9780140328721");
    expect(res.body).toMatchObject({
      found: true,
      existing: { title: "Fantastic Mr Fox", copies: 1 },
    });
  });
});

describe("adding books", () => {
  it("creates a title with copies, each with its own short code", async () => {
    const res = await staff.json<{ title: Title; added: boolean }>("/api/catalog/titles", {
      body: {
        isbn: "978-0-14-032872-1",
        title: "Fantastic Mr Fox",
        authors: "Roald Dahl",
        copies: 3,
      },
    });
    expect(res.status).toBe(201);
    expect(res.body.added).toBe(true);
    expect(res.body.title.isbn).toBe("9780140328721");
    const codes = res.body.title.copies.map((c) => c.shortCode);
    expect(new Set(codes).size).toBe(3);
    for (const code of codes) expect(code).toMatch(/^[23456789ABCDEFGHJKMNPRTWXY]{4}$/);
    expect(res.body.title.copies.every((c) => c.status === "available" && !c.labelPrinted)).toBe(
      true,
    );
  });

  it("adds copies to the existing title when the ISBN is already in the catalog", async () => {
    const first = await staff.json<{ title: Title }>("/api/catalog/titles", {
      body: { isbn: "9780140328721", title: "Fantastic Mr Fox" },
    });
    const second = await staff.json<{ title: Title; added: boolean }>("/api/catalog/titles", {
      body: { isbn: "9780140328721", title: "Different spelling", copies: 2 },
    });
    expect(second.body.added).toBe(false);
    expect(second.body.title.id).toBe(first.body.title.id);
    expect(second.body.title.copies).toHaveLength(3);
  });

  it("accepts books with no ISBN", async () => {
    const res = await staff.json<{ title: Title }>("/api/catalog/titles", {
      body: { isbn: "", title: "Our class book of autumn leaves" },
    });
    expect(res.status).toBe(201);
    expect(res.body.title.isbn).toBeNull();
  });

  it("refuses cover links from other sites and silly copy counts", async () => {
    const bad = await staff.json("/api/catalog/titles", {
      body: { title: "X", coverUrl: "https://tracker.example/pixel.gif" },
    });
    expect(bad.status).toBe(422);
    expect(
      (await staff.json("/api/catalog/titles", { body: { title: "X", copies: 500 } })).status,
    ).toBe(422);
  });
});

describe("editing", () => {
  async function addBook() {
    return (
      await staff.json<{ title: Title }>("/api/catalog/titles", {
        body: { title: "Owl Babies", copies: 2 },
      })
    ).body.title;
  }

  it("changes a title and a copy's status", async () => {
    const title = await addBook();
    const edited = await staff.json<{ title: Title }>(`/api/catalog/titles/${title.id}`, {
      method: "PATCH",
      body: { authors: "Martin Waddell" },
    });
    expect(edited.status).toBe(200);
    const copyId = title.copies[0]?.id;
    const copy = await staff.json<{ title: Title }>(`/api/catalog/copies/${copyId}`, {
      method: "PATCH",
      body: { status: "damaged", note: "Torn cover" },
    });
    expect(copy.body.title.copies.find((c) => c.id === copyId)?.status).toBe("damaged");
  });

  it("searches by title or author", async () => {
    await addBook();
    await staff.json("/api/catalog/titles", {
      body: { title: "The Gruffalo", authors: "Julia Donaldson" },
    });
    const res = await staff.json<{ titles: { title: string }[] }>("/api/catalog/titles?q=donald");
    expect(res.body.titles.map((t) => t.title)).toEqual(["The Gruffalo"]);
    const wildcard = await staff.json<{ titles: unknown[] }>("/api/catalog/titles?q=%25");
    expect(wildcard.body.titles).toEqual([]);
  });
});

describe("labels", () => {
  it("lists copies that need a label until they are marked printed", async () => {
    await staff.json("/api/catalog/titles", { body: { title: "Owl Babies", copies: 2 } });
    const before = await staff.json<{ labels: { id: string; shortCode: string; title: string }[] }>(
      "/api/catalog/labels",
    );
    expect(before.body.labels).toHaveLength(2);
    await staff.json("/api/catalog/labels/printed", {
      body: { copyIds: before.body.labels.map((l) => l.id) },
    });
    expect(
      (await staff.json<{ labels: unknown[] }>("/api/catalog/labels")).body.labels,
    ).toHaveLength(0);
    // Reprinting a specific copy still works.
    const again = await staff.json<{ labels: unknown[] }>(
      `/api/catalog/labels?ids=${before.body.labels[0]?.id}`,
    );
    expect(again.body.labels).toHaveLength(1);
  });
});

describe("library isolation", () => {
  it("never shows or edits another library's books", async () => {
    await createLibrary(env, { id: "lib-2" });
    await env.DB.batch([
      env.DB.prepare(
        "insert into titles (id, library_id, title) values ('other-t', 'lib-2', 'Secret')",
      ),
      env.DB.prepare(
        "insert into copies (id, library_id, title_id, short_code) values ('other-c', 'lib-2', 'other-t', 'XXXX')",
      ),
    ]);
    expect((await staff.json("/api/catalog/titles/other-t")).status).toBe(404);
    expect(
      (
        await staff.json("/api/catalog/titles/other-t", {
          method: "PATCH",
          body: { title: "Mine" },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await staff.json("/api/catalog/copies/other-c", {
          method: "PATCH",
          body: { status: "lost" },
        })
      ).status,
    ).toBe(404);
    expect(
      (await staff.json<{ labels: unknown[] }>("/api/catalog/labels?ids=other-c")).body.labels,
    ).toEqual([]);
    const marked = await staff.json<{ marked: number }>("/api/catalog/labels/printed", {
      body: { copyIds: ["other-c"] },
    });
    expect(marked.body.marked).toBe(0);
    const titles = await staff.json<{ titles: { title: string }[] }>("/api/catalog/titles");
    expect(titles.body.titles.map((t) => t.title)).not.toContain("Secret");
  });
});

describe("larger batches (D1 allows 100 values per statement)", () => {
  it("adds 20 copies at once", async () => {
    const res = await staff.json<{ title: Title }>("/api/catalog/titles", {
      body: { title: "Big box of board books", copies: 20 },
    });
    expect(res.status).toBe(201);
    expect(res.body.title.copies).toHaveLength(20);
  });

  it("prints and marks 120 labels", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await staff.json<{ title: Title }>("/api/catalog/titles", {
        body: { title: `Book ${i}`, copies: 20 },
      });
      ids.push(...res.body.title.copies.map((c) => c.id));
    }
    const listed = await staff.json<{ labels: unknown[] }>(
      `/api/catalog/labels?ids=${ids.join(",")}`,
    );
    expect(listed.body.labels).toHaveLength(120);
    const marked = await staff.json<{ marked: number }>("/api/catalog/labels/printed", {
      body: { copyIds: ids },
    });
    expect(marked.body.marked).toBe(120);
  });
});

describe("copy status and history", () => {
  it("refuses to change the status of a copy that is on loan", async () => {
    const title = (
      await staff.json<{ title: Title }>("/api/catalog/titles", { body: { title: "Owl Babies" } })
    ).body.title;
    const copyId = title.copies[0]?.id ?? "";
    await env.DB.prepare(
      "insert into families (id, library_id, name) values ('fam', 'lib-1', 'F')",
    ).run();
    await env.DB.prepare(
      "insert into loans (id, library_id, copy_id, family_id, borrowed_at, due_on) values ('loan', 'lib-1', ?, 'fam', 0, '2026-12-01')",
    )
      .bind(copyId)
      .run();
    const res = await staff.json(`/api/catalog/copies/${copyId}`, {
      method: "PATCH",
      body: { status: "retired" },
    });
    expect(res.status).toBe(409);
    // A note can still be added.
    const note = await staff.json(`/api/catalog/copies/${copyId}`, {
      method: "PATCH",
      body: { note: "Spine taped" },
    });
    expect(note.status).toBe(200);
  });

  it("records who added, edited and printed, without personal details", async () => {
    const title = (
      await staff.json<{ title: Title }>("/api/catalog/titles", { body: { title: "Owl Babies" } })
    ).body.title;
    await staff.json(`/api/catalog/titles/${title.id}`, {
      method: "PATCH",
      body: { authors: "M. Waddell" },
    });
    await staff.json("/api/catalog/labels/printed", {
      body: { copyIds: title.copies.map((c) => c.id) },
    });
    const { results } = await env.DB.prepare(
      "select type, payload, actor_user_id from events order by created_at",
    ).all<{
      type: string;
      payload: string;
      actor_user_id: string;
    }>();
    expect(results.map((r) => r.type)).toEqual(["title_added", "title_edited", "labels_printed"]);
    expect(results.every((r) => r.actor_user_id === staff.userId)).toBe(true);
    expect(JSON.parse(results[1]?.payload ?? "{}")).toEqual({
      titleId: title.id,
      fields: ["authors"],
    });
  });

  it("keeps a failed add from leaving a title with no copies", async () => {
    const res = await staff.json("/api/catalog/titles", { body: { title: "X", copies: 0 } });
    expect(res.status).toBe(422);
    expect(await env.DB.prepare("select count(*) as n from titles").first("n")).toBe(0);
  });
});
