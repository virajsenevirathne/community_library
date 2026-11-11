import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runHourlyJob } from "../jobs/reminders.ts";
import { createTestApp, TestClient } from "../test/client.ts";
import { createTestEnv } from "../test/env.ts";
import { createLibrary, person } from "../test/fixtures.ts";

/*
 * The site's owner creates libraries and invites each one's first admin,
 * who finishes setting it up. Libraries can be paused; the owner can open
 * any library for support, and each visit is logged for its admins.
 */

type Person = Awaited<ReturnType<typeof person>>;
let env: Env;
let dispose: () => Promise<void>;
let ctx: ReturnType<typeof createTestApp>;
let owner: Person;

beforeEach(async () => {
  ({ env, dispose } = await createTestEnv());
  ctx = createTestApp(env);
  await createLibrary(env, { id: "lib-1", name: "Little Owls", settings: { closedWeekdays: [] } });
  owner = await person(ctx, { role: "none", email: "owner@example.com" });
  await env.DB.prepare("insert into platform_admins (user_id) values (?)").bind(owner.userId).run();
  owner.library = null;
});
afterEach(() => dispose());

/** Signs in as an invited person, using the invite link from their email. */
async function acceptInvite(email: string) {
  await ctx.settle();
  const token = ctx.outbox.last(email)?.text.match(/\/invite\/(\S+)/)?.[1] ?? "";
  const client = new TestClient(ctx, email);
  client.library = null;
  const code = await client.requestCode({ "x-invite-token": token });
  if (!code) throw new Error(`no code for ${email}`);
  await client.request("/api/auth/sign-in/email-otp", { body: { email, otp: code } });
  const accepted = await client.json("/api/invites/accept", { body: { token } });
  return { client, accepted };
}

describe("creating a library", () => {
  it("creates it, emails its first admin the steps, and lets them in", async () => {
    const res = await owner.json<{ library: { slug: string } }>("/api/owner/libraries", {
      body: { name: "Brown Bears", timezone: "Australia/Perth", adminEmail: "Kim@Example.com" },
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ library: { slug: "brown-bears" }, inviteSent: true });
    await ctx.settle();
    const email = ctx.outbox.last("kim@example.com");
    expect(email?.subject).toBe("You're invited to Brown Bears");
    expect(email?.text).toContain("Brown Bears is new.");
    expect(email?.text).toContain("Accept the terms");

    const { client, accepted } = await acceptInvite("kim@example.com");
    expect(accepted.status).toBe(200);
    client.library = "brown-bears";
    expect((await client.json("/api/me")).body).toMatchObject({
      library: { slug: "brown-bears", setUp: false },
      membership: { role: "admin" },
      owner: false,
    });
  });

  it("finds a free address, and refuses one already taken", async () => {
    const body = { name: "Little Owls", timezone: "UTC", adminEmail: "a@example.com" };
    const second = await owner.json("/api/owner/libraries", { body });
    expect(second.body).toMatchObject({ library: { slug: "little-owls" } });
    const third = await owner.json("/api/owner/libraries", { body });
    expect(third.body).toMatchObject({ library: { slug: "little-owls-2" } });
    const asked = await owner.json("/api/owner/libraries", { body: { ...body, slug: "lib-1" } });
    expect(asked.status).toBe(409);
    const reserved = await owner.json("/api/owner/libraries", { body: { ...body, slug: "admin" } });
    expect(reserved.status).toBe(422);
  });

  it("refuses names with line breaks and bad emails", async () => {
    const res = await owner.json("/api/owner/libraries", {
      body: { name: "Owls\nBcc: x@evil.test", timezone: "UTC", adminEmail: "nope" },
    });
    expect(res.status).toBe(422);
  });

  it("is only for the site's owner", async () => {
    const admin = await person(ctx, { role: "admin", libraryId: "lib-1" });
    const res = await admin.json("/api/owner/libraries", {
      body: { name: "Mine", timezone: "UTC", adminEmail: "a@example.com" },
    });
    expect(res.status).toBe(403);
  });

  it("lists every library with how it's doing", async () => {
    await owner.json("/api/owner/libraries", {
      body: { name: "Brown Bears", timezone: "UTC", adminEmail: "kim@example.com" },
    });
    const res = await owner.json<{ libraries: Record<string, unknown>[] }>("/api/owner/libraries");
    expect(res.body.libraries).toMatchObject([
      { name: "Brown Bears", setUp: false, admins: 0, pendingAdmin: "kim@example.com" },
      { name: "Little Owls", setUp: true, status: "active" },
    ]);
  });
});

describe("a new library's first admin", () => {
  it("accepts the terms and chooses how returns work", async () => {
    await owner.json("/api/owner/libraries", {
      body: { name: "Brown Bears", timezone: "UTC", adminEmail: "kim@example.com" },
    });
    const { client } = await acceptInvite("kim@example.com");
    client.library = "brown-bears";
    expect(
      (await client.json("/api/admin/welcome", { body: { returnsNeedCheckIn: true } })).status,
    ).toBe(422);
    const ok = await client.json("/api/admin/welcome", {
      body: { acceptTerms: true, returnsNeedCheckIn: true },
    });
    expect(ok.status).toBe(200);
    expect((await client.json("/api/me")).body).toMatchObject({ library: { setUp: true } });
    const settings = await client.json<{ settings: { returnsNeedCheckIn: boolean } }>(
      "/api/admin/settings",
    );
    expect(settings.body.settings.returnsNeedCheckIn).toBe(true);
  });
});

