import { parseCsv } from "@community-library/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestApp } from "../test/client.ts";
import { createTestEnv } from "../test/env.ts";
import { createLibrary, person } from "../test/fixtures.ts";
import { borrowSpeed } from "./admin.ts";

type Person = Awaited<ReturnType<typeof person>>;
let env: Env;
let dispose: () => Promise<void>;
let ctx: ReturnType<typeof createTestApp>;
let admin: Person;
let parent: Person;

beforeEach(async () => {
  ({ env, dispose } = await createTestEnv());
  ctx = createTestApp(env);
  await createLibrary(env, { settings: { closedWeekdays: [] } });
  admin = await person(ctx, { role: "admin" });
  parent = await person(ctx, { role: "member", familyName: "Lee" });
  await parent.request("/api/account/name", { method: "PUT", body: { firstName: "Priya" } });
});
afterEach(() => dispose());

async function addBook(title: string): Promise<string> {
  const res = await admin.json<{ title: { copies: { shortCode: string }[] } }>(
    "/api/catalog/titles",
    { body: { title, copies: 1 } },
  );
  return res.body.title.copies[0]?.shortCode ?? "";
}

async function csv(kind: string) {
  const res = await admin.request(`/api/admin/export/${kind}`);
  expect(res.status).toBe(200);
  expect(res.headers.get("Content-Type")).toMatch(/text\/csv/);
  expect(res.headers.get("Cache-Control")).toBe("no-store");
  expect(res.headers.get("Content-Disposition")).toMatch(
    new RegExp(`attachment; filename="lib-1-${kind}-\\d{4}-\\d{2}-\\d{2}\\.csv"`),
  );
  return parseCsv(await res.text());
}

describe("exporting the library's data", () => {
  it("gives the catalog, families and loans as CSV", async () => {
    const code = await addBook("=SUM(A1)");
    await parent.request(`/api/copies/${code}/borrow`, { body: {} });
    await admin.request(`/api/admin/families/${parent.familyId}/kiosk-people`, {
      body: { firstName: "Nana" },
    });

    const catalog = await csv("catalog");
    expect(catalog[0]).toEqual([
      "Title",
      "Authors",
      "ISBN",
      "Copy code",
      "Shelf",
      "Status",
      "Note",
      "Added",
    ]);
    // A title that looks like a formula stays text in a spreadsheet.
    expect(catalog[1]?.[0]).toBe("'=SUM(A1)");

    const families = await csv("families");
    const lee = families.filter((r) => r[0] === "Lee");
    expect(lee.map((r) => [r[3], r[4], r[5]])).toEqual([
      ["Priya", parent.email, "no"],
      ["Nana", "", "yes"],
    ]);

    const loans = await csv("loans");
    expect(loans[1]?.slice(0, 3)).toEqual(["'=SUM(A1)", code, "Lee"]);
    expect(loans[1]?.[6]).toBe("out");
    const logged = await env.DB.prepare(
      "select count(*) as n from events where type = 'data_exported'",
    ).first<number>("n");
    expect(logged).toBe(3);
  });

  it("is for admins only, and only their own library", async () => {
    const staff = await person(ctx, { role: "staff" });
    expect((await staff.request("/api/admin/export/families")).status).toBe(403);
    await createLibrary(env, { id: "lib-2" });
    await env.DB.prepare(
      "insert into families (id, library_id, name) values ('other', 'lib-2', 'Secret family')",
    ).run();
    const families = await csv("families");
    expect(families.flat()).not.toContain("Secret family");
    expect((await admin.request("/api/admin/export/users")).status).toBe(404);
  });
});

describe("exporting many loans", () => {
  it("sends every loan, a page at a time", async () => {
    const code = await addBook("Busy book");
    const copy = await env.DB.prepare("select id from copies where short_code = ?")
      .bind(code)
      .first<{ id: string }>();
    // 2,100 old loans of one copy: more than one page.
    const statements = Array.from({ length: 2100 }, (_, i) =>
      env.DB.prepare(
        "insert into loans (id, library_id, copy_id, family_id, borrowed_at, due_on, returned_at, outcome) values (?, 'lib-1', ?, ?, ?, '2026-01-01', ?, 'returned')",
      ).bind(`old-${String(i).padStart(5, "0")}`, copy?.id, parent.familyId, 1000 + (i % 7), 2000),
    );
    for (let i = 0; i < statements.length; i += 500)
      await env.DB.batch(statements.slice(i, i + 500));
    const rows = await csv("loans");
    expect(rows).toHaveLength(2101);
    expect(rows.filter((r) => r[0] === "Book")).toHaveLength(1);
  }, 60_000);
});

describe("the dashboard", () => {
  it("lists books nobody has borrowed yet", async () => {
    await addBook("Read me");
    const out = await addBook("Popular");
    await parent.request(`/api/copies/${out}/borrow`, { body: { elapsedMs: 3000 } });
    const res = await admin.json<{
      neverBorrowed: { total: number; titles: { title: string }[] };
      borrowSpeed: unknown;
    }>("/api/admin/dashboard");
    expect(res.body.neverBorrowed).toMatchObject({ total: 1, titles: [{ title: "Read me" }] });
    // One borrow isn't enough to say how quick borrowing is.
    expect(res.body.borrowSpeed).toBeNull();
  });

  it("works out how quick borrowing is", () => {
    expect(borrowSpeed([1000, 2000])).toBeNull();
    expect(borrowSpeed([1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 12_000])).toEqual({
      borrows: 10,
      withinGoal: 0.9,
      p90Seconds: 9,
      goalSeconds: 10,
    });
  });
});
