import { and, eq, type SQL, sql } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { type AppContext, fail, requireUser } from "./context.ts";
import { schema } from "./db/client.ts";
import type { FamilyStatus, Role } from "./db/schema.ts";
import { type LibraryInfo, libraryById } from "./library.ts";

/*
 * The access layer. D1 has no row-level security, so this module is the one
 * place that decides who may do what:
 *
 * 1. Routes start with `requirePermission(c, …)` (or `requireBorrower(c)`),
 *    which works out who is calling and refuses them if they may not.
 * 2. Every query on library data goes through `scope(actor)`: its `where`
 *    always adds the library filter, `values` stamps the library id on inserts,
 *    and family filters are explicit (`ownFamily` vs `familiesVisible`).
 *
 * access.test.ts lists every API route with its rule and fails when a route is
 * added without one.
 */

export interface Actor {
  userId: string;
  email: string;
  library: LibraryInfo;
  role: Role;
  family: { id: string; name: string; status: FamilyStatus } | null;
  /** The platform owner, in a library they don't belong to, for support. */
  support?: true;
}

// Asked several times in one request, so the answer is kept per request.
const ownerChecks = new WeakMap<Request, Promise<boolean>>();
const supportLogged = new WeakMap<Request, Set<string>>();

/** True when the signed-in person runs the whole site (see platform_admins). */
export function isPlatformOwner(c: AppContext): Promise<boolean> {
  const user = c.get("user");
  if (!user) return Promise.resolve(false);
  const cached = ownerChecks.get(c.req.raw);
  if (cached) return cached;
  const check = c.env.DB.prepare("select 1 from platform_admins where user_id = ?")
    .bind(user.id)
    .first()
    .then((row) => row !== null);
  ownerChecks.set(c.req.raw, check);
  return check;
}

/** Signed in and the platform owner. Fails with 401 or 403. */
export async function requireOwner(c: AppContext): Promise<{ userId: string }> {
  const user = requireUser(c);
  if (!(await isPlatformOwner(c))) {
    fail(403, "forbidden", "This is only for the person who runs this site.");
  }
  return { userId: user.id };
}

/**
 * The owner opening a library they don't belong to acts as its admin, for
 * support. Each day's first visit is logged in the library's events, and
 * its admins see these in Settings.
 */
async function supportActor(c: AppContext, library: LibraryInfo): Promise<Actor | null> {
  const user = c.get("user");
  if (!user || !(await isPlatformOwner(c))) return null;
  const logged = supportLogged.get(c.req.raw) ?? new Set<string>();
  supportLogged.set(c.req.raw, logged);
  if (!logged.has(library.id)) {
    logged.add(library.id);
    const day = new Date().toISOString().slice(0, 10);
    // No log, no access: if the visit can't be recorded, the request fails.
    await c.env.DB.prepare(
      `insert into events (id, library_id, actor_user_id, type, payload)
       values (?, ?, ?, 'owner_access', json_object('day', ?)) on conflict (id) do nothing`,
    )
      .bind(`owner-access:${library.id}:${user.id}:${day}`, library.id, user.id, day)
      .run();
  }
  return {
    userId: user.id,
    email: user.email,
    library,
    role: "admin",
    family: null,
    support: true,
  };
}

