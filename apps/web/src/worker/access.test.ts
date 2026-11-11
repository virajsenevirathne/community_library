import { parseSettings } from "@community-library/core";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type Actor,
  allow,
  canActOnFamily,
  canGrantRole,
  PERMISSIONS,
  type Permission,
  scope,
} from "./access.ts";
import { createDb, schema } from "./db/client.ts";
import type { Role } from "./db/schema.ts";
import { createTestApp, TestClient } from "./test/client.ts";
import { createTestEnv } from "./test/env.ts";
import { createLibrary, person } from "./test/fixtures.ts";

let env: Env;
let dispose: () => Promise<void>;
let ctx: ReturnType<typeof createTestApp>;

beforeEach(async () => {
  ({ env, dispose } = await createTestEnv());
  ctx = createTestApp(env);
});
afterEach(() => dispose());

const ROLES: Role[] = ["member", "staff", "admin"];

function actor(role: Role, libraryId = "lib-1", familyId: string | null = "family-a"): Actor {
  return {
    userId: `u-${role}`,
    email: `${role}@example.com`,
    library: {
      id: libraryId,
      name: "L",
      slug: libraryId,
      settings: parseSettings(null),
      status: "active",
      setUp: true,
    },
    role,
    family: familyId ? { id: familyId, name: "A", status: "active" } : null,
  };
}

describe("permission table", () => {
  // A deliberate copy of the table: changing who may do what must be a visible test change.
  const expected: Record<Permission, Role[]> = {
    "loans:own": ["member", "staff", "admin"],
    "copies:report-found": ["member", "staff", "admin"],
    "loans:manage": ["staff", "admin"],
    "catalog:edit": ["staff", "admin"],
    "families:manage": ["staff", "admin"],
    "library:admin": ["admin"],
  };

  it("matches the documented roles exactly", () => {
    expect(Object.keys(PERMISSIONS).sort()).toEqual(Object.keys(expected).sort());
    for (const [permission, roles] of Object.entries(expected) as [Permission, Role[]][]) {
      for (const role of ROLES) {
        expect(allow(actor(role), permission), `${role} → ${permission}`).toBe(
          roles.includes(role),
        );
      }
    }
  });

  it("lets staff invite parents but only admins grant staff or admin", () => {
    expect(canGrantRole(actor("staff"), "member")).toBe(true);
    expect(canGrantRole(actor("staff"), "staff")).toBe(false);
    expect(canGrantRole(actor("staff"), "admin")).toBe(false);
    expect(canGrantRole(actor("admin"), "staff")).toBe(true);
    expect(canGrantRole(actor("member"), "member")).toBe(false);
  });

  it("lets members act only on their own family's loans", () => {
    expect(canActOnFamily(actor("member", "lib-1", "family-a"), "family-a")).toBe(true);
    expect(canActOnFamily(actor("member", "lib-1", "family-a"), "family-b")).toBe(false);
    expect(canActOnFamily(actor("member", "lib-1", null), null)).toBe(false);
    expect(canActOnFamily(actor("staff", "lib-1", null), "family-b")).toBe(true);
  });
});

