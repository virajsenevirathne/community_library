import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestApp, TestClient } from "../test/client.ts";
import { createTestEnv } from "../test/env.ts";
import { createLibrary, person } from "../test/fixtures.ts";

type Person = Awaited<ReturnType<typeof person>>;
let env: Env;
let dispose: () => Promise<void>;
let ctx: ReturnType<typeof createTestApp>;
let admin: Person;
let staff: Person;

beforeEach(async () => {
  ({ env, dispose } = await createTestEnv());
  ctx = createTestApp(env);
  await createLibrary(env, { settings: { closedWeekdays: [] } });
  admin = await person(ctx, { role: "admin" });
  staff = await person(ctx, { role: "staff" });
});
afterEach(() => dispose());

const count = (query: string, ...params: unknown[]) =>
  env.DB.prepare(query)
    .bind(...params)
    .first("n");

async function joinLink(): Promise<string> {
  const res = await admin.json<{ joinUrl: string }>("/api/admin/join-link", {
    body: { enabled: true },
  });
  return res.body.joinUrl.split("/join/")[1] ?? "";
}

/** Signs a new person in with an invite or join header, then returns their client. */
async function newcomer(email: string, header: Record<string, string>) {
  const client = new TestClient(ctx, email);
  const code = await client.requestCode(header);
  if (!code) throw new Error(`no code for ${email}`);
  await client.request("/api/auth/sign-in/email-otp", { body: { email, otp: code } });
  return client;
}

describe("sign-up link", () => {
  it("lets a new parent sign in and join as a family", async () => {
    const token = await joinLink();
    expect((await new TestClient(ctx, "x@example.com").json(`/api/join/${token}`)).status).toBe(
      200,
    );
    const parent = await newcomer("new@example.com", { "x-join-token": token });
    const res = await parent.json<{ status: string }>("/api/join", {
      body: { token, familyName: "Patel" },
    });
    expect(res.body.status).toBe("active");
    const me = await parent.json<{ membership: { role: string; family: { name: string } } }>(
      "/api/me",
    );
    expect(me.body.membership).toMatchObject({ role: "member", family: { name: "Patel" } });
    // Joining twice is refused.
    expect((await parent.json("/api/join", { body: { token, familyName: "Patel" } })).status).toBe(
      409,
    );
  });

  it("makes new families wait when approval is on, and staff can approve", async () => {
    await admin.json("/api/admin/settings", { method: "PATCH", body: { requireApproval: true } });
    const token = await joinLink();
    const parent = await newcomer("new@example.com", { "x-join-token": token });
    expect(
      (await parent.json<{ status: string }>("/api/join", { body: { token, familyName: "Patel" } }))
        .body.status,
    ).toBe("pending");
    const families = await staff.json<{ families: { id: string; status: string }[] }>(
      "/api/admin/families",
    );
    const family = families.body.families.find((f) => f.status === "pending");
    await staff.json(`/api/admin/families/${family?.id}/status`, { body: { status: "active" } });
    const me = await parent.json<{ membership: { family: { status: string } } }>("/api/me");
    expect(me.body.membership.family.status).toBe("active");
  });

  it("stops working when replaced", async () => {
    const old = await joinLink();
    const fresh = await joinLink();
    expect(fresh).not.toBe(old);
    expect((await new TestClient(ctx, "x@example.com").json(`/api/join/${old}`)).status).toBe(404);
    expect(
      await new TestClient(ctx, "x@example.com").requestCode({ "x-join-token": old }),
    ).toBeUndefined();
  });

  it("can only be changed by the admin", async () => {
    expect((await staff.json("/api/admin/join-link", { body: { enabled: true } })).status).toBe(
      403,
    );
  });
});

