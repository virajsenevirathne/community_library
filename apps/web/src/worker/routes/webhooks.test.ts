import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hmacHex } from "../crypto.ts";
import { runHourlyJob } from "../jobs/reminders.ts";
import { createTestApp } from "../test/client.ts";
import { createTestEnv } from "../test/env.ts";
import { createLibrary, person } from "../test/fixtures.ts";
import { isWebhookUrl } from "../webhooks.ts";

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
});
afterEach(() => dispose());

async function setUp(
  url = "https://hooks.school.org/library",
  events = ["loan.created", "loan.returned", "loan.overdue", "account.deleted"],
) {
  const res = await admin.request("/api/admin/webhook", { method: "PUT", body: { url, events } });
  expect(res.status).toBe(200);
  return (await admin.json<{ webhook: { secret: string } }>("/api/admin/webhook")).body.webhook
    .secret;
}

async function borrowOne() {
  const res = await admin.json<{ title: { copies: { shortCode: string }[] } }>(
    "/api/catalog/titles",
    {
      body: { title: "Owl Babies", copies: 1 },
    },
  );
  const code = res.body.title.copies[0]?.shortCode ?? "";
  await parent.request(`/api/copies/${code}/borrow`, { body: {} });
  await ctx.settle();
  return code;
}

describe("webhooks", () => {
  it("only sends to https addresses on the internet", () => {
    expect(isWebhookUrl("https://hooks.school.org/x")).toBe(true);
    for (const bad of [
      "http://hooks.school.org/x",
      "https://127.0.0.1/x",
      "https://[::1]/x",
      "https://localhost/x",
      "https://printer.local/x",
      "https://user:pw@hooks.school.org/x",
      "https://hooks.school.org:8443/x",
      "https://intranet/x",
    ]) {
      expect(isWebhookUrl(bad), bad).toBe(false);
    }
  });

  it("tells the library's address about a borrow, signed, with no names or emails", async () => {
    const secret = await setUp();
    const code = await borrowOne();
    const hook = ctx.hooks.at(-1);
    expect(hook?.url).toBe("https://hooks.school.org/library");
    expect(hook?.headers.get("Reading-Joey-Event")).toBe("loan.created");
    const body = JSON.parse(hook?.body ?? "{}");
    expect(body).toMatchObject({
      type: "loan.created",
      library: "lib-1",
      data: { book: { title: "Owl Babies", code }, via: "phone" },
    });
    expect(hook?.body).not.toContain(parent.email);
    expect(hook?.body).not.toContain("Lee");
    // The signature checks out with the library's secret.
    const [, t = "", v1 = ""] =
      hook?.headers.get("Reading-Joey-Signature")?.match(/^t=(\d+),v1=([0-9a-f]+)$/) ?? [];
    expect(v1).toBe(await hmacHex(secret, `${t}.${hook?.body}`));
  });

  it("sends only the events chosen, and tells about returns", async () => {
    await setUp("https://hooks.school.org/x", ["loan.returned"]);
    const code = await borrowOne();
    expect(ctx.hooks).toHaveLength(0);
    await parent.request(`/api/copies/${code}/return`, { body: {} });
    await ctx.settle();
    expect(JSON.parse(ctx.hooks.at(-1)?.body ?? "{}")).toMatchObject({
      type: "loan.returned",
      data: { outcome: "returned", via: "phone" },
    });
  });

  it("retries a failed delivery with the hourly job, and lists deliveries", async () => {
    await setUp("https://down.school.org/x", ["loan.created"]);
    await borrowOne();
    let list = await admin.json<{
      recent: { status: string; attempts: number; lastStatus: number }[];
    }>("/api/admin/webhook");
    expect(list.body.recent[0]).toMatchObject({ status: "pending", attempts: 1, lastStatus: 500 });
    await env.DB.prepare("update webhook_deliveries set next_attempt_at = 0").run();
    await runHourlyJob({
      DB: env.DB,
      env,
      mailer: ctx.outbox,
      siteUrl: "https://l.test",
      fetch: ctx.hookFetch,
    });
    list = await admin.json("/api/admin/webhook");
    expect(list.body.recent[0]).toMatchObject({ status: "pending", attempts: 2 });
  });

  it("tells once when a loan goes overdue", async () => {
    await setUp("https://hooks.school.org/x", ["loan.overdue"]);
    await borrowOne();
    await env.DB.prepare("update loans set due_on = '2020-01-01'").run();
    const run = () =>
      runHourlyJob({
        DB: env.DB,
        env,
        mailer: ctx.outbox,
        siteUrl: "https://l.test",
        fetch: ctx.hookFetch,
      });
    await run();
    await run();
    expect(ctx.hooks.filter((h) => h.body.includes("loan.overdue"))).toHaveLength(1);
  });

  it("sends a test, replaces the secret, and can be removed", async () => {
    const first = await setUp();
    const test = await admin.json<{ ok: boolean; status: number }>("/api/admin/webhook/test", {
      body: {},
    });
    expect(test.body).toEqual({ ok: true, status: 204 });
    await admin.request("/api/admin/webhook/secret", { body: {} });
    const second = (await admin.json<{ webhook: { secret: string } }>("/api/admin/webhook")).body
      .webhook.secret;
    expect(second).not.toBe(first);
    expect(second).toMatch(/^whsec_/);
    await admin.request("/api/admin/webhook", { method: "DELETE" });
    expect((await admin.json<{ webhook: null }>("/api/admin/webhook")).body.webhook).toBeNull();
    await borrowOne();
    expect(ctx.hooks.filter((h) => h.body.includes("loan.created"))).toHaveLength(0);
  });

  it("refuses a local address", async () => {
    const res = await admin.json("/api/admin/webhook", {
      method: "PUT",
      body: { url: "https://10.0.0.5/hook", events: ["loan.created"] },
    });
    expect(res.status).toBe(422);
  });
});