describe("scoped queries", () => {
  async function seedTwoLibraries() {
    await createLibrary(env, { id: "lib-1" });
    await createLibrary(env, { id: "lib-2" });
    await env.DB.batch(
      [
        "insert into families (id, library_id, name) values ('family-a', 'lib-1', 'A'), ('family-b', 'lib-1', 'B'), ('family-z', 'lib-2', 'Z')",
        "insert into titles (id, library_id, title) values ('t1', 'lib-1', 'One'), ('t2', 'lib-2', 'Two')",
        "insert into copies (id, library_id, title_id, short_code) values ('c1', 'lib-1', 't1', 'AAAA'), ('c1b', 'lib-1', 't1', 'BBBB'), ('c2', 'lib-2', 't2', 'CCCC')",
        "insert into loans (id, library_id, copy_id, family_id, borrowed_at, due_on) values ('loan-a', 'lib-1', 'c1', 'family-a', 0, '2026-01-01'), ('loan-b', 'lib-1', 'c1b', 'family-b', 0, '2026-01-01'), ('loan-z', 'lib-2', 'c2', 'family-z', 0, '2026-01-01')",
      ].map((q) => env.DB.prepare(q)),
    );
  }

  const db = () => createDb(env.DB);
  const visibleLoans = (who: Actor) => {
    const s = scope(who);
    return db()
      .select({ id: schema.loans.id })
      .from(schema.loans)
      .where(s.where(schema.loans, s.familiesVisible(schema.loans.familyId)))
      .all()
      .then((rows) => rows.map((r) => r.id).sort());
  };
  const ownLoans = (who: Actor) => {
    const s = scope(who);
    return db()
      .select({ id: schema.loans.id })
      .from(schema.loans)
      .where(s.where(schema.loans, s.ownFamily(schema.loans.familyId)))
      .all()
      .then((rows) => rows.map((r) => r.id).sort());
  };

  it("never return another library's rows", async () => {
    await seedTwoLibraries();
    expect(await visibleLoans(actor("admin", "lib-1"))).toEqual(["loan-a", "loan-b"]);
    expect(await visibleLoans(actor("admin", "lib-2", "family-z"))).toEqual(["loan-z"]);
    const s = scope(actor("staff", "lib-2"));
    const copy = await db()
      .select({ id: schema.copies.id })
      .from(schema.copies)
      .where(s.where(schema.copies, eq(schema.copies.shortCode, "AAAA")))
      .all();
    expect(copy).toEqual([]);
  });

  it("show members only their own family, and nothing without a family", async () => {
    await seedTwoLibraries();
    expect(await visibleLoans(actor("member", "lib-1", "family-a"))).toEqual(["loan-a"]);
    expect(await visibleLoans(actor("member", "lib-1", "family-b"))).toEqual(["loan-b"]);
    expect(await visibleLoans(actor("member", "lib-1", null))).toEqual([]);
    expect(await visibleLoans(actor("staff", "lib-1", null))).toEqual(["loan-a", "loan-b"]);
  });

  it("keep 'my loans' to my own family, even for staff", async () => {
    await seedTwoLibraries();
    expect(await ownLoans(actor("staff", "lib-1", "family-b"))).toEqual(["loan-b"]);
    expect(await ownLoans(actor("admin", "lib-1", null))).toEqual([]);
  });

  it("stamp the actor's library on inserts", () => {
    expect(scope(actor("staff", "lib-2")).values({ name: "x" })).toEqual({
      name: "x",
      libraryId: "lib-2",
    });
  });
});

/*
 * Every API route, with who may call it. The coverage test below fails when a
 * route exists without an entry here, so a new route cannot skip this check.
 *
 * - public: anyone, signed in or not
 * - user: anyone signed in
 * - member: any member of the library
 * - borrower: a member of an active family
 * - a Permission: the roles in PERMISSIONS
 */
export type RouteRule = "public" | "user" | "owner" | "member" | "borrower" | Permission;

