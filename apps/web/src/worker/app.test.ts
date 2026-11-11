import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.ts";
import { createTestApp, TestClient } from "./test/client.ts";
import { createTestEnv } from "./test/env.ts";
import { createLibrary, person } from "./test/fixtures.ts";

let env: Env;
let dispose: () => Promise<void>;
let ctx: ReturnType<typeof createTestApp>;

beforeEach(async () => {
  ({ env, dispose } = await createTestEnv({ SETUP_CODE: "open-sesame" } as Partial<Env>));
  ctx = createTestApp(env);
});
afterEach(() => dispose());

describe("GET /api/health", () => {
  it("reports ok when the database answers", async () => {
    const res = await ctx.app.request("/api/health", {}, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, database: "ok" });
  });

  it("returns 503 when the database fails", async () => {
    const broken = {
      ...env,
      DB: {
        prepare: () => ({
          first: async () => {
            throw new Error("D1 unavailable");
          },
        }),
      },
    } as unknown as Env;
    const res = await createApp().request("/api/health", {}, broken);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ ok: false, database: "error" });
  });
});

describe("unknown API routes", () => {
  it("return a JSON 404", async () => {
    const res = await ctx.app.request("/api/nope", {}, env);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "not_found" });
  });
});

describe("first-run setup", () => {
  it("makes the first person through the site's owner", async () => {
    const owner = new TestClient(ctx, "owner@example.com");
    owner.library = null;
    expect((await owner.json("/api/me")).body).toMatchObject({ user: null, setupNeeded: true });

    await owner.signIn();
    const setup = await owner.json("/api/setup", { body: { setupCode: "open-sesame" } });
    expect(setup.status).toBe(201);
    expect((await owner.json("/api/me")).body).toMatchObject({
      user: { email: "owner@example.com" },
      owner: true,
      libraries: [],
      setupNeeded: false,
    });
  });

  it("refuses a wrong setup code, and a second setup", async () => {
    const owner = new TestClient(ctx, "owner@example.com");
    await owner.signIn();
    expect((await owner.json("/api/setup", { body: { setupCode: "nope" } })).status).toBe(403);
    expect((await owner.json("/api/setup", { body: { setupCode: "open-sesame" } })).status).toBe(
      201,
    );
    expect((await owner.json("/api/setup", { body: { setupCode: "open-sesame" } })).status).toBe(
      409,
    );
  });

  it("on a site that already has libraries, only one of their admins can become owner", async () => {
    await env.DB.batch([
      env.DB.prepare(
        "insert into libraries (id, name, slug, settings, terms_accepted_at) values ('old', 'Old', 'old', '{}', 1)",
      ),
    ]);
    const stranger = new TestClient(ctx, "stranger@example.com");
    // Strangers can't even get a sign-in code once libraries exist.
    expect(await stranger.requestCode()).toBeUndefined();
    const member = await person(ctx, { role: "member", libraryId: "old" });
    member.library = null;
    expect((await member.json("/api/me")).body).toMatchObject({ setupNeeded: false });
    expect((await member.json("/api/setup", { body: { setupCode: "open-sesame" } })).status).toBe(
      409,
    );
    const admin = await person(ctx, { role: "admin", libraryId: "old" });
    admin.library = null;
    expect((await admin.json("/api/me")).body).toMatchObject({ setupNeeded: true });
    expect((await admin.json("/api/setup", { body: { setupCode: "open-sesame" } })).status).toBe(
      201,
    );
  });

  it("requires sign-in", async () => {
    const stranger = new TestClient(ctx, "x@example.com");
    expect((await stranger.json("/api/setup", { body: {} })).status).toBe(401);
  });
});

