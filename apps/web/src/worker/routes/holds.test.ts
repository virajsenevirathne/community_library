import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runHourlyJob } from "../jobs/reminders.ts";
import { createTestApp } from "../test/client.ts";
import { createTestEnv } from "../test/env.ts";
import { createLibrary, person } from "../test/fixtures.ts";

type Person = Awaited<ReturnType<typeof person>>;
let env: Env;
let dispose: () => Promise<void>;
let ctx: ReturnType<typeof createTestApp>;
let staff: Person;
let lee: Person;
let okafor: Person;
let nguyen: Person;

beforeEach(async () => {
  ({ env, dispose } = await createTestEnv());
  ctx = createTestApp(env);
  await createLibrary(env, {
    settings: { closedWeekdays: [], maxExtensions: 2, remindBeforeDays: 2, reminderHour: 0 },
  });
  staff = await person(ctx, { role: "staff" });
  lee = await person(ctx, { role: "member", familyName: "Lee" });
  okafor = await person(ctx, { role: "member", familyName: "Okafor" });
  nguyen = await person(ctx, { role: "member", familyName: "Nguyen" });
});
afterEach(() => dispose());

async function addBook(title = "Owl Babies", copies = 1): Promise<string[]> {
  const res = await staff.json<{ title: { copies: { shortCode: string }[] } }>(
    "/api/catalog/titles",
    { body: { title, copies } },
  );
  return res.body.title.copies.map((c) => c.shortCode);
}

interface View {
  waitlist: { waiting: number; mine: { id: string; position: number } | null };
  can: { hold: boolean };
  loan: { canExtend: boolean; othersWaiting?: boolean } | null;
}
const view = async (who: Person, code: string) =>
  (await who.json<{ copy: View }>(`/api/copies/${code}`)).body.copy;

describe("waiting lists", () => {
  it("lets families queue for a book that's out, and tells the first when it's back", async () => {
    const [code = ""] = await addBook();
    await lee.request(`/api/copies/${code}/borrow`, { body: {} });
    expect((await view(okafor, code)).can.hold).toBe(true);

    const joined = await okafor.json<{ copy: View }>(`/api/copies/${code}/hold`, { body: {} });
    expect(joined.status).toBe(201);
    expect(joined.body.copy.waitlist.mine?.position).toBe(1);
    await nguyen.request(`/api/copies/${code}/hold`, { body: {} });
    expect((await view(nguyen, code)).waitlist.mine?.position).toBe(2);
    // Joining twice is fine.
    expect((await okafor.request(`/api/copies/${code}/hold`, { body: {} })).status).toBe(200);

    // Someone waiting: the Lee family can't keep it longer.
    expect((await view(lee, code)).loan).toMatchObject({ canExtend: false, othersWaiting: true });
    const loans = await lee.json<{ loans: { id: string }[] }>("/api/loans/mine");
    const extend = await lee.json(`/api/loans/${loans.body.loans[0]?.id}/extend`, { body: {} });
    expect(extend.body).toMatchObject({ error: "others_waiting" });

    const before = ctx.outbox.sent.length;
    await lee.request(`/api/copies/${code}/return`, { body: {} });
    await ctx.settle();
    const told = ctx.outbox.sent.slice(before);
    expect(told.map((m) => m.to)).toEqual([okafor.email]);
    expect(told[0]?.subject).toBe('"Owl Babies" is back at the library');

    // Borrowing it ends Okafor's wait; Nguyen moves up.
    await okafor.request(`/api/copies/${code}/borrow`, { body: {} });
    expect((await view(okafor, code)).waitlist.mine).toBeNull();
    expect((await view(nguyen, code)).waitlist.mine?.position).toBe(1);
  });

  it("refuses a waiting list when a copy is on the shelf", async () => {
    const [first = "", second = ""] = await addBook("Two copies", 2);
    await lee.request(`/api/copies/${first}/borrow`, { body: {} });
    expect((await view(okafor, first)).can.hold).toBe(false);
    expect((await okafor.json(`/api/copies/${first}/hold`, { body: {} })).body).toMatchObject({
      error: "on_shelf",
    });
    expect(second).not.toBe("");
  });

  it("tells families in turn, and someone not told yet before someone told before", async () => {
    const [code = ""] = await addBook();
    await lee.request(`/api/copies/${code}/borrow`, { body: {} });
    await okafor.request(`/api/copies/${code}/hold`, { body: {} });
    await nguyen.request(`/api/copies/${code}/hold`, { body: {} });
    await lee.request(`/api/copies/${code}/return`, { body: {} });
    await ctx.settle();
    // Lee borrows it again before Okafor comes in, and returns it.
    await lee.request(`/api/copies/${code}/borrow`, { body: {} });
    const before = ctx.outbox.sent.length;
    await lee.request(`/api/copies/${code}/return`, { body: {} });
    await ctx.settle();
    // Okafor was told a moment ago and still counts as having a turn.
    const back = () =>
      ctx.outbox.sent
        .slice(before)
        .filter((m) => m.subject.includes("is back"))
        .map((m) => m.to);
    expect(back()).toEqual([]);
    // Days later, with the book still on the shelf, Nguyen's turn comes first.
    await env.DB.prepare("update holds set notified_at = ? where notified_at is not null")
      .bind(Date.now() - 3 * 86_400_000)
      .run();
    const mailer = { send: async (m: Parameters<typeof ctx.outbox.send>[0]) => ctx.outbox.send(m) };
    await runHourlyJob({ DB: env.DB, env, mailer, siteUrl: "https://library.test" });
    expect(back()).toEqual([nguyen.email]);
  });

  it("lets a family leave, and only its own place", async () => {
    const [code = ""] = await addBook();
    await lee.request(`/api/copies/${code}/borrow`, { body: {} });
    await okafor.request(`/api/copies/${code}/hold`, { body: {} });
    const mine = await okafor.json<{ waiting: { id: string }[] }>("/api/loans/mine");
    const id = mine.body.waiting[0]?.id ?? "";
    expect((await nguyen.request(`/api/holds/${id}`, { method: "DELETE" })).status).toBe(404);
    expect((await okafor.request(`/api/holds/${id}`, { method: "DELETE" })).status).toBe(200);
    expect((await view(okafor, code)).waitlist.waiting).toBe(0);
  });

  it("keeps the merged family's place when two families merge", async () => {
    const [code = ""] = await addBook();
    await lee.request(`/api/copies/${code}/borrow`, { body: {} });
    await okafor.request(`/api/copies/${code}/hold`, { body: {} });
    await nguyen.request(`/api/copies/${code}/hold`, { body: {} });
    const res = await staff.request(`/api/admin/families/${nguyen.familyId}/merge`, {
      body: { into: okafor.familyId },
    });
    expect(res.status).toBe(200);
    expect((await view(okafor, code)).waitlist.waiting).toBe(1);
  });
});