export const ROUTES: {
  route: `${"GET" | "POST" | "PATCH" | "PUT" | "DELETE"} /api/${string}`;
  rule: RouteRule;
  /** The concrete path to call, when the route has parameters. */
  request?: string;
  body?: unknown;
}[] = [
  { route: "GET /api/health", rule: "public" },
  { route: "GET /api/me", rule: "public" },
  { route: "GET /api/auth/*", rule: "public", request: "/api/auth/get-session" },
  { route: "POST /api/auth/*", rule: "public", request: "/api/auth/sign-out", body: {} },
  { route: "POST /api/setup", rule: "user", body: { libraryName: "X", timezone: "UTC" } },
  {
    route: "GET /api/catalog/lookup/:isbn",
    rule: "catalog:edit",
    request: "/api/catalog/lookup/9780140328721",
  },
  { route: "GET /api/catalog/titles", rule: "catalog:edit" },
  { route: "POST /api/catalog/titles", rule: "catalog:edit", body: { title: "A book" } },
  {
    route: "GET /api/catalog/titles/:id",
    rule: "catalog:edit",
    request: "/api/catalog/titles/missing",
  },
  {
    route: "PATCH /api/catalog/titles/:id",
    rule: "catalog:edit",
    request: "/api/catalog/titles/missing",
    body: {},
  },
  {
    route: "POST /api/catalog/titles/:id/copies",
    rule: "catalog:edit",
    request: "/api/catalog/titles/missing/copies",
    body: { count: 1 },
  },
  {
    route: "PATCH /api/catalog/copies/:id",
    rule: "catalog:edit",
    request: "/api/catalog/copies/missing",
    body: {},
  },
  { route: "GET /api/catalog/labels", rule: "catalog:edit" },
  {
    route: "POST /api/catalog/labels/printed",
    rule: "catalog:edit",
    body: { copyIds: ["missing"] },
  },
  {
    route: "GET /api/copies/:code",
    rule: "member",
    request: "/api/copies/ZZZZ",
  },
  {
    route: "POST /api/copies/:code/borrow",
    rule: "borrower",
    request: "/api/copies/ZZZZ/borrow",
    body: {},
  },
  {
    route: "POST /api/copies/:code/return",
    rule: "loans:own",
    request: "/api/copies/ZZZZ/return",
    body: {},
  },
  {
    route: "POST /api/copies/:code/found",
    rule: "copies:report-found",
    request: "/api/copies/ZZZZ/found",
    body: {},
  },
  { route: "GET /api/loans/mine", rule: "member" },
  {
    route: "POST /api/loans/:id/extend",
    rule: "loans:own",
    request: "/api/loans/missing/extend",
    body: {},
  },
  { route: "GET /api/admin/dashboard", rule: "loans:manage" },
  { route: "GET /api/admin/loans", rule: "loans:manage" },
  {
    route: "POST /api/admin/loans/:id/close",
    rule: "loans:manage",
    request: "/api/admin/loans/missing/close",
    body: { outcome: "returned" },
  },
  {
    route: "POST /api/admin/loans/remind",
    rule: "loans:manage",
    body: { loanIds: ["missing"] },
  },
  {
    route: "POST /api/admin/loans/:id/remind",
    rule: "loans:manage",
    request: "/api/admin/loans/missing/remind",
    body: {},
  },
  { route: "GET /api/admin/settings", rule: "library:admin" },
  { route: "POST /api/admin/welcome", rule: "library:admin", body: {} },
  // The site's owner only: nobody else can create or change libraries.
  { route: "GET /api/owner/libraries", rule: "owner" },
  { route: "POST /api/owner/libraries", rule: "owner", body: {} },
  {
    route: "PATCH /api/owner/libraries/:id",
    rule: "owner",
    request: "/api/owner/libraries/lib-1",
    body: {},
  },
  {
    route: "POST /api/owner/libraries/:id/admin-invite",
    rule: "owner",
    request: "/api/owner/libraries/lib-1/admin-invite",
    body: {},
  },
  { route: "PATCH /api/admin/settings", rule: "library:admin", body: {} },
  { route: "POST /api/reminders-off", rule: "public", body: { f: "x", t: "y" } },
  { route: "GET /api/family/reminders", rule: "loans:own" },
  { route: "PUT /api/family/reminders", rule: "loans:own", body: { on: true } },
  { route: "GET /api/join/:token", rule: "public", request: "/api/join/x" },
  { route: "POST /api/join", rule: "user", body: { token: "x", familyName: "X" } },
  { route: "GET /api/invites/:token", rule: "public", request: "/api/invites/x" },
  { route: "POST /api/invites/accept", rule: "user", body: { token: "x" } },
  { route: "GET /api/admin/families", rule: "families:manage" },
  {
    route: "POST /api/admin/families/:id/status",
    rule: "families:manage",
    request: "/api/admin/families/missing/status",
    body: { status: "active" },
  },
  {
    route: "POST /api/admin/families/:id/invite",
    rule: "families:manage",
    request: "/api/admin/families/missing/invite",
    body: { email: "new@example.com" },
  },
  {
    route: "POST /api/admin/staff/:userId/role",
    rule: "library:admin",
    request: "/api/admin/staff/missing/role",
    body: { role: "staff" },
  },
  {
    route: "POST /api/admin/staff/invite",
    rule: "library:admin",
    body: { email: "x@example", role: "staff" },
  },
  {
    route: "POST /api/admin/invites/:id/resend",
    rule: "families:manage",
    request: "/api/admin/invites/missing/resend",
    body: {},
  },
  {
    route: "DELETE /api/admin/invites/:id",
    rule: "families:manage",
    request: "/api/admin/invites/missing",
  },
  { route: "POST /api/admin/import/preview", rule: "families:manage", body: { csv: "" } },
  { route: "POST /api/admin/import", rule: "families:manage", body: { csv: "" } },
  {
    route: "POST /api/admin/families/:id/remove",
    rule: "families:manage",
    request: "/api/admin/families/missing/remove",
    body: {},
  },
  { route: "POST /api/admin/join-link", rule: "library:admin", body: { enabled: "no" } },
  // Any signed-in person may start deleting their own account; a code is needed to finish.
  { route: "POST /api/account/delete/start", rule: "user", body: {} },
  { route: "POST /api/account/delete/confirm", rule: "user", body: { code: "abc" } },
];

