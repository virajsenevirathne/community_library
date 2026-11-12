import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestApp, type TestClient } from "../test/client.ts";
import { createTestEnv } from "../test/env.ts";
import { createLibrary, person } from "../test/fixtures.ts";

type Person = Awaited<ReturnType<typeof person>>;

let env: Env;
let dispose: () => Promise<void>;
let ctx: ReturnType<typeof createTestApp>;
let admin: Person;
let parent: Person;

beforeEach(async () => {
  ({ env, dispose } = await createTestEnv());
  ctx = createTestApp(env);
  await createLibrary(env, { settings: { maxLoans: 2, closedWeekdays: [], loanDays: 14 } });
  admin = await person(ctx, { role: "admin" });
  parent = await person(ctx, { role: "member", familyName: "Lee" });
  await setName(parent, "Priya");
});
afterEach(() => dispose());

async function setName(who: Person, firstName: string) {
  const res = await who.request("/api/account/name", { method: "PUT", body: { firstName } });
  expect(res.status).toBe(200);
}

async function addBook(title = "Owl Babies"): Promise<string> {
  const res = await admin.json<{ title: { copies: { shortCode: string }[] } }>(
    "/api/catalog/titles",
    { body: { title, copies: 1 } },
  );
  return res.body.title.copies[0]?.shortCode ?? "";
}

/** A tablet: an admin turns it into a kiosk, then is signed out of it. */
async function kioskTablet(name = "Front desk"): Promise<TestClient> {
  const tablet = await person(ctx, { role: "admin" });
  const res = await tablet.json<{ kiosk: { id: string } }>("/api/admin/kiosks", {
    body: { name },
  });
  expect(res.status).toBe(201);
  await tablet.request("/api/auth/sign-out", { body: {} });
  return tablet;
}

async function myCode(who: Person): Promise<string> {
  const res = await who.json<{ code: string }>("/api/family/kiosk-code", { body: {} });
  expect(res.status).toBe(201);
  expect(res.body.code).toMatch(/^\d{6}$/);
  return res.body.code;
}

const borrow = (tablet: TestClient, book: string, code: string) =>
  tablet.json<{ borrowed?: { name: string; family: string; dueOn: string }; error?: string }>(
    `/api/kiosk/copies/${book}/borrow`,
    { body: { code } },
  );

/** A 6-digit code that is not `code`. */
const wrong = (code: string) => (code === "000000" ? "000001" : "000000");

describe("kiosk tablets", () => {
  it("gets a pass that works after the admin signs out, but opens nothing else", async () => {
    const tablet = await kioskTablet();
    const me = await tablet.json<{ kiosk: { name: string }; library: { slug: string } }>(
      "/api/kiosk",
    );
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ kiosk: { name: "Front desk" }, library: { slug: "lib-1" } });
    // The pass is not a sign-in.
    expect((await tablet.request("/api/admin/families")).status).toBe(401);
    expect((await tablet.request("/api/loans/mine")).status).toBe(401);
  });

  it("refuses a tablet without a pass, and one whose kiosk was turned off", async () => {
    expect((await parent.json("/api/kiosk")).body).toMatchObject({ error: "not_a_kiosk" });
    const tablet = await kioskTablet();
    const list = await admin.json<{ kiosks: { id: string; on: boolean }[] }>("/api/admin/kiosks");
    const id = list.body.kiosks[0]?.id ?? "";
    expect((await admin.request(`/api/admin/kiosks/${id}/off`, { body: {} })).status).toBe(200);
    const res = await tablet.json("/api/kiosk");
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: "kiosk_off" });
  });

  it("shows a book without saying which family has it", async () => {
    const tablet = await kioskTablet();
    const book = await addBook();
    await parent.request(`/api/copies/${book}/borrow`, { body: {} });
    const res = await tablet.json<{ copy: Record<string, unknown> }>(`/api/kiosk/copies/${book}`);
    expect(res.body.copy).toEqual({
      code: book,
      title: { title: "Owl Babies", authors: "", coverUrl: null },
      state: "out",
    });
  });

  it("stays in its own library, whatever page it's on", async () => {
    const tablet = await kioskTablet();
    await createLibrary(env, { id: "lib-2" });
    await env.DB.batch([
      env.DB.prepare("insert into titles (id, library_id, title) values ('t2', 'lib-2', 'Secret')"),
      env.DB.prepare(
        "insert into copies (id, library_id, title_id, short_code) values ('c2', 'lib-2', 't2', 'WXYZ')",
      ),
    ]);
    tablet.library = "lib-2";
    expect((await tablet.json("/api/kiosk/copies/WXYZ")).status).toBe(404);
  });
});

