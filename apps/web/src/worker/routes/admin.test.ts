import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nudgesOffUrl } from "../jobs/reminders.ts";
import { createTestApp, TestClient } from "../test/client.ts";
import { createTestEnv } from "../test/env.ts";
import { createLibrary, person } from "../test/fixtures.ts";

type Person = Awaited<ReturnType<typeof person>>;
let env: Env;
let dispose: () => Promise<void>;
let ctx: ReturnType<typeof createTestApp>;
let staff: Person;
let admin: Person;
let parent: Person;

beforeEach(async () => {
  ({ env, dispose } = await createTestEnv());
  ctx = createTestApp(env);
  await createLibrary(env, { settings: { closedWeekdays: [], staffFlagDays: 14 } });
  staff = await person(ctx, { role: "staff" });
  admin = await person(ctx, { role: "admin" });
  parent = await person(ctx, { role: "member", familyName: "Nguyen" });
});
afterEach(() => dispose());

async function lend(title: string, dueOn: string) {
  const res = await staff.json<{ title: { copies: { id: string; shortCode: string }[] } }>(
    "/api/catalog/titles",
    { body: { title } },
  );
  const copy = res.body.title.copies[0];
  const id = `loan-${copy?.shortCode}`;
  await env.DB.prepare(
    "insert into loans (id, library_id, copy_id, family_id, borrowed_by, borrowed_at, due_on) values (?, 'lib-1', ?, ?, ?, ?, ?)",
  )
    .bind(id, copy?.id, parent.familyId, parent.userId, Date.now(), dueOn)
    .run();
  return { id, code: copy?.shortCode ?? "" };
}

