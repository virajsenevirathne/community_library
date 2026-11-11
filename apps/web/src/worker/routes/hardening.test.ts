import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runHourlyJob } from "../jobs/reminders.ts";
import { createTestApp } from "../test/client.ts";
import { createTestEnv } from "../test/env.ts";
import { createLibrary, person } from "../test/fixtures.ts";

/* Fixes from the security review: staff roles, invite limits, owner safety, upkeep. */

type Person = Awaited<ReturnType<typeof person>>;
let env: Env;
let dispose: () => Promise<void>;
let ctx: ReturnType<typeof createTestApp>;
let admin: Person;

beforeEach(async () => {
  ({ env, dispose } = await createTestEnv());
  ctx = createTestApp(env);
  await createLibrary(env, { settings: { closedWeekdays: [] } });
  admin = await person(ctx, { role: "admin" });
});
afterEach(() => dispose());

const roleOf = (userId: string) =>
  env.DB.prepare("select role from memberships where user_id = ? and library_id = 'lib-1'")
    .bind(userId)
    .first<string>("role");

describe("staff roles", () => {
  it("lets an admin promote, demote and remove staff", async () => {
    const staff = await person(ctx, { role: "staff" });
    const path = `/api/admin/staff/${staff.userId}/role`;
    expect((await admin.json(path, { body: { role: "admin" } })).status).toBe(200);
    expect(await roleOf(staff.userId)).toBe("admin");
    expect((await admin.json(path, { body: { role: "staff" } })).status).toBe(200);
    expect(await roleOf(staff.userId)).toBe("staff");
    // Off the staff, and no family: they leave the library, effective at once.
    expect((await admin.json(path, { body: { role: "none" } })).status).toBe(200);
    expect(await roleOf(staff.userId)).toBeNull();
    expect((await staff.json("/api/admin/loans")).status).toBe(403);
  });

  it("keeps a staff member who borrows as a family member of it", async () => {
    const parentStaff = await person(ctx, { role: "staff", familyName: "Lee" });
    await env.DB.prepare(
      "insert into families (id, library_id, name) values ('fam-lee', 'lib-1', 'Lee')",
    ).run();
    await env.DB.prepare("update memberships set family_id = 'fam-lee' where user_id = ?")
      .bind(parentStaff.userId)
      .run();
    await admin.json(`/api/admin/staff/${parentStaff.userId}/role`, { body: { role: "none" } });
    expect(await roleOf(parentStaff.userId)).toBe("member");
  });

  it("never leaves a library without an admin", async () => {
    const res = await admin.json(`/api/admin/staff/${admin.userId}/role`, {
      body: { role: "staff" },
    });
    expect(res.body).toMatchObject({ error: "last_admin" });
    expect(await roleOf(admin.userId)).toBe("admin");
  });

  it("is only for admins", async () => {
    const staff = await person(ctx, { role: "staff" });
    const other = await person(ctx, { role: "staff" });
    const res = await staff.json(`/api/admin/staff/${other.userId}/role`, {
      body: { role: "none" },
    });
    expect(res.status).toBe(403);
  });
});

describe("invites", () => {
  it("refuses a second open invite to the same address", async () => {
    const body = { email: "sam@example.com", role: "staff" };
    expect((await admin.json("/api/admin/staff/invite", { body })).status).toBe(201);
    const again = await admin.json("/api/admin/staff/invite", { body });
    expect(again.body).toMatchObject({ error: "already_invited" });
  });

  it("caps how many invites one person can send in an hour", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 22; i++) {
      const res = await admin.json("/api/admin/staff/invite", {
        body: { email: `p${i}@example.com`, role: "staff" },
      });
      statuses.push(res.status);
    }
    expect(statuses.filter((s) => s === 201)).toHaveLength(20);
    expect(statuses.at(-1)).toBe(429);
  });
});

describe("the site's owner", () => {
  it("is never deleted when staff remove a family they belong to", async () => {
    const owner = await person(ctx, { role: "member", familyName: "Okafor" });
    await env.DB.prepare("insert into platform_admins (user_id) values (?)")
      .bind(owner.userId)
      .run();
    const res = await admin.json(`/api/admin/families/${owner.familyId}/remove`, { body: {} });
    expect(res.status).toBe(200);
    const stillThere = await env.DB.prepare("select 1 from users where id = ?")
      .bind(owner.userId)
      .first();
    expect(stillThere).not.toBeNull();
  });
});

describe("upkeep", () => {
  it("clears rate-limit records older than any window", async () => {
    await env.DB.prepare(
      "insert into rate_limits (id, key, count, last_request) values ('old', 'old', 1, ?)",
    )
      .bind(Date.now() - 3 * 86_400_000)
      .run();
    await runHourlyJob({ DB: env.DB, env, mailer: ctx.outbox, siteUrl: "https://x.example" });
    const left = await env.DB.prepare(
      "select count(*) as n from rate_limits where id = 'old'",
    ).first("n");
    expect(left).toBe(0);
  });

  it("keeps API answers out of caches", async () => {
    const res = await admin.request("/api/me");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
});
