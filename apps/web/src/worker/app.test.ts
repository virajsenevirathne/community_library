import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.ts";
import { createTestApp, TestClient } from "./test/client.ts";
import { createTestEnv } from "./test/env.ts";

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
  it("lets the first person sign in, create the library and become admin", async () => {
    const admin = new TestClient(ctx, "admin@example.com");
    expect((await admin.json("/api/me")).body).toMatchObject({ user: null, setupNeeded: true });

    await admin.signIn();
    const setup = await admin.json("/api/setup", {
      body: {
        setupCode: "open-sesame",
        libraryName: "Little Owls",
        timezone: "Australia/Sydney",
        familyName: "Lee",
      },
    });
    expect(setup.status).toBe(201);

    const me = await admin.json("/api/me");
    expect(me.body).toMatchObject({
      user: { email: "admin@example.com", hasPasskey: false },
      library: { name: "Little Owls" },
      setupNeeded: false,
      membership: { role: "admin", family: { name: "Lee", status: "active" } },
    });
  });

  it("refuses a wrong setup code, and a second setup", async () => {
    const admin = new TestClient(ctx, "admin@example.com");
    await admin.signIn();
    const body = { libraryName: "Little Owls", timezone: "UTC" };
    expect((await admin.json("/api/setup", { body: { ...body, setupCode: "nope" } })).status).toBe(
      403,
    );
    expect(
      (await admin.json("/api/setup", { body: { ...body, setupCode: "open-sesame" } })).status,
    ).toBe(201);
    expect(
      (await admin.json("/api/setup", { body: { ...body, setupCode: "open-sesame" } })).status,
    ).toBe(409);
  });

  it("requires sign-in and valid details", async () => {
    const stranger = new TestClient(ctx, "x@example.com");
    expect((await stranger.json("/api/setup", { body: {} })).status).toBe(401);
    await stranger.signIn();
    const bad = await stranger.json("/api/setup", {
      body: { setupCode: "open-sesame", libraryName: " ", timezone: "Mars/Base" },
    });
    expect(bad.status).toBe(422);
    expect(bad.body).toMatchObject({ message: "Library name is required." });
  });
});

describe("sign-in codes", () => {
  it("are only sent to people the library knows, once it is set up", async () => {
    const admin = new TestClient(ctx, "admin@example.com");
    await admin.signIn();
    await admin.json("/api/setup", {
      body: { setupCode: "open-sesame", libraryName: "L", timezone: "UTC" },
    });

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
    await admin.json("/api/setup", {
      body: { setupCode: "open-sesame", libraryName: "L", timezone: "UTC" },
    });
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
    const body = { setupCode: "open-sesame", libraryName: "L", timezone: "UTC" };
    const results = await Promise.all([
      a.json("/api/setup", { body }),
      b.json("/api/setup", { body }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    const admins = await env.DB.prepare("select count(*) as n from memberships").first("n");
    expect(admins).toBe(1);
  });

  it("refuses names with line breaks", async () => {
    const admin = new TestClient(ctx, "admin@example.com");
    await admin.signIn();
    const res = await admin.json("/api/setup", {
      body: { setupCode: "open-sesame", libraryName: "Owls\nBcc: x@evil.test", timezone: "UTC" },
    });
    expect(res.status).toBe(422);
  });
});

describe("a real deployment", () => {
  it("needs a long SETUP_CODE before anyone can set up the library", async () => {
    const remote = new TestClient(ctx, "admin@example.com", "https://library.example.org");
    await remote.signIn();
    const res = await remote.json("/api/setup", {
      body: { setupCode: "open-sesame", libraryName: "L", timezone: "UTC" },
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