type Who = "signedOut" | "nonMember" | "pendingMember" | "member" | "staff" | "admin";

/** The status class each kind of person should get for a rule. */
// Book pages answer members of other libraries with "not found" instead; see
// routes/libraries.test.ts. The non-member here belongs to no library at all.
function expectedFor(rule: RouteRule, who: Who): "allowed" | 401 | 403 {
  if (rule === "public") return "allowed";
  if (who === "signedOut") return 401;
  if (rule === "user") return "allowed";
  // None of the people here own the site; routes/owner.test.ts covers the owner.
  if (rule === "owner") return 403;
  if (who === "nonMember") return 403;
  if (rule === "member") return "allowed";
  if (rule === "borrower") return who === "member" ? "allowed" : 403;
  const role: Role = who === "pendingMember" ? "member" : who;
  return allow({ role }, rule) ? "allowed" : 403;
}

describe("route access", () => {
  it("covers every route the app serves", () => {
    const served = new Set(
      ctx.app.routes
        .filter((r) => r.method !== "ALL") // middleware
        .map((r) => `${r.method} ${r.path}`),
    );
    const listed = new Set(ROUTES.map((r) => r.route));
    expect(
      [...served].filter((r) => !listed.has(r as never)),
      "routes with no access rule",
    ).toEqual([]);
    expect(
      [...listed].filter((r) => !served.has(r)),
      "rules for routes that do not exist",
    ).toEqual([]);
  });

  async function people(): Promise<Record<Who, TestClient>> {
    await createLibrary(env);
    return {
      signedOut: new TestClient(ctx, "nobody@example.com"),
      nonMember: await person(ctx, { role: "none" }),
      pendingMember: await person(ctx, { role: "member", familyStatus: "pending" }),
      member: await person(ctx, { role: "member" }),
      staff: await person(ctx, { role: "staff" }),
      admin: await person(ctx, { role: "admin" }),
    };
  }

  it("fixtures sign people in with the right role", async () => {
    const all = await people();
    const role = async (who: Who) =>
      (await all[who].json<{ membership: { role: string } | null }>("/api/me")).body.membership
        ?.role ?? null;
    expect(await role("nonMember")).toBeNull();
    expect(await role("member")).toBe("member");
    expect(await role("staff")).toBe("staff");
    expect(await role("admin")).toBe("admin");
  });

  it.each(ROUTES.map((r) => [r.route, r] as const))("%s", async (_name, rule) => {
    const all = await people();
    for (const who of Object.keys(all) as Who[]) {
      const [method, path] = rule.route.split(" ") as [string, string];
      const res = await all[who].request(rule.request ?? path, {
        method,
        ...(rule.body === undefined ? {} : { body: rule.body }),
      });
      const want = expectedFor(rule.rule, who);
      if (want === "allowed") {
        expect(res.status, `${who} should be allowed`).not.toBe(401);
        expect(res.status, `${who} should be allowed`).not.toBe(403);
        expect(res.status, `${who} should not crash`).toBeLessThan(500);
      } else {
        expect(res.status, `${who} should get ${want}`).toBe(want);
      }
    }
  });
});