describe("support access", () => {
  it("lets the owner open any library as its admin, logged once a day", async () => {
    owner.library = "lib-1";
    expect((await owner.json("/api/me")).body).toMatchObject({
      library: { slug: "lib-1", support: true },
      membership: { role: "admin" },
    });
    expect((await owner.json("/api/admin/loans")).status).toBe(200);
    expect((await owner.json("/api/admin/loans")).status).toBe(200);
    const visits = await env.DB.prepare(
      "select count(*) as n from events where library_id = 'lib-1' and type = 'owner_access'",
    ).first("n");
    expect(visits).toBe(1);
    // The library's own admins see the visits.
    const admin = await person(ctx, { role: "admin", libraryId: "lib-1" });
    const settings = await admin.json<{ supportVisits: string[] }>("/api/admin/settings");
    expect(settings.body.supportVisits).toHaveLength(1);
  });

  it("can't accept the terms on the library's behalf", async () => {
    owner.library = "lib-1";
    const res = await owner.json("/api/admin/welcome", {
      body: { acceptTerms: true, returnsNeedCheckIn: false },
    });
    expect(res.status).toBe(403);
  });
});

describe("pausing a library", () => {
  it("makes it read-only to everyone but the owner, and stops its reminders", async () => {
    const staff = await person(ctx, { role: "staff", libraryId: "lib-1" });
    expect(
      (
        await owner.json("/api/owner/libraries/lib-1", {
          method: "PATCH",
          body: { status: "paused" },
        })
      ).status,
    ).toBe(200);
    expect((await staff.json("/api/catalog/titles")).status).toBe(200);
    const add = await staff.json("/api/catalog/titles", { body: { title: "Owl Babies" } });
    expect(add.status).toBe(403);
    expect(add.body).toMatchObject({ error: "library_paused" });
    owner.library = "lib-1";
    expect(
      (await owner.json("/api/catalog/titles", { body: { title: "Owl Babies" } })).status,
    ).toBe(201);

    // The hourly job skips paused libraries.
    const result = await runHourlyJob({
      DB: env.DB,
      env,
      mailer: ctx.outbox,
      siteUrl: "https://library.example.org",
    });
    // Still tidied for privacy, but nothing is sent for it.
    expect(result.sent).toBe(0);

    owner.library = null;
    await owner.json("/api/owner/libraries/lib-1", { method: "PATCH", body: { status: "active" } });
    expect((await staff.json("/api/catalog/titles", { body: { title: "Owl Moon" } })).status).toBe(
      201,
    );
  });

  it("renames a library but keeps its address", async () => {
    await owner.json("/api/owner/libraries/lib-1", {
      method: "PATCH",
      body: { name: "Little Owls Book Corner" },
    });
    const staff = await person(ctx, { role: "staff", libraryId: "lib-1" });
    expect((await staff.json("/api/me")).body).toMatchObject({
      library: { slug: "lib-1", name: "Little Owls Book Corner" },
    });
  });
});

describe("protecting the site", () => {
  it("won't let the only owner delete their account", async () => {
    // The fixtures add a second owner; leave this one alone in the seat.
    await env.DB.prepare("delete from platform_admins where user_id = 'site-owner'").run();
    const res = await owner.json("/api/account/delete/start", { body: {} });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ lastOwner: true });
  });

  it("lets the owner accept an invite to a library, despite support access", async () => {
    await owner.json("/api/owner/libraries", {
      body: { name: "Brown Bears", timezone: "UTC", adminEmail: "owner@example.com" },
    });
    await ctx.settle();
    const token = ctx.outbox.last("owner@example.com")?.text.match(/\/invite\/(\S+)/)?.[1] ?? "";
    const res = await owner.json("/api/invites/accept", { body: { token } });
    expect(res.status).toBe(200);
    owner.library = "brown-bears";
    expect((await owner.json("/api/me")).body).toMatchObject({
      library: { support: false },
      membership: { role: "admin" },
    });
  });

  it("refuses joining a paused library, by sign-up link or invite", async () => {
    const admin = await person(ctx, { role: "admin", libraryId: "lib-1" });
    const link = await admin.json<{ joinUrl: string }>("/api/admin/join-link", {
      body: { enabled: true },
    });
    const joinToken = link.body.joinUrl.split("/join/")[1] ?? "";
    await admin.json("/api/admin/staff/invite", {
      body: { email: "sam@example.com", role: "staff" },
    });
    await owner.json("/api/owner/libraries/lib-1", { method: "PATCH", body: { status: "paused" } });

    const newcomer = await person(ctx, { role: "none", email: "new@example.com" });
    newcomer.library = null;
    const join = await newcomer.json("/api/join", { body: { token: joinToken, familyName: "Ng" } });
    expect(join.body).toMatchObject({ error: "library_paused" });

    await ctx.settle();
    const inviteToken =
      ctx.outbox.last("sam@example.com")?.text.match(/\/invite\/(\S+)/)?.[1] ?? "";
    const sam = await person(ctx, { role: "none", email: "sam@example.com" });
    sam.library = null;
    const accept = await sam.json("/api/invites/accept", { body: { token: inviteToken } });
    expect(accept.body).toMatchObject({ error: "library_paused" });
  });
});
