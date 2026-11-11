import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestApp } from "../test/client.ts";
import { createTestEnv } from "../test/env.ts";
import { createLibrary, person } from "../test/fixtures.ts";

type Person = Awaited<ReturnType<typeof person>>;
interface CopyView {
  code: string;
  state: "available" | "mine" | "out" | "unavailable";
  loan: { id: string; dueOn: string; canExtend: boolean; familyName?: string } | null;
  reportedFound: boolean;
  can: { borrow: boolean; return: boolean; reportFound: boolean };
}

let env: Env;
let dispose: () => Promise<void>;
let ctx: ReturnType<typeof createTestApp>;
let staff: Person;
let parent: Person;
let otherParent: Person;

beforeEach(async () => {
  ({ env, dispose } = await createTestEnv());
  ctx = createTestApp(env);
  await createLibrary(env, {
    settings: { maxLoans: 2, maxExtensions: 1, closedWeekdays: [], loanDays: 14 },
  });
  staff = await person(ctx, { role: "staff" });
  parent = await person(ctx, { role: "member", familyName: "Nguyen" });
  otherParent = await person(ctx, { role: "member", familyName: "Okafor" });
});
afterEach(() => dispose());

/** Adds a book with `copies` copies and returns their codes. */
async function addBook(title = "Owl Babies", copies = 1): Promise<string[]> {
  const res = await staff.json<{ title: { copies: { shortCode: string }[] } }>(
    "/api/catalog/titles",
    {
      body: { title, copies },
    },
  );
  return res.body.title.copies.map((c) => c.shortCode);
}

const view = async (who: Person, code: string) =>
  (await who.json<{ copy: CopyView }>(`/api/copies/${code}`)).body.copy;

describe("a book's page", () => {
  it("offers Borrow for an available copy, and accepts a typed code in lowercase", async () => {
    const [code] = await addBook();
    const copy = await view(parent, (code ?? "").toLowerCase());
    expect(copy).toMatchObject({
      state: "available",
      can: { borrow: true, return: false, reportFound: false },
    });
  });

  it("says when a code does not exist", async () => {
    const res = await parent.json("/api/copies/ZZZZ");
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: "copy_not_found" });
  });

  it("never shows another library's copy", async () => {
    await createLibrary(env, { id: "lib-2" });
    await env.DB.batch([
      env.DB.prepare("insert into titles (id, library_id, title) values ('t2', 'lib-2', 'Secret')"),
      env.DB.prepare(
        "insert into copies (id, library_id, title_id, short_code) values ('c2', 'lib-2', 't2', 'WXYZ')",
      ),
    ]);
    expect((await parent.json("/api/copies/WXYZ")).status).toBe(404);
  });
});

