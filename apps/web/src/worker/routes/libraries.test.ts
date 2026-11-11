import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestApp, TestClient } from "../test/client.ts";
import { createTestEnv } from "../test/env.ts";
import { createLibrary, person } from "../test/fixtures.ts";

/*
 * One site, many libraries: each request acts in the library its page names
 * (the X-Library header), a book's code names its own library, and sign-up
 * links and invites find theirs from their tokens.
 */

type Person = Awaited<ReturnType<typeof person>>;
let env: Env;
let dispose: () => Promise<void>;
let ctx: ReturnType<typeof createTestApp>;
let owlsStaff: Person;
let bearsStaff: Person;

beforeEach(async () => {
  ({ env, dispose } = await createTestEnv());
  ctx = createTestApp(env);
  await createLibrary(env, { id: "lib-1", name: "Little Owls", settings: { closedWeekdays: [] } });
  await createLibrary(env, { id: "lib-2", name: "Brown Bears", settings: { closedWeekdays: [] } });
  owlsStaff = await person(ctx, { role: "staff", libraryId: "lib-1" });
  bearsStaff = await person(ctx, { role: "staff", libraryId: "lib-2" });
});
afterEach(() => dispose());

async function addBook(staff: Person, title: string) {
  const res = await staff.json<{ title: { copies: { shortCode: string }[] } }>(
    "/api/catalog/titles",
    { body: { title, copies: 1 } },
  );
  return res.body.title.copies[0]?.shortCode ?? "";
}

/** Gives an existing person a second membership, in another library. */
async function joinAlso(who: Person, libraryId: string, role: "member" | "staff" | "admin") {
  const familyId = role === "member" ? `family-${who.userId}-${libraryId}` : null;
  if (familyId) {
    await env.DB.prepare("insert into families (id, library_id, name) values (?, ?, 'Also')")
      .bind(familyId, libraryId)
      .run();
  }
  await env.DB.prepare(
    "insert into memberships (id, library_id, user_id, role, family_id) values (?, ?, ?, ?, ?)",
  )
    .bind(`m-${who.userId}-${libraryId}`, libraryId, who.userId, role, familyId)
    .run();
  return familyId;
}

describe("choosing the library", () => {
  it("lists every library a person belongs to, and their role in the one they're in", async () => {
    await joinAlso(owlsStaff, "lib-2", "member");
    owlsStaff.library = null;
    expect((await owlsStaff.json("/api/me")).body).toMatchObject({
      library: null,
      membership: null,
      libraries: [
        { slug: "lib-2", name: "Brown Bears", role: "member" },
        { slug: "lib-1", name: "Little Owls", role: "staff" },
      ],
    });
    owlsStaff.library = "lib-2";
    expect((await owlsStaff.json("/api/me")).body).toMatchObject({
      library: { slug: "lib-2", name: "Brown Bears" },
      membership: { role: "member" },
    });
  });

  it("keeps each library's data to itself", async () => {
    await addBook(owlsStaff, "Owl Babies");
    await addBook(bearsStaff, "We're Going on a Bear Hunt");
    const owls = await owlsStaff.json<{ titles: { title: string }[] }>("/api/catalog/titles");
    expect(owls.body.titles.map((t) => t.title)).toEqual(["Owl Babies"]);
    // Pointing at another library doesn't let staff in.
    owlsStaff.library = "lib-2";
    expect((await owlsStaff.json("/api/catalog/titles")).status).toBe(403);
    expect((await owlsStaff.json("/api/admin/loans")).status).toBe(403);
  });

  it("treats an unknown library as no library", async () => {
    owlsStaff.library = "no-such-place";
    expect((await owlsStaff.json("/api/me")).body).toMatchObject({ library: null });
    expect((await owlsStaff.json("/api/catalog/titles")).status).toBe(403);
  });
});

describe("book codes across libraries", () => {
  it("opens a book in its own library, whichever page the scan came from", async () => {
    const code = await addBook(bearsStaff, "Bear Hunt");
    const parent = await person(ctx, { role: "member", libraryId: "lib-2" });
    parent.library = null;
    const res = await parent.json<{ copy: { title: { title: string } } }>(`/api/copies/${code}`);
    expect(res.status).toBe(200);
    expect(res.body.copy.title.title).toBe("Bear Hunt");
  });

  it("answers people outside the book's library exactly as for a mistyped code", async () => {
    const code = await addBook(bearsStaff, "Bear Hunt");
    const parent = await person(ctx, { role: "member", libraryId: "lib-1" });
    const theirs = await parent.json(`/api/copies/${code}`);
    const typo = await parent.json("/api/copies/QQQQ");
    expect(theirs.status).toBe(404);
    expect(theirs.body).toEqual(typo.body);
    expect((await parent.json(`/api/copies/${code}/borrow`, { body: {} })).status).toBe(404);
  });
});