const daysFromToday = (n: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

describe("dashboard", () => {
  it("counts books out, overdue and needing follow-up", async () => {
    await lend("Due later", daysFromToday(10));
    await lend("Due soon", daysFromToday(3));
    await lend("Late", daysFromToday(-2));
    await lend("Very late", daysFromToday(-20));
    const res = await staff.json<Record<string, unknown>>("/api/admin/dashboard");
    expect(res.body).toMatchObject({ booksOut: 4, overdue: 2, needsStaff: 1, dueThisWeek: 1 });
    // The hourly job has never run while books are out: warn.
    expect(res.body.reminders).toMatchObject({ stale: true });
  });
});

describe("loans list and actions", () => {
  it("filters overdue loans, most overdue first, and shows the family to staff", async () => {
    await lend("A bit late", daysFromToday(-1));
    await lend("Very late", daysFromToday(-20));
    await lend("Fine", daysFromToday(5));
    const res = await staff.json<{ loans: { title: string; familyName: string }[] }>(
      "/api/admin/loans?filter=overdue",
    );
    expect(res.body.loans.map((l) => l.title)).toEqual(["Very late", "A bit late"]);
    expect(res.body.loans[0]?.familyName).toBe("Nguyen");
  });

  it("marks a loan lost, which closes it and marks the copy lost", async () => {
    const loan = await lend("Gone", daysFromToday(-30));
    const res = await staff.json(`/api/admin/loans/${loan.id}/close`, {
      body: { outcome: "lost" },
    });
    expect(res.status).toBe(200);
    const copy = await env.DB.prepare("select status from copies where short_code = ?")
      .bind(loan.code)
      .first("status");
    expect(copy).toBe("lost");
    expect(
      (await staff.json(`/api/admin/loans/${loan.id}/close`, { body: { outcome: "lost" } })).status,
    ).toBe(404);
  });

  it("sends a reminder now, at most once a day", async () => {
    const loan = await lend("Late", daysFromToday(-3));
    const first = await staff.json(`/api/admin/loans/${loan.id}/remind`, { body: {} });
    expect(first.status).toBe(200);
    expect(ctx.outbox.last(parent.email)?.subject).toBe("Reminder: a library book to bring back");
    const again = await staff.json(`/api/admin/loans/${loan.id}/remind`, { body: {} });
    expect(again.body).toMatchObject({ error: "already_reminded" });
  });

  it("reminds several loans at once, one email per family", async () => {
    const other = await person(ctx, { role: "member", familyName: "Okafor" });
    const a = await lend("Late one", daysFromToday(-3));
    const b = await lend("Due soon", daysFromToday(2));
    const c = await lend("Theirs", daysFromToday(-1));
    await env.DB.prepare("update loans set family_id = ?, borrowed_by = ? where id = ?")
      .bind(other.familyId, other.userId, c.id)
      .run();
    const before = ctx.outbox.sent.length;
    const res = await staff.json("/api/admin/loans/remind", {
      body: { loanIds: [a.id, b.id, c.id, a.id, "missing"] },
    });
    expect(res.body).toMatchObject({
      reminded: 2,
      books: 3,
      alreadyReminded: 0,
      skipped: 1,
      deferred: 0,
      failed: 0,
      notYet: 0,
    });
    expect(ctx.outbox.sent.length - before).toBe(2);
    const mine = ctx.outbox.last(parent.email);
    expect(mine?.text).toContain("Late one");
    expect(mine?.text).toContain("Due soon");
    expect(mine?.text).not.toContain("Theirs");
    expect(ctx.outbox.last(other.email)?.text).toContain("Theirs");
  });

  it("skips books already reminded about today, alone or in bulk", async () => {
    const a = await lend("First", daysFromToday(-3));
    const b = await lend("Second", daysFromToday(-3));
    await staff.json(`/api/admin/loans/${a.id}/remind`, { body: {} });
    const res = await staff.json("/api/admin/loans/remind", { body: { loanIds: [a.id, b.id] } });
    expect(res.body).toMatchObject({ reminded: 1, books: 1, alreadyReminded: 1 });
    expect(ctx.outbox.last(parent.email)?.text).not.toContain("First");
    const again = await staff.json(`/api/admin/loans/${b.id}/remind`, { body: {} });
    expect(again.body).toMatchObject({ error: "already_reminded" });
  });

  it("asks for between 1 and 100 loans", async () => {
    const none = await staff.json("/api/admin/loans/remind", { body: { loanIds: [] } });
    expect(none.status).toBe(422);
    const tooMany = Array.from({ length: 101 }, (_, i) => `loan-${i}`);
    const many = await staff.json("/api/admin/loans/remind", { body: { loanIds: tooMany } });
    expect(many.status).toBe(422);
  });

  it("never reminds about another library's loans", async () => {
    await createLibrary(env, { id: "lib-2" });
    await env.DB.batch([
      env.DB.prepare(
        "insert into families (id, library_id, name) values ('family-z', 'lib-2', 'Z')",
      ),
      env.DB.prepare(
        "insert into titles (id, library_id, title) values ('t-z', 'lib-2', 'Theirs')",
      ),
      env.DB.prepare(
        "insert into copies (id, library_id, title_id, short_code) values ('c-z', 'lib-2', 't-z', 'ZZZZ')",
      ),
      env.DB.prepare(
        "insert into loans (id, library_id, copy_id, family_id, borrowed_at, due_on) values ('loan-z', 'lib-2', 'c-z', 'family-z', 0, '2026-01-01')",
      ),
    ]);
    const before = ctx.outbox.sent.length;
    const res = await staff.json("/api/admin/loans/remind", { body: { loanIds: ["loan-z"] } });
    expect(res.body).toMatchObject({ reminded: 0, skipped: 1 });
    expect(ctx.outbox.sent.length).toBe(before);
    const single = await staff.json("/api/admin/loans/loan-z/remind", { body: {} });
    expect(single.status).toBe(404);
    const claims = await env.DB.prepare("select count(*) as n from notifications").first("n");
    expect(claims).toBe(0);
  });

  it("releases the claim when sending fails, so it can be tried again", async () => {
    const loan = await lend("Retry me", daysFromToday(-2));
    const send = ctx.outbox.send.bind(ctx.outbox);
    ctx.outbox.send = async () => ({
      ok: false,
      provider: "memory",
      retryable: true,
      error: "down",
    });
    const failed = await staff.json("/api/admin/loans/remind", { body: { loanIds: [loan.id] } });
    expect(failed.body).toMatchObject({ reminded: 0, failed: 1 });
    ctx.outbox.send = send;
    const retry = await staff.json("/api/admin/loans/remind", { body: { loanIds: [loan.id] } });
    expect(retry.body).toMatchObject({ reminded: 1, sentLoanIds: [loan.id] });
  });

  it("waits for tomorrow when the day's emails run out, keeping nothing claimed", async () => {
    const loan = await lend("Quota", daysFromToday(-2));
    const send = ctx.outbox.send.bind(ctx.outbox);
    ctx.outbox.send = async () => ({
      ok: false,
      provider: "quota",
      retryable: true,
      error: "deferred_quota",
    });
    const res = await staff.json("/api/admin/loans/remind", { body: { loanIds: [loan.id] } });
    expect(res.body).toMatchObject({ reminded: 0, deferred: 1 });
    const pending = await env.DB.prepare(
      "select count(*) as n from notifications where kind = 'manual_reminder'",
    ).first("n");
    expect(pending).toBe(0);
    ctx.outbox.send = send;
  });

  it("takes over a reminder claim left pending by a request that died", async () => {
    const loan = await lend("Stuck", daysFromToday(-2));
    // A claim from 20 minutes ago that was never settled.
    const res0 = await staff.json("/api/admin/loans/remind", { body: { loanIds: [loan.id] } });
    expect(res0.body).toMatchObject({ reminded: 1 });
    await env.DB.prepare(
      "update notifications set status = 'pending', created_at = ? where kind = 'manual_reminder'",
    )
      .bind(Date.now() - 20 * 60 * 1000)
      .run();
    const res = await staff.json("/api/admin/loans/remind", { body: { loanIds: [loan.id] } });
    expect(res.body).toMatchObject({ reminded: 1, alreadyReminded: 0 });
  });

  it("says when a family has no one to email", async () => {
    const loan = await lend("Orphan", daysFromToday(-2));
    await env.DB.prepare("update memberships set family_id = null where family_id = ?")
      .bind(parent.familyId)
      .run();
    const res = await staff.json("/api/admin/loans/remind", { body: { loanIds: [loan.id] } });
    expect(res.body).toMatchObject({ reminded: 0, noEmail: 1, failed: 0 });
  });
});

describe("settings", () => {
  it("lets the admin change settings with plain-English errors", async () => {
    const ok = await admin.json<{ settings: { loanDays: number } }>("/api/admin/settings", {
      method: "PATCH",
      body: { loanDays: 21, libraryName: "Little Owls" },
    });
    expect(ok.body.settings.loanDays).toBe(21);
    const bad = await admin.json("/api/admin/settings", { method: "PATCH", body: { maxLoans: 0 } });
    expect(bad.status).toBe(422);
    expect(bad.body).toMatchObject({
      message: "Books per family: enter a whole number from 1 to 50.",
    });
  });
});

describe("turning reminders off from an email", () => {
  it("works with the signed link, and not with a made-up one", async () => {
    const url = new URL(await nudgesOffUrl(env, "https://x.org", parent.familyId ?? ""));
    const anyone = new TestClient(ctx, "nobody@example.com");
    const forged = await anyone.json("/api/reminders-off", {
      body: { f: parent.familyId, t: "0".repeat(64) },
    });
    expect(forged.status).toBe(400);
    const real = await anyone.json("/api/reminders-off", {
      body: { f: url.searchParams.get("f"), t: url.searchParams.get("t") },
    });
    expect(real.status).toBe(200);
    const off = await env.DB.prepare("select nudges_off from families where id = ?")
      .bind(parent.familyId)
      .first("nudges_off");
    expect(off).toBe(1);
  });
});

describe("reminder settings for a family", () => {
  it("lets a parent turn reminders back on", async () => {
    await parent.json("/api/family/reminders", { method: "PUT", body: { on: false } });
    expect((await parent.json<{ on: boolean }>("/api/family/reminders")).body.on).toBe(false);
    await parent.json("/api/family/reminders", { method: "PUT", body: { on: true } });
    expect((await parent.json<{ on: boolean }>("/api/family/reminders")).body.on).toBe(true);
  });

  it("does not let wrong links block a family's real link", async () => {
    const anyone = new TestClient(ctx, "nobody@example.com");
    for (let i = 0; i < 25; i++) {
      await anyone.json("/api/reminders-off", { body: { f: parent.familyId, t: "0".repeat(64) } });
    }
    const url = new URL(await nudgesOffUrl(env, "https://x.org", parent.familyId ?? ""));
    const realParent = new TestClient(ctx, parent.email);
    const res = await realParent.json("/api/reminders-off", {
      body: { f: url.searchParams.get("f"), t: url.searchParams.get("t") },
    });
    expect(res.status).toBe(200);
  });

  it("does not let staff change settings", async () => {
    expect(
      (await staff.json("/api/admin/settings", { method: "PATCH", body: { loanDays: 3 } })).status,
    ).toBe(403);
  });
});