describe("borrowing", () => {
  it("creates a loan due in 14 days and emails every parent in the family", async () => {
    const [code = ""] = await addBook();
    const secondParent = await person(ctx, { role: "member", familyId: parent.familyId });
    const res = await parent.json<{ copy: CopyView; dueOn: string }>(`/api/copies/${code}/borrow`, {
      body: {},
    });
    expect(res.status).toBe(201);
    expect(res.body.copy.state).toBe("mine");
    expect(res.body.dueOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    await ctx.settle();
    const subjects = ctx.outbox.sent.filter((m) => m.subject.startsWith("You borrowed"));
    expect(subjects.map((m) => m.to).sort()).toEqual([parent.email, secondParent.email].sort());
    // The other parent sees it as their family's book too.
    expect((await view(secondParent, code)).state).toBe("mine");
  });

  it("answers a second tap on Borrow as a success, without a second loan", async () => {
    const [code = ""] = await addBook();
    await parent.json(`/api/copies/${code}/borrow`, { body: {} });
    const again = await parent.json<{ alreadyYours: boolean }>(`/api/copies/${code}/borrow`, {
      body: {},
    });
    expect(again.status).toBe(200);
    expect(again.body.alreadyYours).toBe(true);
    expect(await env.DB.prepare("select count(*) as n from loans").first("n")).toBe(1);
  });

  it("hides who has a book from other parents, and offers Found it instead", async () => {
    const [code = ""] = await addBook();
    await parent.json(`/api/copies/${code}/borrow`, { body: {} });
    const seen = await view(otherParent, code);
    expect(seen).toMatchObject({
      state: "out",
      loan: null,
      can: { borrow: false, return: false, reportFound: true },
    });
    const res = await otherParent.json(`/api/copies/${code}/borrow`, { body: {} });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: "on_loan" });
  });

  it("stops a family at its limit", async () => {
    const codes = await addBook("Owl Babies", 3);
    await parent.json(`/api/copies/${codes[0]}/borrow`, { body: {} });
    await parent.json(`/api/copies/${codes[1]}/borrow`, { body: {} });
    const third = await parent.json(`/api/copies/${codes[2]}/borrow`, { body: {} });
    expect(third.status).toBe(409);
    expect(third.body).toMatchObject({ error: "limit_reached" });
    expect((await view(parent, codes[2] ?? "")).can.borrow).toBe(false);
    // No audit event for the refused borrow.
    expect(
      await env.DB.prepare("select count(*) as n from events where type = 'loan_created'").first(
        "n",
      ),
    ).toBe(2);
  });

  it("cannot pass the limit when two parents borrow at the same moment", async () => {
    const codes = await addBook("Owl Babies", 3);
    const secondParent = await person(ctx, { role: "member", familyId: parent.familyId });
    await parent.json(`/api/copies/${codes[0]}/borrow`, { body: {} });
    const results = await Promise.all([
      parent.json(`/api/copies/${codes[1]}/borrow`, { body: {} }),
      secondParent.json(`/api/copies/${codes[2]}/borrow`, { body: {} }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(
      await env.DB.prepare("select count(*) as n from loans where returned_at is null").first("n"),
    ).toBe(2);
  });

  it("gives one copy to only one family when two scan at once", async () => {
    const [code = ""] = await addBook();
    const results = await Promise.all([
      parent.json(`/api/copies/${code}/borrow`, { body: {} }),
      otherParent.json(`/api/copies/${code}/borrow`, { body: {} }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
  });

  it("refuses families waiting for approval, and lost copies", async () => {
    const [code = ""] = await addBook();
    const pending = await person(ctx, { role: "member", familyStatus: "pending" });
    expect((await pending.json(`/api/copies/${code}/borrow`, { body: {} })).body).toMatchObject({
      error: "family_pending",
    });
    const [lostCode = ""] = await addBook("Lost book");
    await env.DB.prepare("update copies set status = 'lost' where short_code = ?")
      .bind(lostCode)
      .run();
    expect((await parent.json(`/api/copies/${lostCode}/borrow`, { body: {} })).body).toMatchObject({
      error: "unavailable",
    });
  });
});

describe("returning", () => {
  it("lets the family return their book, and answers a repeat as a success", async () => {
    const [code = ""] = await addBook();
    await parent.json(`/api/copies/${code}/borrow`, { body: {} });
    const res = await parent.json<{ copy: CopyView }>(`/api/copies/${code}/return`, { body: {} });
    expect(res.status).toBe(200);
    expect(res.body.copy.state).toBe("available");
    const again = await parent.json<{ alreadyReturned: boolean }>(`/api/copies/${code}/return`, {
      body: {},
    });
    expect(again.body.alreadyReturned).toBe(true);
  });

  it("does not let another family return it", async () => {
    const [code = ""] = await addBook();
    await parent.json(`/api/copies/${code}/borrow`, { body: {} });
    const res = await otherParent.json(`/api/copies/${code}/return`, { body: {} });
    expect(res.status).toBe(403);
    expect((await view(parent, code)).state).toBe("mine");
  });

  it("lets staff check books in from the basket, seeing whose they were", async () => {
    const [code = ""] = await addBook();
    await parent.json(`/api/copies/${code}/borrow`, { body: {} });
    const res = await staff.json<{ returned: { familyName: string; wasFound: boolean } }>(
      `/api/copies/${code}/return`,
      { body: {} },
    );
    expect(res.body.returned).toMatchObject({ familyName: "Nguyen", wasFound: false });
  });
});

describe("Found it", () => {
  it("flags the copy, tells the borrowing family, and leaves the loan open", async () => {
    const [code = ""] = await addBook();
    await parent.json(`/api/copies/${code}/borrow`, { body: {} });
    const res = await otherParent.json<{ copy: CopyView }>(`/api/copies/${code}/found`, {
      body: {},
    });
    expect(res.body.copy).toMatchObject({ reportedFound: true, can: { reportFound: false } });
    await ctx.settle();
    expect(ctx.outbox.last(parent.email)?.subject).toContain("Someone found");
    expect(
      await env.DB.prepare("select count(*) as n from loans where returned_at is null").first("n"),
    ).toBe(1);
    // Staff check it in; the flag clears.
    const back = await staff.json<{ returned: { wasFound: boolean }; copy: CopyView }>(
      `/api/copies/${code}/return`,
      {
        body: {},
      },
    );
    expect(back.body.returned.wasFound).toBe(true);
    expect(back.body.copy.reportedFound).toBe(false);
  });

  it("tells the borrower to tap Return instead", async () => {
    const [code = ""] = await addBook();
    await parent.json(`/api/copies/${code}/borrow`, { body: {} });
    expect((await parent.json(`/api/copies/${code}/found`, { body: {} })).body).toMatchObject({
      error: "yours",
    });
  });
});

describe("my books and extending", () => {
  it("lists only my family's books, and extends once", async () => {
    const [mine = "", theirs = ""] = await addBook("Owl Babies", 2);
    await parent.json(`/api/copies/${mine}/borrow`, { body: {} });
    await otherParent.json(`/api/copies/${theirs}/borrow`, { body: {} });
    const list = await parent.json<{
      loans: { id: string; code: string; dueOn: string; canExtend: boolean }[];
    }>("/api/loans/mine");
    expect(list.body.loans.map((l) => l.code)).toEqual([mine]);
    const loan = list.body.loans[0];
    const extended = await parent.json<{ dueOn: string }>(`/api/loans/${loan?.id}/extend`, {
      body: {},
    });
    expect(extended.status).toBe(200);
    expect(extended.body.dueOn > (loan?.dueOn ?? "")).toBe(true);
    const twice = await parent.json(`/api/loans/${loan?.id}/extend`, { body: {} });
    expect(twice.body).toMatchObject({ error: "no_more_extensions" });
    // Another family cannot extend it.
    expect((await otherParent.json(`/api/loans/${loan?.id}/extend`, { body: {} })).status).toBe(
      404,
    );
  });
});

describe("races and repeats", () => {
  const count = (query: string) => env.DB.prepare(query).first("n");

  it("sends one Found email and one event when two people report at once", async () => {
    const [code = ""] = await addBook();
    await parent.json(`/api/copies/${code}/borrow`, { body: {} });
    const third = await person(ctx, { role: "member" });
    await ctx.settle();
    const before = ctx.outbox.sent.length;
    await Promise.all([
      otherParent.json(`/api/copies/${code}/found`, { body: {} }),
      third.json(`/api/copies/${code}/found`, { body: {} }),
    ]);
    await ctx.settle();
    expect(
      ctx.outbox.sent.slice(before).filter((m) => m.subject.startsWith("Someone found")),
    ).toHaveLength(1);
    expect(await count("select count(*) as n from events where type = 'copy_found'")).toBe(1);
  });

  it("writes one return event when a parent and staff return at once", async () => {
    const [code = ""] = await addBook();
    await parent.json(`/api/copies/${code}/borrow`, { body: {} });
    const results = await Promise.all([
      parent.json<{ alreadyReturned?: boolean }>(`/api/copies/${code}/return`, { body: {} }),
      staff.json<{ alreadyReturned?: boolean }>(`/api/copies/${code}/return`, { body: {} }),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(await count("select count(*) as n from events where type = 'loan_returned'")).toBe(1);
  });

  it("does not carry a found flag over to the next loan", async () => {
    const [code = ""] = await addBook();
    await parent.json(`/api/copies/${code}/borrow`, { body: {} });
    await otherParent.json(`/api/copies/${code}/found`, { body: {} });
    // The flag is set; simulate it surviving (as if set during a race), then a new loan starts.
    await parent.json(`/api/copies/${code}/return`, { body: {} });
    await env.DB.prepare("update copies set found_at = 1 where short_code = ?").bind(code).run();
    await otherParent.json(`/api/copies/${code}/borrow`, { body: {} });
    expect((await view(otherParent, code)).reportedFound).toBe(false);
  });

  it("limits how many books one person can report found", async () => {
    const codes = await addBook("Owl Babies", 12);
    const borrowers = [];
    for (let i = 0; i < 6; i++) borrowers.push(await person(ctx, { role: "member" }));
    for (const [i, code] of codes.entries()) {
      await (borrowers[i % 6] as Person).json(`/api/copies/${code}/borrow`, { body: {} });
    }
    const statuses = [];
    for (const code of codes)
      statuses.push((await otherParent.json(`/api/copies/${code}/found`, { body: {} })).status);
    expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
  });

  it("emails the other parents even when one address fails", async () => {
    const [code = ""] = await addBook();
    const secondParent = await person(ctx, { role: "member", familyId: parent.familyId });
    const original = ctx.outbox.send.bind(ctx.outbox);
    ctx.outbox.send = async (message) => {
      if (message.to === parent.email) throw new Error("provider down");
      return original(message);
    };
    await parent.json(`/api/copies/${code}/borrow`, { body: {} });
    await ctx.settle();
    expect(ctx.outbox.last(secondParent.email)?.subject).toContain("You borrowed");
  });

  it("escapes book titles in the HTML email", async () => {
    const [code = ""] = await addBook("<script>alert(1)</script> & friends");
    await parent.json(`/api/copies/${code}/borrow`, { body: {} });
    await ctx.settle();
    const html = ctx.outbox.last(parent.email)?.html ?? "";
    expect(html).not.toContain("<script>");
    expect(html).toContain("&#60;script&#62;");
  });
});