describe("CSV import and invites", () => {
  const csv = [
    "Child,Family name,Email",
    "Mia,Nguyen,anh@example.com",
    "Mia,Nguyen,binh@example.com",
    "Leo,Okafor,ada@example.com",
    "Zoe,Okafor,not-an-email",
  ].join("\n");

  it("previews, then creates families and sends invites, without children's names", async () => {
    const preview = await staff.json<{
      families: number;
      invites: number;
      rows: { problem: string | null }[];
    }>("/api/admin/import/preview", { body: { csv } });
    expect(preview.body).toMatchObject({ families: 2, invites: 3 });
    expect(preview.body.rows.map((r) => r.problem)).toEqual([null, null, null, "invalid_email"]);

    const res = await staff.json("/api/admin/import", { body: { csv } });
    expect(res.status).toBe(201);
    await ctx.settle();
    expect(
      ctx.outbox.sent
        .filter((m) => m.subject.startsWith("You're invited"))
        .map((m) => m.to)
        .sort(),
    ).toEqual(["ada@example.com", "anh@example.com", "binh@example.com"]);
    expect(await count("select count(*) as n from families where name = 'Nguyen'")).toBe(1);
    const stored = JSON.stringify(await env.DB.prepare("select * from families").all());
    expect(stored).not.toContain("Mia");

    // Importing the same file again invites nobody new.
    const again = await staff.json("/api/admin/import", { body: { csv } });
    expect(again.body).toMatchObject({ error: "nothing_to_import" });
  });

  it("lets the invited parent join their family, and nobody else use the invite", async () => {
    await staff.json("/api/admin/import", { body: { csv } });
    await ctx.settle();
    const url = ctx.outbox.last("anh@example.com")?.text.match(/https?:\/\/\S+\/invite\/(\S+)/);
    const token = url?.[1] ?? "";
    const info = await new TestClient(ctx, "x@example.com").json(`/api/invites/${token}`);
    expect(info.body).toMatchObject({ email: "anh@example.com", familyName: "Nguyen" });

    // Someone else signed in cannot accept it.
    const other = await person(ctx, { role: "none", email: "other@example.com" });
    expect((await other.json("/api/invites/accept", { body: { token } })).body).toMatchObject({
      error: "wrong_email",
    });

    const anh = await newcomer("anh@example.com", { "x-invite-token": token });
    expect((await anh.json("/api/invites/accept", { body: { token } })).status).toBe(200);
    const me = await anh.json<{ membership: { family: { name: string } } }>("/api/me");
    expect(me.body.membership.family.name).toBe("Nguyen");
    // The invite is used up, and its email address is no longer kept.
    expect((await anh.json("/api/invites/accept", { body: { token } })).status).toBe(404);
    expect(
      await count("select count(*) as n from invitations where email = 'anh@example.com'"),
    ).toBe(0);
  });

  it("invites a second parent into an existing family", async () => {
    const first = await person(ctx, { role: "member", familyName: "Lee" });
    await staff.json(`/api/admin/families/${first.familyId}/invite`, {
      body: { email: "second@example.com" },
    });
    const token = ctx.outbox.last("second@example.com")?.text.match(/\/invite\/(\S+)/)?.[1] ?? "";
    const second = await newcomer("second@example.com", { "x-invite-token": token });
    await second.json("/api/invites/accept", { body: { token } });
    const me = await second.json<{ membership: { family: { id: string } } }>("/api/me");
    expect(me.body.membership.family.id).toBe(first.familyId);
  });

  it("lets only the admin invite staff", async () => {
    expect(
      (
        await staff.json("/api/admin/staff/invite", {
          body: { email: "s@example.com", role: "staff" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await admin.json("/api/admin/staff/invite", {
          body: { email: "s@example.com", role: "staff" },
        })
      ).status,
    ).toBe(201);
  });
});

describe("removing a family and deleting an account", () => {
  async function lendTo(who: Person) {
    const res = await staff.json<{ title: { copies: { shortCode: string }[] } }>(
      "/api/catalog/titles",
      {
        body: { title: "Owl Babies" },
      },
    );
    const code = res.body.title.copies[0]?.shortCode ?? "";
    await who.json(`/api/copies/${code}/borrow`, { body: {} });
    return code;
  }

  it("asks staff before removing a family with books out, then keeps the counts", async () => {
    const parent = await person(ctx, { role: "member", familyName: "Lee" });
    await lendTo(parent);
    const blocked = await staff.json<{ books: string[] }>(
      `/api/admin/families/${parent.familyId}/remove`,
      { body: {} },
    );
    expect(blocked.status).toBe(409);
    expect(blocked.body.books).toEqual(["Owl Babies"]);
    const removed = await staff.json(`/api/admin/families/${parent.familyId}/remove`, {
      body: { markLost: true },
    });
    expect(removed.status).toBe(200);
    expect(await count("select count(*) as n from families where id = ?", parent.familyId)).toBe(0);
    expect(
      await count("select count(*) as n from loans where family_id is null and outcome = 'lost'"),
    ).toBe(1);
  });

  it("blocks deleting an account while the family has books out", async () => {
    const parent = await person(ctx, { role: "member", familyName: "Lee" });
    await lendTo(parent);
    const res = await parent.json<{ blocked: boolean; books: { title: string }[] }>(
      "/api/account/delete/start",
      {
        body: {},
      },
    );
    expect(res.status).toBe(409);
    expect(res.body.books.map((b) => b.title)).toEqual(["Owl Babies"]);
  });

  it("deletes the account with the emailed code, removing the family but keeping loan counts", async () => {
    const parent = await person(ctx, { role: "member", familyName: "Lee" });
    const code = await lendTo(parent);
    await parent.json(`/api/copies/${code}/return`, { body: {} });
    const start = await parent.json<{ codeSent: boolean; familyWillBeRemoved: boolean }>(
      "/api/account/delete/start",
      {
        body: {},
      },
    );
    expect(start.body).toEqual({ codeSent: true, familyWillBeRemoved: true });
    const emailed = ctx.outbox.last(parent.email)?.subject.match(/^(\d{6})/)?.[1] ?? "";
    expect(
      (await parent.json("/api/account/delete/confirm", { body: { code: "000000" } })).status,
    ).toBe(400);
    const done = await parent.json("/api/account/delete/confirm", { body: { code: emailed } });
    expect(done.status).toBe(200);
    await ctx.settle();

    expect(await count("select count(*) as n from users where id = ?", parent.userId)).toBe(0);
    expect(await count("select count(*) as n from families where id = ?", parent.familyId)).toBe(0);
    expect(await count("select count(*) as n from loans where family_id is null")).toBe(1);
    expect(await count("select count(*) as n from sessions where user_id = ?", parent.userId)).toBe(
      0,
    );
    expect(ctx.outbox.last(parent.email)?.subject).toContain("has been deleted");
    // Signed out, and no code is sent to the old address any more.
    expect((await parent.json<{ user: unknown }>("/api/me")).body.user).toBeNull();
    expect(await parent.requestCode()).toBeUndefined();
  });

  it("keeps the family when another parent remains", async () => {
    const first = await person(ctx, { role: "member", familyName: "Lee" });
    const second = await person(ctx, { role: "member", familyId: first.familyId });
    await lendTo(first);
    const start = await second.json<{ familyWillBeRemoved: boolean }>("/api/account/delete/start", {
      body: {},
    });
    expect(start.body.familyWillBeRemoved).toBe(false);
    const emailed = ctx.outbox.last(second.email)?.subject.match(/^(\d{6})/)?.[1] ?? "";
    await second.json("/api/account/delete/confirm", { body: { code: emailed } });
    expect(await count("select count(*) as n from families where id = ?", first.familyId)).toBe(1);
  });

  it("stops the only admin from deleting their account", async () => {
    const res = await admin.json<{ lastAdmin: boolean }>("/api/account/delete/start", { body: {} });
    expect(res.status).toBe(409);
    expect(res.body.lastAdmin).toBe(true);
  });
});

describe("review fixes", () => {
  it("imports a 500-row file in one go", async () => {
    const lines = ["Family name,Email"];
    for (let i = 0; i < 500; i++) lines.push(`Family ${i},parent${i}@example.com`);
    const res = await staff.json<{ families: number; invites: number }>("/api/admin/import", {
      body: { csv: lines.join("\n") },
    });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ families: 500, invites: 500 });
    await ctx.settle();
    // The first 20 go out now; the hourly job sends the rest.
    expect(ctx.outbox.sent.filter((m) => m.subject.startsWith("You're invited"))).toHaveLength(20);
  });

  it("keeps staff access when their family is removed", async () => {
    const parent = await person(ctx, { role: "member", familyName: "Lee" });
    const staffParent = await person(ctx, { role: "staff", familyId: parent.familyId });
    await admin.json(`/api/admin/families/${parent.familyId}/remove`, { body: {} });
    const me = await staffParent.json<{ membership: { role: string; family: unknown } }>("/api/me");
    expect(me.body.membership).toEqual({ role: "staff", family: null });
    // The parent-only account is gone entirely.
    expect(await count("select count(*) as n from users where id = ?", parent.userId)).toBe(0);
  });

  it("tells a family when staff approve them", async () => {
    const waiting = await person(ctx, { role: "member", familyStatus: "pending" });
    await staff.json(`/api/admin/families/${waiting.familyId}/status`, {
      body: { status: "active" },
    });
    await ctx.settle();
    expect(ctx.outbox.last(waiting.email)?.subject).toContain("You can now borrow");
  });

  it("does not let existing staff accept an invite that changes their role", async () => {
    await admin
      .json("/api/admin/staff/invite", { body: { email: staff.email, role: "admin" } })
      .catch(() => null);
    const res = await admin.json("/api/admin/staff/invite", {
      body: { email: staff.email, role: "admin" },
    });
    expect(res.body).toMatchObject({ error: "already_member" });
  });

  it("removes pending invitations for an address when its account is deleted", async () => {
    const parent = await person(ctx, { role: "member", familyName: "Lee" });
    await env.DB.prepare(
      "insert into invitations (id, library_id, family_id, email, role, token_hash, expires_at) values ('inv', 'lib-1', ?, ?, 'member', 'unsent:inv', 0)",
    )
      .bind(parent.familyId, parent.email)
      .run();
    await parent.json("/api/account/delete/start", { body: {} });
    const code = ctx.outbox.last(parent.email)?.subject.match(/^(\d{6})/)?.[1] ?? "";
    await parent.json("/api/account/delete/confirm", { body: { code } });
    expect(
      await count("select count(*) as n from invitations where lower(email) = ?", parent.email),
    ).toBe(0);
  });

  it("caps sign-in codes sent through the sign-up link", async () => {
    const token = await joinLink();
    const sent = [];
    for (let i = 0; i < 32; i++) {
      sent.push(
        await new TestClient(ctx, `walk-in${i}@example.com`).requestCode({ "x-join-token": token }),
      );
    }
    expect(sent.filter(Boolean)).toHaveLength(30);
  });
});