describe("book codes for people outside every library", () => {
  it("asks someone who hasn't joined anywhere to get the sign-up link", async () => {
    const code = await addBook(bearsStaff, "Bear Hunt");
    const newcomer = await person(ctx, { role: "none" });
    const res = await newcomer.json(`/api/copies/${code}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "not_a_member" });
  });

  it("asks people who aren't signed in to sign in", async () => {
    const code = await addBook(bearsStaff, "Bear Hunt");
    const visitor = new TestClient(ctx, "visitor@example.com");
    visitor.library = null;
    expect((await visitor.request(`/api/copies/${code}`)).status).toBe(401);
  });

  it("treats a malformed code as unknown, not as an error", async () => {
    const res = await owlsStaff.request("/api/copies/%E0%A4%A");
    expect(res.status).toBe(404);
  });
});

describe("library names", () => {
  it("are shown only to the library's members", async () => {
    owlsStaff.library = "lib-2";
    expect((await owlsStaff.json("/api/me")).body).toMatchObject({ library: null });
    const visitor = new TestClient(ctx, "visitor@example.com");
    visitor.library = "lib-1";
    expect((await visitor.json("/api/me")).body).toMatchObject({ library: null });
  });
});

describe("links that name their own library", () => {
  it("finds a sign-up link's library from its token, whatever page it's opened on", async () => {
    const admin = await person(ctx, { role: "admin", libraryId: "lib-2" });
    const link = await admin.json<{ joinUrl: string }>("/api/admin/join-link", {
      body: { enabled: true },
    });
    const token = link.body.joinUrl.split("/join/")[1] ?? "";
    const newcomer = new TestClient(ctx, "new@example.com");
    newcomer.library = "lib-1";
    expect((await newcomer.json(`/api/join/${token}`)).body).toMatchObject({
      library: { name: "Brown Bears" },
    });
  });

  it("puts the library's own address in its emails", async () => {
    const code = await addBook(owlsStaff, "Owl Babies");
    const parent = await person(ctx, { role: "member", libraryId: "lib-1" });
    await parent.json(`/api/copies/${code}/borrow`, { body: {} });
    await ctx.settle();
    expect(ctx.outbox.last(parent.email)?.text).toContain("/lib-1/");
  });
});

describe("deleting an account that belongs to several libraries", () => {
  it("is blocked by books still out in any of them", async () => {
    const code = await addBook(bearsStaff, "Bear Hunt");
    const parent = await person(ctx, { role: "member", libraryId: "lib-1" });
    await joinAlso(parent, "lib-2", "member");
    parent.library = "lib-2";
    expect((await parent.json(`/api/copies/${code}/borrow`, { body: {} })).status).toBe(201);
    // Asked from the first library's pages, the second library's book still counts.
    parent.library = "lib-1";
    const res = await parent.json("/api/account/delete/start", { body: {} });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ books: [{ title: "Bear Hunt" }] });
  });

  it("removes the family only in libraries where the person was its last parent", async () => {
    const parent = await person(ctx, { role: "member", libraryId: "lib-1" });
    const partner = await person(ctx, {
      role: "member",
      libraryId: "lib-1",
      familyId: parent.familyId,
    });
    const bearsFamily = await joinAlso(parent, "lib-2", "member");
    const code = (
      await parent.json<{ codeSent: boolean; familyWillBeRemoved: boolean }>(
        "/api/account/delete/start",
        { body: {} },
      )
    ).body;
    expect(code).toMatchObject({ codeSent: true, familyWillBeRemoved: true });
    const sent = ctx.outbox.last(parent.email)?.text.match(/\b(\d{6})\b/)?.[1] ?? "";
    const done = await parent.json("/api/account/delete/confirm", { body: { code: sent } });
    expect(done.status).toBe(200);
    const families = await env.DB.prepare("select id from families where id in (?, ?)")
      .bind(parent.familyId, bearsFamily)
      .all<{ id: string }>();
    // The Owls family still has the partner; the Bears family had only this parent.
    expect(families.results.map((f) => f.id)).toEqual([parent.familyId]);
    expect((await partner.json("/api/me")).body).toMatchObject({ membership: { role: "member" } });
  });

  it("is blocked while the person is the only admin of any library", async () => {
    const admin = await person(ctx, { role: "admin", libraryId: "lib-2" });
    await joinAlso(admin, "lib-1", "member");
    admin.library = "lib-1";
    const res = await admin.json("/api/account/delete/start", { body: {} });
    expect(res.body).toMatchObject({ lastAdmin: true });
  });
});