describe("borrowing at the kiosk", () => {
  it("borrows with a personal code, emails the family and shows on Loans", async () => {
    const tablet = await kioskTablet();
    const book = await addBook();
    const code = await myCode(parent);
    const res = await borrow(tablet, book, code);
    expect(res.status).toBe(201);
    expect(res.body.borrowed).toMatchObject({ name: "Priya", family: "Lee" });
    const loan = await env.DB.prepare(
      "select family_id as familyId, borrowed_by as borrowedBy, kiosk_person_id as person, kiosk_device_id as device from loans",
    ).first<Record<string, string | null>>();
    expect(loan).toMatchObject({ familyId: parent.familyId, borrowedBy: parent.userId });
    expect(loan?.person).toBeTruthy();
    expect(loan?.device).toBeTruthy();
    await ctx.settle();
    const mail = ctx.outbox.sent.findLast((m) => m.to === parent.email);
    expect(mail?.subject).toMatch(/^Priya borrowed Owl Babies at the kiosk/);
    expect(mail?.text).toContain("If nobody in your family borrowed it");
    const loans = await admin.json<{ loans: { kioskName: string | null }[] }>("/api/admin/loans");
    expect(loans.body.loans[0]?.kioskName).toBe("Priya");
  });

  it("asks for a first name before making a code, and shows a code only once", async () => {
    const nameless = await person(ctx, { role: "member" });
    const res = await nameless.json("/api/family/kiosk-code", { body: {} });
    expect(res.status).toBe(422);
    await myCode(parent);
    const status = await parent.json<Record<string, unknown>>("/api/family/kiosk-code");
    expect(status.body).toMatchObject({ code: { setAt: expect.any(Number) } });
    expect(JSON.stringify(status.body)).not.toMatch(/\d{6}"/);
  });

  it("a new code replaces the old one, and a code turned off stops working", async () => {
    const tablet = await kioskTablet();
    const book = await addBook();
    const old = await myCode(parent);
    const fresh = await myCode(parent);
    if (old !== fresh) expect((await borrow(tablet, book, old)).status).toBe(400);
    await parent.request("/api/family/kiosk-code", { method: "DELETE" });
    expect((await borrow(tablet, book, fresh)).body).toMatchObject({ error: "wrong_code" });
  });

  it("locks the tablet for a minute after 5 wrong codes, even for the right one", async () => {
    const tablet = await kioskTablet();
    const book = await addBook();
    const code = await myCode(parent);
    for (let i = 0; i < 5; i++) {
      expect((await borrow(tablet, book, wrong(code))).status).toBe(400);
    }
    const res = await borrow(tablet, book, code);
    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({ error: "kiosk_locked", retryAfter: expect.any(Number) });
    // Another tablet isn't locked.
    const other = await kioskTablet("Back room");
    expect((await borrow(other, book, code)).status).toBe(201);
  });

  it("counts guesses sent at the same moment", async () => {
    const tablet = await kioskTablet();
    const book = await addBook();
    const code = await myCode(parent);
    const results = await Promise.all(
      Array.from({ length: 12 }, () => borrow(tablet, book, wrong(code))),
    );
    expect(results.filter((r) => r.status === 400).length).toBeLessThanOrEqual(5);
  });

  it("doesn't count a right code against the tablet", async () => {
    const tablet = await kioskTablet();
    const [one, two] = [await addBook("One"), await addBook("Two")];
    const code = await myCode(parent);
    for (let i = 0; i < 4; i++) await borrow(tablet, one, wrong(code));
    expect((await borrow(tablet, one, code)).status).toBe(201);
    // Still four wrong in this minute, so one more is allowed to be checked.
    expect((await borrow(tablet, two, code)).status).toBe(201);
  });

  it("keeps the family's limit, and refuses a family that isn't approved", async () => {
    const tablet = await kioskTablet();
    const code = await myCode(parent);
    for (const title of ["A", "B"]) {
      expect((await borrow(tablet, await addBook(title), code)).status).toBe(201);
    }
    expect((await borrow(tablet, await addBook("C"), code)).body).toMatchObject({
      error: "limit_reached",
    });
    const waiting = await person(ctx, { role: "member", familyStatus: "pending" });
    await setName(waiting, "Sam");
    const waitingCode = await myCode(waiting);
    expect((await borrow(tablet, await addBook("D"), waitingCode)).body).toMatchObject({
      error: "family_pending",
    });
  });

  it("refuses a book another family has", async () => {
    const tablet = await kioskTablet();
    const book = await addBook();
    const other = await person(ctx, { role: "member" });
    await other.request(`/api/copies/${book}/borrow`, { body: {} });
    expect((await borrow(tablet, book, await myCode(parent))).body).toMatchObject({
      error: "on_loan",
    });
  });

  it("borrows into the family an adult belongs to now", async () => {
    const tablet = await kioskTablet();
    const code = await myCode(parent);
    const okafor = await person(ctx, { role: "member", familyName: "Okafor" });
    // Two adults so the move is allowed.
    const partner = await person(ctx, { role: "member", familyId: parent.familyId });
    expect(partner.familyId).toBe(parent.familyId);
    await admin.request(`/api/admin/families/${parent.familyId}/adults/${parent.userId}/move`, {
      body: { to: okafor.familyId },
    });
    const res = await borrow(tablet, await addBook(), code);
    expect(res.body.borrowed?.family).toBe("Okafor");
  });
});

describe("adults without email", () => {
  it("staff add a family without email, which borrows by code and gets no emails", async () => {
    const tablet = await kioskTablet();
    const res = await admin.json<{ code: string; familyId: string }>(
      "/api/admin/families/kiosk-only",
      { body: { familyName: "Silva", firstName: "Nana" } },
    );
    expect(res.status).toBe(201);
    const before = ctx.outbox.sent.length;
    const out = await borrow(tablet, await addBook(), res.body.code);
    expect(out.status).toBe(201);
    expect(out.body.borrowed).toMatchObject({ name: "Nana", family: "Silva" });
    await ctx.settle();
    expect(ctx.outbox.sent.length).toBe(before);
    const families = await admin.json<{
      families: { name: string; kioskPeople: { name: string; userId: null; hasCode: boolean }[] }[];
      kioskInUse: boolean;
    }>("/api/admin/families");
    expect(families.body.kioskInUse).toBe(true);
    const loans = await admin.json<{ loans: { hasEmail: boolean; kioskName: string }[] }>(
      "/api/admin/loans",
    );
    expect(loans.body.loans[0]).toMatchObject({ hasEmail: false, kioskName: "Nana" });
    expect(families.body.families.find((f) => f.name === "Silva")?.kioskPeople).toEqual([
      expect.objectContaining({ name: "Nana", userId: null, hasCode: true }),
    ]);
  });

  it("staff add, renew, turn off and remove a person's code", async () => {
    const tablet = await kioskTablet();
    const added = await admin.json<{ code: string; id: string }>(
      `/api/admin/families/${parent.familyId}/kiosk-people`,
      { body: { firstName: "Grandad" } },
    );
    expect(added.status).toBe(201);
    const renewed = await admin.json<{ code: string }>(
      `/api/admin/kiosk-people/${added.body.id}/renew`,
      { body: {} },
    );
    const book = await addBook();
    if (renewed.body.code !== added.body.code) {
      expect((await borrow(tablet, book, added.body.code)).status).toBe(400);
    }
    await admin.request(`/api/admin/kiosk-people/${added.body.id}/off`, { body: {} });
    expect((await borrow(tablet, book, renewed.body.code)).status).toBe(400);
    expect(
      (await admin.request(`/api/admin/kiosk-people/${added.body.id}`, { method: "DELETE" }))
        .status,
    ).toBe(200);
  });

  it("staff can't reach another library's people or families", async () => {
    await createLibrary(env, { id: "lib-2" });
    const otherAdmin = await person(ctx, { role: "admin", libraryId: "lib-2" });
    const added = await admin.json<{ id: string }>(
      `/api/admin/families/${parent.familyId}/kiosk-people`,
      { body: { firstName: "Grandad" } },
    );
    expect(
      (await otherAdmin.request(`/api/admin/kiosk-people/${added.body.id}/renew`, { body: {} }))
        .status,
    ).toBe(404);
    expect(
      (
        await otherAdmin.request(`/api/admin/families/${parent.familyId}/kiosk-people`, {
          body: { firstName: "X" },
        })
      ).status,
    ).toBe(404);
  });

  it("a code from another library doesn't work here", async () => {
    const tablet = await kioskTablet();
    await createLibrary(env, { id: "lib-2" });
    const otherParent = await person(ctx, { role: "member", libraryId: "lib-2" });
    await setName(otherParent, "Ana");
    const code = await myCode(otherParent);
    expect((await borrow(tablet, await addBook(), code)).status).toBe(400);
  });

  it("go with their family when families merge, and when it's removed", async () => {
    const other = await person(ctx, { role: "member", familyName: "Lee" });
    const added = await admin.json<{ id: string }>(
      `/api/admin/families/${other.familyId}/kiosk-people`,
      { body: { firstName: "Nana" } },
    );
    await admin.request(`/api/admin/families/${other.familyId}/merge`, {
      body: { into: parent.familyId },
    });
    const row = await env.DB.prepare("select family_id as familyId from kiosk_people where id = ?")
      .bind(added.body.id)
      .first<{ familyId: string }>();
    expect(row?.familyId).toBe(parent.familyId);
    await admin.request(`/api/admin/families/${parent.familyId}/remove`, { body: {} });
    const left = await env.DB.prepare("select count(*) as n from kiosk_people").first<number>("n");
    expect(left).toBe(0);
  });
});

describe("returning at the kiosk", () => {
  it("returns without a code", async () => {
    const tablet = await kioskTablet();
    const book = await addBook();
    await parent.request(`/api/copies/${book}/borrow`, { body: {} });
    const res = await tablet.json(`/api/kiosk/copies/${book}/return`, { body: {} });
    expect(res.body).toMatchObject({ title: "Owl Babies", returned: true });
    const again = await tablet.json(`/api/kiosk/copies/${book}/return`, { body: {} });
    expect(again.body).toMatchObject({ alreadyReturned: true });
  });

  it("says to use the basket when staff check returns in", async () => {
    await env.DB.prepare(
      "update libraries set settings = json_set(settings, '$.returnsNeedCheckIn', json('true'))",
    ).run();
    const tablet = await kioskTablet();
    const book = await addBook();
    await parent.request(`/api/copies/${book}/borrow`, { body: {} });
    const res = await tablet.json(`/api/kiosk/copies/${book}/return`, { body: {} });
    expect(res.body).toMatchObject({ pendingCheckIn: true });
    const open = await env.DB.prepare(
      "select count(*) as n from loans where returned_at is null and return_requested_at is not null",
    ).first<number>("n");
    expect(open).toBe(1);
  });

  it("refuses while the library is paused", async () => {
    const tablet = await kioskTablet();
    const book = await addBook();
    await env.DB.prepare("update libraries set status = 'paused'").run();
    const res = await tablet.json(`/api/kiosk/copies/${book}/return`, { body: {} });
    expect(res.status).toBe(403);
  });
});