export const PERMISSIONS = {
  /** See your own family's loans; return your own books. */
  "loans:own": ["member", "staff", "admin"],
  /** Tap "Found it" on a stray book. Staff confirm it later. */
  "copies:report-found": ["member", "staff", "admin"],
  /** See every loan, mark returned/lost, extend, bulk return, confirm "found". */
  "loans:manage": ["staff", "admin"],
  /** Add and edit titles and copies, print labels. */
  "catalog:edit": ["staff", "admin"],
  /** See and change families, invite parents, approve sign-ups. */
  "families:manage": ["staff", "admin"],
  /** Change library settings, invite staff, replace the sign-up link, export data. */
  "library:admin": ["admin"],
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

export function allow(actor: Pick<Actor, "role">, permission: Permission): boolean {
  return (PERMISSIONS[permission] as readonly Role[]).includes(actor.role);
}

/** Staff may invite parents; only admins may make someone staff or admin. */
export function canGrantRole(actor: Pick<Actor, "role">, role: Role): boolean {
  if (role === "member") return allow(actor, "families:manage");
  return allow(actor, "library:admin");
}

/** The signed-in person's membership of this library, or null if they have none. */
export async function actorFor(c: AppContext): Promise<Actor | null> {
  const library = c.get("library");
  return library ? actorIn(c, library) : null;
}

/**
 * The signed-in person's own membership of this library, or null. Unlike
 * `actorFor`, the site owner's support access doesn't count: use this when
 * the question is "have they joined?" (sign-up links, invites).
 */
export async function memberFor(c: AppContext): Promise<Actor | null> {
  const actor = await actorFor(c);
  return actor?.support ? null : actor;
}

/**
 * The signed-in person as a member of every library they belong to. For
 * site-wide actions on the person themself, such as deleting their account.
 */
export async function actorsForUser(c: AppContext): Promise<Actor[]> {
  const user = c.get("user");
  if (!user) return [];
  const rows = await c
    .get("db")
    .select({ libraryId: schema.memberships.libraryId })
    .from(schema.memberships)
    .where(eq(schema.memberships.userId, user.id))
    .all();
  const actors: Actor[] = [];
  for (const row of rows) {
    const library = await libraryById(c.get("db"), row.libraryId);
    const actor = library ? await actorIn(c, library) : null;
    if (actor) actors.push(actor);
  }
  return actors;
}

async function actorIn(c: AppContext, library: LibraryInfo): Promise<Actor | null> {
  const user = c.get("user");
  if (!user) return null;
  const row = await c
    .get("db")
    .select({
      role: schema.memberships.role,
      familyId: schema.families.id,
      familyName: schema.families.name,
      familyStatus: schema.families.status,
    })
    .from(schema.memberships)
    .leftJoin(
      schema.families,
      and(
        eq(schema.families.id, schema.memberships.familyId),
        eq(schema.families.libraryId, schema.memberships.libraryId),
      ),
    )
    .where(
      and(eq(schema.memberships.libraryId, library.id), eq(schema.memberships.userId, user.id)),
    )
    .get();
  if (!row) return supportActor(c, library);
  return {
    userId: user.id,
    email: user.email,
    library,
    role: row.role,
    family:
      row.familyId && row.familyName && row.familyStatus
        ? { id: row.familyId, name: row.familyName, status: row.familyStatus }
        : null,
  };
}

const REFUSALS: Record<Permission, string> = {
  "loans:own": "Only members of this library can do that.",
  "copies:report-found": "Only members of this library can do that.",
  "loans:manage": "This is only for library staff. If you need it, ask the library admin.",
  "catalog:edit": "This is only for library staff. If you need it, ask the library admin.",
  "families:manage": "This is only for library staff. If you need it, ask the library admin.",
  "library:admin": "This is only for the library admin.",
};

/** Signed in, and a member of this library with any role. Fails with 401 or 403. */
export async function requireMember(c: AppContext): Promise<Actor> {
  requireUser(c);
  const actor = await actorFor(c);
  if (!actor) {
    fail(
      403,
      "not_a_member",
      "You're signed in, but you haven't joined this library yet. Ask the library staff for the sign-up link or an invite.",
    );
  }
  return actor;
}

/** Fails with 401 when signed out and 403 without the permission. */
export async function requirePermission(c: AppContext, permission: Permission): Promise<Actor> {
  const actor = await requireMember(c);
  if (!allow(actor, permission)) fail(403, "forbidden", REFUSALS[permission]);
  return actor;
}

/**
 * For borrowing: a member of an active family. Staff without a family can
 * still manage loans, but cannot borrow.
 */
export async function requireBorrower(
  c: AppContext,
): Promise<Actor & { family: NonNullable<Actor["family"]> }> {
  const actor = await requirePermission(c, "loans:own");
  const family = actor.family;
  if (!family) {
    if (actor.role === "member") {
      fail(
        403,
        "no_family",
        "Your sign-in isn't connected to a family yet, so you can't borrow. Ask staff to add you to your family.",
      );
    }
    fail(
      403,
      "no_family",
      "You're signed in as staff without a family, so you can't borrow. You can still manage loans.",
    );
  }
  if (family.status === "pending") {
    fail(
      403,
      "family_pending",
      "Your family is waiting for staff approval. You can borrow once they approve it. Ask staff if it's taking a while.",
    );
  }
  if (family.status !== "active") {
    fail(
      403,
      "family_inactive",
      "Your family's library membership is paused, so you can't borrow right now. Please ask the library staff.",
    );
  }
  return { ...actor, family };
}

/** True when the actor may act on loans of `familyId`: their own family, or any family for staff. */
export function canActOnFamily(actor: Actor, familyId: string | null): boolean {
  if (allow(actor, "loans:manage")) return true;
  return familyId !== null && actor.family?.id === familyId;
}

/** A condition that is never true, for "this person may see nothing". */
const NOTHING = sql`0`;

type LibraryTable = { libraryId: SQLiteColumn };

/**
 * Query helpers bound to one actor's library. Use these for every query on
 * library data, so the library filter cannot be forgotten.
 */
export function scope(actor: Actor) {
  const libraryId = actor.library.id;
  return {
    libraryId,
    /** `library_id = <actor's library>` AND any extra conditions. */
    where(table: LibraryTable, ...conditions: (SQL | undefined)[]): SQL {
      return and(eq(table.libraryId, libraryId), ...conditions) as SQL;
    },
    /** Insert values with the actor's library id stamped on. */
    values<T extends object>(values: T): T & { libraryId: string } {
      return { ...values, libraryId };
    },
    /** Rows of the actor's own family only, whatever their role. Nothing if they have no family. */
    ownFamily(column: SQLiteColumn): SQL {
      return actor.family ? eq(column, actor.family.id) : NOTHING;
    },
    /**
     * The families this actor may see: every family for staff and admins,
     * only their own for members.
     */
    familiesVisible(column: SQLiteColumn): SQL | undefined {
      return allow(actor, "loans:manage") ? undefined : this.ownFamily(column);
    },
  };
}