describe("sign-in codes", () => {
  it("are only sent to people the library knows, once it is set up", async () => {
    const admin = new TestClient(ctx, "admin@example.com");
    await admin.signIn();
    await admin.json("/api/setup", { body: { setupCode: "open-sesame" } });

    const stranger = new TestClient(ctx, "stranger@example.com");
    const res = await stranger.request("/api/auth/email-otp/send-verification-otp", {
      body: { email: stranger.email, type: "sign-in" },
    });
    // Same answer as for a member, so the form does not reveal who is one.
    expect(res.status).toBe(200);
    expect(ctx.outbox.last(stranger.email)).toBeUndefined();

    // A known user still gets one.
    expect(await new TestClient(ctx, "admin@example.com").requestCode()).toMatch(/^\d{6}$/);
  });

  it("reject a wrong code", async () => {
    const admin = new TestClient(ctx, "admin@example.com");
    expect(await admin.requestCode()).toBeDefined();
    const res = await admin.request("/api/auth/sign-in/email-otp", {
      body: { email: admin.email, otp: "000000" },
    });
    expect(res.ok).toBe(false);
    expect((await admin.json("/api/me")).body).toMatchObject({ user: null });
  });

  it("can sign out", async () => {
    const admin = new TestClient(ctx, "admin@example.com");
    await admin.signIn();
    expect((await admin.json("/api/me")).body).toMatchObject({ user: { email: admin.email } });
    await admin.request("/api/auth/sign-out", { body: {} });
    expect((await admin.json("/api/me")).body).toMatchObject({ user: null });
  });

  it("do not store the IP address or browser with the session", async () => {
    const admin = new TestClient(ctx, "admin@example.com");
    await admin.signIn();
    const row = await env.DB.prepare("select ip_address, user_agent from sessions").first();
    expect(row).toEqual({ ip_address: null, user_agent: null });
  });
});

describe("hardening", () => {
  async function setUpLibrary() {
    const admin = new TestClient(ctx, "admin@example.com");
    await admin.signIn();
    await admin.json("/api/setup", { body: { setupCode: "open-sesame" } });
    await createLibrary(env);
    return admin;
  }

  it("closes Better Auth endpoints the app does not use", async () => {
    const client = new TestClient(ctx, "a@example.com");
    for (const path of [
      "/api/auth/email-otp/check-verification-otp",
      "/api/auth/email-otp/request-password-reset",
      "/api/auth/sign-up/email",
    ]) {
      expect((await client.request(path, { body: {} })).status).toBe(404);
    }
  });

  it("sends at most 3 codes to one address in 10 minutes", async () => {
    await setUpLibrary();
    const admin = new TestClient(ctx, "admin@example.com");
    const codes = [];
    for (let i = 0; i < 4; i++) codes.push(await admin.requestCode());
    // One code was used by setUpLibrary's sign-in, so two more get through.
    expect(codes.filter(Boolean)).toHaveLength(2);
  });

  it("limits code guesses per address, even from many networks", async () => {
    await setUpLibrary();
    const admin = new TestClient(ctx, "admin@example.com");
    const statuses = [];
    for (let i = 0; i < 12; i++) {
      const res = await admin.request("/api/auth/sign-in/email-otp", {
        body: { email: admin.email, otp: "000000" },
        headers: { "cf-connecting-ip": `203.0.113.${i}` },
      });
      statuses.push(res.status);
    }
    expect(statuses.slice(-1)).toEqual([429]);
  });

  it("lets someone with the sign-up link get a code", async () => {
    await setUpLibrary();
    const { sha256Hex } = await import("./crypto.ts");
    await env.DB.prepare("update libraries set join_token_hash = ?")
      .bind(await sha256Hex("join-token-123"))
      .run();
    const parent = new TestClient(ctx, "parent@example.com");
    expect(await parent.requestCode()).toBeUndefined();
    expect(await parent.requestCode({ "x-join-token": "wrong" })).toBeUndefined();
    expect(await parent.requestCode({ "x-join-token": "join-token-123" })).toMatch(/^\d{6}$/);
  });

  it("runs setup once when two people try at the same moment", async () => {
    const a = new TestClient(ctx, "a@example.com");
    const b = new TestClient(ctx, "b@example.com");
    await a.signIn();
    await b.signIn();
    const body = { setupCode: "open-sesame" };
    const results = await Promise.all([
      a.json("/api/setup", { body }),
      b.json("/api/setup", { body }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    const owners = await env.DB.prepare("select count(*) as n from platform_admins").first("n");
    expect(owners).toBe(1);
  });
});

describe("a real deployment", () => {
  it("needs a long SETUP_CODE before anyone can set up the library", async () => {
    const remote = new TestClient(ctx, "admin@example.com", "https://library.example.org");
    await remote.signIn();
    const res = await remote.json("/api/setup", {
      body: { setupCode: "open-sesame" },
    });
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ error: "setup_code_too_short" });
  });

  it("never prints emails to the log when no provider is set", async () => {
    const { configuredSenders } = await import("./email.ts");
    expect(configuredSenders(env, "L", "library.example.org").map((s) => s.name)).toEqual(["none"]);
    expect(configuredSenders(env, "L", "localhost").map((s) => s.name)).toEqual(["console"]);
  });

  it("reports missing email setup in the health check", async () => {
    const res = await ctx.app.request("/api/health", {}, env);
    expect(await res.json()).toMatchObject({ email: "no_provider" });
  });
});
