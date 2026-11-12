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
let parent: Person;

/** A real browser key: the server checks it's a P-256 point. */
async function browserKeys() {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const raw = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  const b64 = (bytes: Uint8Array) =>
    btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  return { p256dh: b64(raw), auth: b64(crypto.getRandomValues(new Uint8Array(16))) };
}
let KEYS: { p256dh: string; auth: string };
const ENDPOINT = "https://fcm.googleapis.com/fcm/send/phone-1";

beforeEach(async () => {
  ({ env, dispose } = await createTestEnv({
    VAPID_PUBLIC_KEY: "BPublicKeyForTests",
    VAPID_PRIVATE_KEY: "private",
  } as Partial<Env>));
  ctx = createTestApp(env);
  await createLibrary(env, {
    settings: { closedWeekdays: [], remindBeforeDays: 2, reminderHour: 0 },
  });
  staff = await person(ctx, { role: "staff" });
  parent = await person(ctx, { role: "member", familyName: "Lee" });
  KEYS = await browserKeys();
});
afterEach(() => dispose());

const subscribe = (who: Person, endpoint = ENDPOINT) =>
  who.request("/api/push/subscriptions", { body: { endpoint, keys: KEYS } });

describe("phone notifications", () => {
  it("tells signed-in people the site's push key", async () => {
    const me = await parent.json<{ pushKey: string; user: { notifyBy: string } }>("/api/me");
    expect(me.body.pushKey).toBe("BPublicKeyForTests");
    expect(me.body.user.notifyBy).toBe("email");
  });

  it("refuses a browser key that isn't a real key", async () => {
    const res = await parent.request("/api/push/subscriptions", {
      body: { endpoint: ENDPOINT, keys: { p256dh: `B${"A".repeat(86)}`, auth: KEYS.auth } },
    });
    expect(res.status).toBe(422);
  });

  it("pushes each reminder once, even when its email is retried", async () => {
    await subscribe(parent);
    const res = await staff.json<{ title: { copies: { shortCode: string }[] } }>(
      "/api/catalog/titles",
      { body: { title: "Owl Babies", copies: 1 } },
    );
    await parent.request(`/api/copies/${res.body.title.copies[0]?.shortCode}/borrow`, { body: {} });
    const loan = await env.DB.prepare("select due_on as dueOn from loans").first<{
      dueOn: string;
    }>();
    const at = new Date(`${loan?.dueOn}T01:00:00Z`);
    at.setUTCDate(at.getUTCDate() - 2);
    // Email keeps failing ("both" sends both), so the reminder is retried.
    const failing = {
      send: async () => ({ ok: false as const, provider: "x", retryable: true, error: "down" }),
    };
    for (const hour of [0, 1, 2]) {
      const now = new Date(at.getTime() + hour * 3_600_000);
      await runHourlyJob({
        DB: env.DB,
        env,
        mailer: failing,
        push: ctx.push,
        siteUrl: "https://l.test",
        now,
      });
    }
    expect(ctx.pushed).toHaveLength(1);
  });

  it("accepts only push service addresses", async () => {
    expect((await subscribe(parent, "https://evil.example/collect")).status).toBe(422);
    expect((await subscribe(parent, "https://169.254.169.254/latest")).status).toBe(422);
    expect((await subscribe(parent)).status).toBe(201);
    const me = await parent.json<{ user: { notifyBy: string; pushDevices: number } }>("/api/me");
    // Turning notifications on means both, until changed.
    expect(me.body.user).toMatchObject({ notifyBy: "both", pushDevices: 1 });
  });

  it("needs a device before choosing phone reminders, and falls back to email without one", async () => {
    const refused = await parent.json("/api/account/notify-by", {
      method: "PUT",
      body: { notifyBy: "push" },
    });
    expect(refused.body).toMatchObject({ error: "no_device" });
    await subscribe(parent);
    expect(
      (
        await parent.request("/api/account/notify-by", {
          method: "PUT",
          body: { notifyBy: "push" },
        })
      ).status,
    ).toBe(200);
    await parent.request("/api/push/subscriptions", {
      method: "DELETE",
      body: { endpoint: ENDPOINT },
    });
    const me = await parent.json<{ user: { notifyBy: string } }>("/api/me");
    expect(me.body.user.notifyBy).toBe("email");
  });

  it("sends due-soon reminders to the phone instead of email when chosen", async () => {
    await subscribe(parent);
    await parent.request("/api/account/notify-by", { method: "PUT", body: { notifyBy: "push" } });
    const res = await staff.json<{ title: { copies: { shortCode: string }[] } }>(
      "/api/catalog/titles",
      { body: { title: "Owl Babies", copies: 1 } },
    );
    await parent.request(`/api/copies/${res.body.title.copies[0]?.shortCode}/borrow`, { body: {} });
    await ctx.settle();
    const loan = await env.DB.prepare("select due_on as dueOn from loans").first<{
      dueOn: string;
    }>();
    const twoDaysBefore = new Date(`${loan?.dueOn}T01:00:00Z`);
    twoDaysBefore.setUTCDate(twoDaysBefore.getUTCDate() - 2);
    const before = ctx.outbox.sent.length;
    await runHourlyJob({
      DB: env.DB,
      env,
      mailer: ctx.outbox,
      push: ctx.push,
      siteUrl: "https://library.test",
      now: twoDaysBefore,
    });
    expect(ctx.pushed).toEqual([
      {
        endpoint: ENDPOINT,
        title: "A library book is due back soon",
        body: "Tap to see it, or keep it longer.",
        url: "/lib-1/",
        tag: "reminder-lib-1",
      },
    ]);
    // Phone only: no reminder email.
    expect(ctx.outbox.sent.slice(before).filter((m) => m.to === parent.email)).toEqual([]);
  });

  it("forgets a phone that's gone and emails instead", async () => {
    await subscribe(parent);
    await parent.request("/api/account/notify-by", { method: "PUT", body: { notifyBy: "push" } });
    ctx.push.gone.add(ENDPOINT);
    const res = await staff.json<{ title: { copies: { shortCode: string }[] } }>(
      "/api/catalog/titles",
      { body: { title: "Owl Babies", copies: 1 } },
    );
    await parent.request(`/api/copies/${res.body.title.copies[0]?.shortCode}/borrow`, { body: {} });
    const loan = await env.DB.prepare("select due_on as dueOn from loans").first<{
      dueOn: string;
    }>();
    const twoDaysBefore = new Date(`${loan?.dueOn}T01:00:00Z`);
    twoDaysBefore.setUTCDate(twoDaysBefore.getUTCDate() - 2);
    await runHourlyJob({
      DB: env.DB,
      env,
      mailer: ctx.outbox,
      push: ctx.push,
      siteUrl: "https://library.test",
      now: twoDaysBefore,
    });
    expect(
      ctx.outbox.sent.some((m) => m.to === parent.email && /due back soon/.test(m.subject)),
    ).toBe(true);
    const left = await env.DB.prepare("select count(*) as n from push_subscriptions").first<number>(
      "n",
    );
    expect(left).toBe(0);
  });
});