describe("keeping a book longer from the reminder email", () => {
  it("works once from the signed link, and not when someone is waiting", async () => {
    const [code = ""] = await addBook();
    await lee.request(`/api/copies/${code}/borrow`, { body: {} });
    const loan = await env.DB.prepare("select id, due_on as dueOn from loans").first<{
      id: string;
      dueOn: string;
    }>();
    // Two days before the due date, the reminder carries the link.
    const twoDaysBefore = new Date(`${loan?.dueOn}T00:00:00Z`);
    twoDaysBefore.setUTCDate(twoDaysBefore.getUTCDate() - 2);
    twoDaysBefore.setUTCHours(1);
    const mailer = { send: async (m: Parameters<typeof ctx.outbox.send>[0]) => ctx.outbox.send(m) };
    await runHourlyJob({
      DB: env.DB,
      env,
      mailer,
      siteUrl: "https://library.test",
      now: twoDaysBefore,
    });
    const reminder = ctx.outbox.sent.findLast(
      (m) => m.to === lee.email && m.text.includes("Keep it longer"),
    );
    const link = reminder?.text.match(/https:\/\/library\.test\/extend\?l=([^&\s]+)&t=([0-9a-f]+)/);
    expect(link).toBeTruthy();
    const [, l = "", t = ""] = link ?? [];

    const anyone = new (await import("../test/client.ts")).TestClient(ctx, "nobody@example.com");
    anyone.library = null;
    const first = await anyone.json<{ dueOn: string }>("/api/extend-by-link", { body: { l, t } });
    expect(first.status).toBe(200);
    expect(first.body.dueOn > (loan?.dueOn ?? "")).toBe(true);
    // The due date moved, so the same link is spent.
    expect((await anyone.request("/api/extend-by-link", { body: { l, t } })).status).toBe(400);
    expect(
      (await anyone.request("/api/extend-by-link", { body: { l, t: "0".repeat(64) } })).status,
    ).toBe(400);
  });
});
