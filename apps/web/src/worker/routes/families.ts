import { isEmail, localParts, readInvites } from "@community-library/core";
import { Hono } from "hono";
import { z } from "zod";
import {
  type Actor,
  actorsForUser,
  canGrantRole,
  isPlatformOwner,
  memberFor,
  requireBorrower,
  requirePermission,
} from "../access.ts";
import { authSecret } from "../config.ts";
import { type AppContext, type AppEnv, fail, readBody, requireUser } from "../context.ts";
import { hmacHex, randomToken, sha256Hex, timingSafeEqual } from "../crypto.ts";
import { newId } from "../db/client.ts";
import { approvedEmail, deleteCodeEmail, goodbyeEmail, inviteEmail } from "../email.ts";
import { libraryById, libraryHome } from "../library.ts";
import { consume } from "../limiter.ts";
import type { Priority, QuotaMailer } from "../mailer.ts";
import { firstNameField, name } from "./account.ts";

/*
 * How families join (a sign-up link or QR code, or an invite from a CSV
 * import or from staff), how staff look after families, and how a parent
 * deletes their account.
 */

const INVITE_DAYS = 14;
const MAX_IMPORT_ROWS = 500;
/** Invites sent straight away after an import; the rest go out with the hourly job. */
const SEND_NOW = 20;

export const emailField = z
  .string({ error: "Enter an email address." })
  .trim()
  .toLowerCase()
  .max(254)
  .refine(isEmail, "Enter a valid email address, for example name@example.com.");

// ------------------------------------------------------------- sign-up link

/** The sign-up token for a library: derived from a stored random value and the server secret. */
async function joinTokenFor(env: Env, nonce: string) {
  return (await hmacHex(authSecret(env), `join:${nonce}`)).slice(0, 32);
}

async function joinUrl(c: AppContext, nonce: string | null) {
  return nonce ? `${c.get("origin")}/join/${await joinTokenFor(c.env, nonce)}` : null;
}

/**
 * The library a sign-up link belongs to: the token's hash is stored on its
 * library, so a printed poster finds its library on the shared site. The
 * request then acts for that library.
 */
async function libraryForJoinToken(c: AppContext, token: string) {
  if (!/^[0-9a-f]{32}$/.test(token)) return null;
  const row = await c.env.DB.prepare("select id from libraries where join_token_hash = ?")
    .bind(await sha256Hex(token))
    .first<{ id: string }>();
  const library = row ? await libraryById(c.get("db"), row.id) : null;
  if (library) c.set("library", library);
  return library;
}

// ------------------------------------------------------------------ invites

/** Sends one invite: a fresh token is made now, so tokens never wait unsent in the database. */
export async function sendInvite(
  c: { env: Env; email: Pick<QuotaMailer, "send">; origin: string },
  invite: {
    id: string;
    email: string;
    role: "member" | "staff" | "admin";
    familyName: string | null;
    /** The first admin of a new library: the email explains how to get it running. */
    firstAdmin?: boolean;
  },
  library: { id: string; name: string; settings: { timezone: string } },
  priority: Priority,
  /** A resend replaces an earlier link; otherwise only a never-sent invite is claimed. */
  resend = false,
): Promise<boolean> {
  const token = randomToken();
  const expiresAt = Date.now() + INVITE_DAYS * 86_400_000;
  // Claim it: only one sender can switch it from unsent to sent.
  const claimed = await c.env.DB.prepare(
    `update invitations set token_hash = ?, expires_at = ?, sent_at = ?
     where id = ? and library_id = ? and accepted_at is null and ${resend ? "1" : "sent_at is null"}
     returning id`,
  )
    .bind(await sha256Hex(token), expiresAt, Date.now(), invite.id, library.id)
    .first();
  if (!claimed) return false;
  let ok = false;
  try {
    const result = await c.email.send(
      inviteEmail({
        libraryName: library.name,
        to: invite.email,
        url: `${c.origin}/invite/${token}`,
        familyName: invite.familyName,
        role: invite.role,
        expiresOn: localParts(new Date(expiresAt), library.settings.timezone).date,
        firstAdmin: invite.firstAdmin === true,
      }),
      priority,
    );
    ok = result.ok;
  } catch (error) {
    console.error("Invite email failed:", error);
  }
  if (!ok) {
    await c.env.DB.prepare(
      "update invitations set sent_at = null where id = ? and accepted_at is null",
    )
      .bind(invite.id)
      .run();
  }
  return ok;
}

/** Unsent invites (from an import), oldest first. */
export async function unsentInvites(DB: D1Database, libraryId: string, limit: number) {
  const { results } = await DB.prepare(
    `select i.id as id, i.email as email, i.role as role, f.name as familyName
     from invitations i left join families f on f.id = i.family_id and f.library_id = i.library_id
     where i.library_id = ? and i.sent_at is null and i.accepted_at is null and i.email is not null
     order by i.created_at limit ?`,
  )
    .bind(libraryId, limit)
    .all<{
      id: string;
      email: string;
      role: "member" | "staff" | "admin";
      familyName: string | null;
    }>();
  return results;
}

/** An invite by its token. The invite names its library, and the request then acts for it. */
async function inviteByToken(c: AppContext, token: string) {
  if (token.length < 20 || token.length > 100) return null;
  const found = await c.env.DB.prepare(
    "select library_id as libraryId from invitations where token_hash = ?",
  )
    .bind(await sha256Hex(token))
    .first<{ libraryId: string }>();
  const library = found ? await libraryById(c.get("db"), found.libraryId) : null;
  if (!library) return null;
  c.set("library", library);
  return c.env.DB.prepare(
    `select i.id as id, i.email as email, i.role as role, i.family_id as familyId, i.expires_at as expiresAt,
            i.accepted_at as acceptedAt, f.name as familyName
     from invitations i left join families f on f.id = i.family_id and f.library_id = i.library_id
     where i.token_hash = ? and i.library_id = ?`,
  )
    .bind(await sha256Hex(token), library.id)
    .first<{
      id: string;
      email: string | null;
      role: "member" | "staff" | "admin";
      familyId: string | null;
      expiresAt: number;
      acceptedAt: number | null;
      familyName: string | null;
    }>();
}

function setFirstName(DB: D1Database, userId: string, firstName: string) {
  return DB.prepare("update users set name = ?, updated_at = ? where id = ?").bind(
    firstName,
    Date.now(),
    userId,
  );
}

export function event(
  DB: D1Database,
  libraryId: string,
  actorUserId: string | null,
  type: string,
  payload: object,
) {
  return DB.prepare(
    "insert into events (id, library_id, actor_user_id, type, payload) values (?, ?, ?, ?, ?)",
  ).bind(newId(), libraryId, actorUserId, type, JSON.stringify(payload));
}

// --------------------------------------------------------------- deletion

/** Joining a paused library has to wait, whichever link or invite leads to it. */
function refuseIfPaused(library: { status: "active" | "paused" }) {
  if (library.status === "paused") {
    fail(
      403,
      "library_paused",
      "This library is paused, so nobody can join right now. Please ask the library staff.",
    );
  }
}

/**
 * Why the person's account can't be deleted yet, across every library they
 * belong to: books still out, or being some library's only admin. The site's
 * only owner can't delete theirs either: the site would be left ownerless.
 */
async function accountBlockers(c: AppContext) {
  const actors = await actorsForUser(c);
  const each = await Promise.all(actors.map((actor) => deletionBlockers(c, actor)));
  const otherOwners = (await isPlatformOwner(c))
    ? await c.env.DB.prepare("select count(*) as n from platform_admins where user_id != ?")
        .bind(c.get("user")?.id ?? "")
        .first<number>("n")
    : 1;
  return {
    actors,
    each,
    lastOwner: (otherOwners ?? 0) === 0,
    books: each.flatMap((b) => b.books),
    lastAdmin: each.some((b) => b.lastAdmin),
    lastParent: each.some((b) => b.lastParent),
  };
}

/** Why the actor's account can't be deleted yet in one library. */
async function deletionBlockers(c: AppContext, actor: Actor | null) {
  if (!actor) return { books: [], lastAdmin: false, lastParent: false };
  const DB = c.env.DB;
  const lib = actor.library.id;
  const counts = await DB.prepare(
    `select (select count(*) from memberships where library_id = ?1 and role = 'admin' and user_id != ?2) as otherAdmins,
            (select count(*) from memberships where library_id = ?1 and family_id = ?3 and user_id != ?2)
              + (select count(*) from kiosk_people where library_id = ?1 and family_id = ?3 and user_id is null) as otherParents`,
  )
    .bind(lib, actor.userId, actor.family?.id ?? null)
    .first<{ otherAdmins: number; otherParents: number }>();
  const lastParent = actor.family !== null && (counts?.otherParents ?? 0) === 0;
  const books = lastParent
    ? (
        await DB.prepare(
          `select t.title as title, l.due_on as dueOn from loans l
           join copies c on c.id = l.copy_id and c.library_id = l.library_id
           join titles t on t.id = c.title_id and t.library_id = c.library_id
           where l.library_id = ? and l.family_id = ? and l.returned_at is null order by l.due_on`,
        )
          .bind(lib, actor.family?.id ?? null)
          .all<{ title: string; dueOn: string }>()
      ).results
    : [];
  return {
    books,
    lastAdmin: actor.role === "admin" && (counts?.otherAdmins ?? 0) === 0,
    lastParent,
  };
}

/**
 * Statements that remove a family: its loan history keeps its counts but
 * loses the family, events lose the family id, then its parents'
 * memberships and the family itself are deleted (invites go with it).
 */
function removeFamilyStatements(DB: D1Database, libraryId: string, familyId: string) {
  return [
    // Only closed loans lose the family. An open loan (borrowed a moment ago)
    // keeps it, so the family delete below fails and nothing is changed.
    DB.prepare(
      "update loans set family_id = null, kiosk_person_id = null where library_id = ? and family_id = ? and returned_at is not null",
    ).bind(libraryId, familyId),
    DB.prepare(
      `update events set payload = json_remove(payload, '$.familyId')
       where library_id = ? and json_extract(payload, '$.familyId') = ?`,
    ).bind(libraryId, familyId),
    // Staff and admins in the family keep their role; they just leave the family.
    DB.prepare(
      "update memberships set family_id = null where library_id = ? and family_id = ? and role != 'member'",
    ).bind(libraryId, familyId),
    // Parents whose only membership was this family: their sign-in and email go too.
    DB.prepare(
      `delete from users where id in (
         select m.user_id from memberships m
         where m.library_id = ? and m.family_id = ? and m.role = 'member'
           and (select count(*) from memberships m2 where m2.user_id = m.user_id) = 1
           and m.user_id not in (select user_id from platform_admins))`,
    ).bind(libraryId, familyId),
    DB.prepare(
      "delete from memberships where library_id = ? and family_id = ? and role = 'member'",
    ).bind(libraryId, familyId),
    DB.prepare("delete from families where library_id = ? and id = ?").bind(libraryId, familyId),
  ];
}

/** True for the foreign-key error raised when a family still has an open loan. */
function isOpenLoanConflict(error: unknown) {
  return /FOREIGN KEY/i.test(String(error));
}

const DELETE_CODE_MINUTES = 10;

export const familyRoutes = new Hono<AppEnv>()
  // ------------------------------------------------ joining (public / signed in)

  /** What a sign-up link leads to. */
  .get("/join/:token", async (c) => {
    const library = await libraryForJoinToken(c, c.req.param("token"));
    if (!library) {
      fail(
        404,
        "bad_link",
        "This sign-up link is no longer valid. Ask the library staff for the current one.",
      );
    }
    return c.json({
      library: { name: library.name, slug: library.slug },
      requireApproval: library.settings.requireApproval,
    });
  })

  /** Join the library as a new family with a sign-up link (after signing in with a code). */
  .post("/join", async (c) => {
    const user = requireUser(c);
    const body = await readBody(
      c,
      z.object({
        token: z.string().max(100),
        familyName: name("Family name", 60),
        firstName: firstNameField,
      }),
    );
    const library = await libraryForJoinToken(c, body.token);
    if (!library) {
      fail(
        404,
        "bad_link",
        "This sign-up link is no longer valid. Ask the library staff for the current one.",
      );
    }
    refuseIfPaused(library);
    if (await memberFor(c)) fail(409, "already_member", "You're already a member of this library.");
    const DB = c.env.DB;
    const familyId = newId();
    const status = library.settings.requireApproval ? "pending" : "active";
    await DB.batch([
      DB.prepare("insert into families (id, library_id, name, status) values (?, ?, ?, ?)").bind(
        familyId,
        library.id,
        body.familyName,
        status,
      ),
      DB.prepare(
        "insert into memberships (id, library_id, user_id, role, family_id) values (?, ?, ?, 'member', ?)",
      ).bind(newId(), library.id, user.id, familyId),
      setFirstName(DB, user.id, body.firstName),
      event(DB, library.id, user.id, "family_joined", { familyId, via: "link", status }),
    ]);
    return c.json({ status }, 201);
  })

  /** What an invite link leads to (the invited address is shown so people sign in with it). */
  .get("/invites/:token", async (c) => {
    const invite = await inviteByToken(c, c.req.param("token"));
    if (!invite || invite.acceptedAt || !invite.email) {
      fail(
        404,
        "bad_invite",
        "This invitation has already been used or replaced. Ask the library staff for a new one.",
      );
    }
    if (invite.expiresAt < Date.now()) {
      fail(
        410,
        "invite_expired",
        "This invitation has expired. Ask the library staff to send a new one.",
      );
    }
    return c.json({
      library: { name: c.get("library")?.name, slug: c.get("library")?.slug },
      email: invite.email,
      familyName: invite.familyName,
      role: invite.role,
    });
  })

  /** Accept an invite. The signed-in address must be the invited one. */
  .post("/invites/accept", async (c) => {
    const user = requireUser(c);
    const body = await readBody(
      c,
      z.object({ token: z.string().max(100), firstName: firstNameField.optional() }),
    );
    if (!body.firstName && !user.name?.trim()) {
      fail(422, "invalid_input", "First name is required.");
    }
    const invite = await inviteByToken(c, body.token);
    const library = c.get("library");
    if (!invite || !library || invite.acceptedAt || !invite.email) {
      fail(
        404,
        "bad_invite",
        "This invitation has already been used or replaced. Ask the library staff for a new one.",
      );
    }
    if (invite.expiresAt < Date.now()) {
      fail(
        410,
        "invite_expired",
        "This invitation has expired. Ask the library staff to send a new one.",
      );
    }
    if (invite.email !== user.email.toLowerCase()) {
      fail(
        403,
        "wrong_email",
        `This invitation is for ${invite.email}. Sign out, then sign in with that address.`,
      );
    }
    const DB = c.env.DB;
    refuseIfPaused(library);
    const existing = await memberFor(c);
    if (existing && (existing.family || !invite.familyId) && existing.role !== "member") {
      if (invite.role === "member" && !existing.family && invite.familyId) {
        // Staff joining their own family: keep their role, add the family.
      } else fail(409, "already_member", "You're already a member of this library.");
    } else if (existing?.family) {
      fail(
        409,
        "already_member",
        "You're already a member of this library, in another family. Ask staff to sort it out.",
      );
    }
    // The membership change only happens if this exact link is still open, and
    // the invite is closed in the same transaction, so a link is used once.
    const tokenHash = await sha256Hex(body.token);
    const stillOpen =
      "exists (select 1 from invitations where id = ? and token_hash = ? and accepted_at is null and expires_at > ?)";
    const now = Date.now();
    const membership = existing
      ? DB.prepare(
          `update memberships set family_id = ?, role = case when role = 'member' then ? else role end
           where library_id = ? and user_id = ? and ${stillOpen}`,
        ).bind(invite.familyId, invite.role, library.id, user.id, invite.id, tokenHash, now)
      : DB.prepare(
          `insert into memberships (id, library_id, user_id, role, family_id)
           select ?, ?, ?, ?, ? where ${stillOpen}`,
        ).bind(
          newId(),
          library.id,
          user.id,
          invite.role,
          invite.familyId,
          invite.id,
          tokenHash,
          now,
        );
    const [changed] = await DB.batch([
      membership,
      DB.prepare(
        "update invitations set accepted_at = ?, email = null where id = ? and token_hash = ? and accepted_at is null",
      ).bind(now, invite.id, tokenHash),
      event(DB, library.id, user.id, "invite_accepted", {
        familyId: invite.familyId,
        role: invite.role,
      }),
    ]);
    if (changed?.meta.changes !== 1)
      fail(409, "bad_invite", "This invitation was just used or replaced.");
    // Only once the invitation is really accepted.
    if (body.firstName) await setFirstName(DB, user.id, body.firstName).run();
    return c.json({ ok: true });
  })

  // ------------------------------------------------------ your family

  /** Your family: the adults in it and anyone invited to join it. */
  .get("/family", async (c) => {
    const actor = await requireFamily(c);
    const DB = c.env.DB;
    const [adults, invites] = await Promise.all([
      DB.prepare(
        `select u.id as userId, u.name as name, u.email as email from memberships m
         join users u on u.id = m.user_id where m.library_id = ? and m.family_id = ?
         order by m.created_at`,
      )
        .bind(actor.library.id, actor.family.id)
        .all<{ userId: string; name: string; email: string }>(),
      openFamilyInvites(DB, actor.library.id, actor.family.id),
    ]);
    const now = Date.now();
    return c.json({
      family: { name: actor.family.name, status: actor.family.status },
      adults: adults.results.map((a) => ({
        name: a.name,
        email: a.email,
        you: a.userId === actor.userId,
      })),
      invites: invites.map((i) => ({
        id: i.id,
        email: i.email,
        state: i.sentAt === null ? "queued" : i.expiresAt < now ? "expired" : "sent",
      })),
    });
  })

  /**
   * Invite another adult into your family (a partner, a grandparent), so
   * you share one list of books instead of the library having two families.
   */
  .post("/family/invite", async (c) => {
    // Only an approved, active family can bring someone in.
    const actor = await requireBorrower(c);
    const body = await readBody(c, z.object({ email: emailField }));
    const DB = c.env.DB;
    const lib = actor.library.id;
    // Budget first, so the answers below can't be used to test address after
    // address. Parents get a small budget of their own, so they can't use up
    // the invitations the library's staff need.
    const secret = authSecret(c.env);
    for (const [key, rule] of [
      [`family-invites:${actor.family.id}`, { window: 86_400, max: 5 }],
      [`family-invites-library:${lib}`, { window: 86_400, max: 30 }],
    ] as const) {
      if (!(await consume(DB, secret, key, rule)).allowed) {
        fail(
          429,
          "too_many_invites",
          "That's a lot of invitations for today. Please try again tomorrow.",
        );
      }
    }
    await assertInviteBudget(c, lib, actor.userId);
    await assertNotMember(c, actor, body.email, true);
    const id = newId();
    const now = Date.now();
    // One statement: the cap and the one-invite-per-address rule hold even
    // when two requests arrive together.
    const [inserted] = await DB.batch([
      DB.prepare(
        `insert into invitations (id, library_id, family_id, email, role, token_hash, expires_at)
         select ?1, ?2, ?3, ?4, 'member', ?5, 0
         where (select count(*) from invitations where library_id = ?2 and family_id = ?3
                  and accepted_at is null and email is not null and (sent_at is null or expires_at > ?6)) < ?7
           and not exists (select 1 from invitations where library_id = ?2 and lower(email) = ?4
                  and accepted_at is null and (sent_at is null or expires_at > ?6))`,
      ).bind(id, lib, actor.family.id, body.email, `unsent:${id}`, now, MAX_FAMILY_INVITES),
      DB.prepare(
        `insert into events (id, library_id, actor_user_id, type, payload)
         select ?, ?, ?, 'invite_created', ? where changes() = 1`,
      ).bind(
        newId(),
        lib,
        actor.userId,
        JSON.stringify({ familyId: actor.family.id, role: "member", by: "family" }),
      ),
    ]);
    if (inserted?.meta.changes !== 1) {
      fail(
        409,
        "too_many_invites",
        `Your family can have ${MAX_FAMILY_INVITES} invitations waiting at once. Cancel one first.`,
      );
    }
    const sent = await sendInvite(
      { env: c.env, email: c.get("email") as QuotaMailer, origin: c.get("origin") },
      // The family name goes in the email only when it's plain words, so a
      // made-up "family name" can't carry a link or a message to a stranger.
      { id, email: body.email, role: "member", familyName: plainWords(actor.family.name) },
      actor.library,
      "routine",
    );
    return c.json({ sent }, 201);
  })

  /** Cancel an invitation to your family (for example a mistyped address). */
  .delete("/family/invites/:id", async (c) => {
    const actor = await requireFamily(c);
    const result = await c.env.DB.prepare(
      "delete from invitations where id = ? and library_id = ? and family_id = ? and role = 'member' and accepted_at is null",
    )
      .bind(c.req.param("id"), actor.library.id, actor.family.id)
      .run();
    if (result.meta.changes !== 1) fail(404, "not_found", "That invitation was not found.");
    return c.json({ ok: true });
  })

  // ------------------------------------------------------------- staff

  /** Families with their adults, books out and open invites. */
  .get("/admin/families", async (c) => {
    const actor = await requirePermission(c, "families:manage");
    const DB = c.env.DB;
    const lib = actor.library.id;
    const [families, parents, invites, staff, kioskPeople, kiosks] = await Promise.all([
      DB.prepare(
        `select f.id as id, f.name as name, f.status as status, f.created_at as createdAt,
                (select count(*) from loans l where l.library_id = f.library_id and l.family_id = f.id and l.returned_at is null) as booksOut
         from families f where f.library_id = ? order by f.status = 'pending' desc, f.name collate nocase`,
      )
        .bind(lib)
        .all<{ id: string; name: string; status: string; createdAt: number; booksOut: number }>(),
      DB.prepare(
        `select m.family_id as familyId, u.id as userId, u.name as name, u.email as email
         from memberships m join users u on u.id = m.user_id
         where m.library_id = ? and m.family_id is not null order by m.created_at`,
      )
        .bind(lib)
        .all<{ familyId: string; userId: string; name: string; email: string }>(),
      DB.prepare(
        `select id, family_id as familyId, email, role, sent_at as sentAt, expires_at as expiresAt from invitations
         where library_id = ? and accepted_at is null and email is not null order by created_at`,
      )
        .bind(lib)
        .all<{
          id: string;
          familyId: string | null;
          email: string;
          role: string;
          sentAt: number | null;
          expiresAt: number;
        }>(),
      DB.prepare(
        `select u.id as userId, u.name as name, u.email as email, m.role as role from memberships m join users u on u.id = m.user_id
         where m.library_id = ? and m.role in ('staff', 'admin') order by m.role, u.email`,
      )
        .bind(lib)
        .all<{ userId: string; name: string; email: string; role: string }>(),
      // Kiosk codes: adults who sign in (by their family now) and adults without email.
      DB.prepare(
        `select k.id as id, k.user_id as userId, coalesce(nullif(u.name, ''), k.first_name, '') as name,
                case when k.user_id is null then k.family_id else m.family_id end as familyId,
                k.code_set_at as codeSetAt
         from kiosk_people k
         left join users u on u.id = k.user_id
         left join memberships m on m.user_id = k.user_id and m.library_id = k.library_id
         where k.library_id = ? order by k.created_at`,
      )
        .bind(lib)
        .all<{
          id: string;
          userId: string | null;
          name: string;
          familyId: string | null;
          codeSetAt: number | null;
        }>(),
      DB.prepare(
        "select count(*) as n from kiosk_devices where library_id = ? and revoked_at is null",
      )
        .bind(lib)
        .first<number>("n"),
    ]);
    const now = Date.now();
    const inviteView = (i: (typeof invites.results)[number]) => ({
      id: i.id,
      email: i.email,
      role: i.role,
      state: i.sentAt === null ? "queued" : i.expiresAt < now ? "expired" : "sent",
    });
    return c.json({
      families: families.results.map((f) => ({
        ...f,
        adults: parents.results
          .filter((p) => p.familyId === f.id)
          .map((p) => ({ userId: p.userId, name: p.name, email: p.email })),
        invites: invites.results.filter((i) => i.familyId === f.id).map(inviteView),
        kioskPeople: kioskPeople.results
          .filter((k) => k.familyId === f.id)
          .map((k) => ({
            id: k.id,
            userId: k.userId,
            name: k.name,
            hasCode: k.codeSetAt !== null,
          })),
      })),
      kioskInUse: (kiosks ?? 0) > 0,
      staff: staff.results,
      staffInvites: invites.results.filter((i) => i.familyId === null).map(inviteView),
      joinUrl: await joinUrl(
        c,
        (
          await DB.prepare("select join_nonce as nonce from libraries where id = ?")
            .bind(lib)
            .first<{ nonce: string | null }>()
        )?.nonce ?? null,
      ),
      canManageStaff: actor.role === "admin",
    });
  })

  /** Approve a waiting family, pause one, or turn one back on. */
  .post("/admin/families/:id/status", async (c) => {
    const actor = await requirePermission(c, "families:manage");
    const body = await readBody(
      c,
      z.object({
        status: z.enum(["active", "deactivated"], { error: "Choose active or paused." }),
      }),
    );
    const DB = c.env.DB;
    const id = c.req.param("id");
    const before = await DB.prepare("select status from families where id = ? and library_id = ?")
      .bind(id, actor.library.id)
      .first<{ status: string }>();
    const [result] = await DB.batch([
      DB.prepare("update families set status = ? where id = ? and library_id = ?").bind(
        body.status,
        id,
        actor.library.id,
      ),
      // Logged only when the family exists here (changes() is the update's).
      DB.prepare(
        `insert into events (id, library_id, actor_user_id, type, payload)
         select ?, ?, ?, 'family_status_changed', ? where changes() = 1`,
      ).bind(
        newId(),
        actor.library.id,
        actor.userId,
        JSON.stringify({ familyId: id, status: body.status }),
      ),
    ]);
    if (result?.meta.changes !== 1) fail(404, "not_found", "That family was not found.");
    // Let a family that was waiting know they can borrow now.
    if (before?.status === "pending" && body.status === "active") {
      c.get("waitUntil")(
        (async () => {
          const { results } = await DB.prepare(
            "select u.email as email from memberships m join users u on u.id = m.user_id where m.library_id = ? and m.family_id = ?",
          )
            .bind(actor.library.id, id)
            .all<{ email: string }>();
          for (const parent of results) {
            await c
              .get("email")
              .send(
                approvedEmail(
                  actor.library.name,
                  parent.email,
                  libraryHome(c.get("origin"), actor.library),
                ),
              );
          }
        })().catch((error) => console.error("Approval email failed:", error)),
      );
    }
    return c.json({ status: body.status });
  })

  /**
   * Merge two families that are really one household (for example when the
   * second parent joined with the sign-up link instead of being added): the
   * adults, books, invitations and history move into the other family, which
   * keeps its name, status and settings.
   */
  .post("/admin/families/:id/merge", async (c) => {
    const actor = await requirePermission(c, "families:manage");
    const body = await readBody(c, z.object({ into: z.string().max(100) }));
    const DB = c.env.DB;
    const lib = actor.library.id;
    const from = c.req.param("id");
    if (from === body.into) fail(422, "invalid_input", "Choose a different family to merge with.");
    const { results } = await DB.prepare(
      "select id from families where library_id = ? and id in (?, ?)",
    )
      .bind(lib, from, body.into)
      .all<{ id: string }>();
    if (results.length !== 2) fail(404, "not_found", "That family was not found.");
    const move = (
      table: "memberships" | "loans" | "invitations" | "notifications" | "kiosk_people" | "holds",
    ) =>
      DB.prepare(
        `update ${table} set family_id = ?3 where library_id = ?1 and family_id = ?2`,
      ).bind(lib, from, body.into);
    try {
      await DB.batch([
        move("memberships"),
        move("loans"),
        move("invitations"),
        move("notifications"),
        move("kiosk_people"),
        // A book both families wait for keeps its place in the family merged into.
        DB.prepare(
          `delete from holds where library_id = ?1 and family_id = ?2 and title_id in
             (select title_id from holds where library_id = ?1 and family_id = ?3)`,
        ).bind(lib, from, body.into),
        move("holds"),
        DB.prepare(
          `update events set payload = json_set(payload, '$.familyId', ?3)
           where library_id = ?1 and json_valid(payload) and json_extract(payload, '$.familyId') = ?2`,
        ).bind(lib, from, body.into),
        DB.prepare("delete from families where library_id = ? and id = ?").bind(lib, from),
        event(DB, lib, actor.userId, "families_merged", { familyId: body.into, mergedFrom: from }),
      ]);
    } catch (error) {
      if (!isOpenLoanConflict(error)) throw error;
      fail(
        409,
        "busy",
        "One of those families changed a moment ago. Reload the page and try again.",
      );
    }
    return c.json({ ok: true });
  })

  /**
   * Move one adult to another family (they joined the wrong one). The last
   * adult in a family can't be moved: merge the families instead.
   */
  .post("/admin/families/:id/adults/:userId/move", async (c) => {
    const actor = await requirePermission(c, "families:manage");
    const body = await readBody(c, z.object({ to: z.string().max(100) }));
    const DB = c.env.DB;
    const lib = actor.library.id;
    const from = c.req.param("id");
    const userId = c.req.param("userId");
    if (from === body.to) fail(422, "invalid_input", "Choose a different family.");
    const target = await DB.prepare("select 1 from families where library_id = ? and id = ?")
      .bind(lib, body.to)
      .first();
    if (!target) fail(404, "not_found", "That family was not found.");
    const [moved] = await DB.batch([
      // Only while someone else stays behind, so no family is left without an adult.
      DB.prepare(
        `update memberships set family_id = ?3 where library_id = ?1 and family_id = ?2 and user_id = ?4
           and (select count(*) from memberships where library_id = ?1 and family_id = ?2) > 1`,
      ).bind(lib, from, body.to, userId),
      DB.prepare(
        `insert into events (id, library_id, actor_user_id, type, payload)
         select ?, ?, ?, 'adult_moved', ? where changes() = 1`,
      ).bind(
        newId(),
        lib,
        actor.userId,
        JSON.stringify({ familyId: body.to, movedFrom: from, userId }),
      ),
      // Their kiosk code goes with them (only when the move happened).
      DB.prepare(
        `update kiosk_people set family_id = ?3 where library_id = ?1 and family_id = ?2 and user_id = ?4
           and exists (select 1 from memberships where library_id = ?1 and family_id = ?3 and user_id = ?4)`,
      ).bind(lib, from, body.to, userId),
    ]);
    if (moved?.meta.changes !== 1) {
      const there = await DB.prepare(
        "select 1 from memberships where library_id = ? and family_id = ? and user_id = ?",
      )
        .bind(lib, from, userId)
        .first();
      if (!there) fail(404, "not_found", "That person isn't in this family.");
      fail(
        409,
        "last_adult",
        "They're the only adult in this family. Merge the two families instead.",
      );
    }
    return c.json({ ok: true });
  })

  /** Invite another parent into a family (for example the second parent). */
  .post("/admin/families/:id/invite", async (c) => {
    const actor = await requirePermission(c, "families:manage");
    const body = await readBody(c, z.object({ email: emailField }));
    const DB = c.env.DB;
    const family = await DB.prepare("select id, name from families where id = ? and library_id = ?")
      .bind(c.req.param("id"), actor.library.id)
      .first<{ id: string; name: string }>();
    if (!family) fail(404, "not_found", "That family was not found.");
    await assertNotMember(c, actor, body.email);
    await assertInviteBudget(c, actor.library.id, actor.userId);
    const id = newId();
    await DB.batch([
      DB.prepare(
        "insert into invitations (id, library_id, family_id, email, role, token_hash, expires_at) values (?, ?, ?, ?, 'member', ?, 0)",
      ).bind(id, actor.library.id, family.id, body.email, `unsent:${id}`),
      event(DB, actor.library.id, actor.userId, "invite_created", {
        familyId: family.id,
        role: "member",
      }),
    ]);
    const sent = await sendInvite(
      { env: c.env, email: c.get("email") as QuotaMailer, origin: c.get("origin") },
      { id, email: body.email, role: "member", familyName: family.name },
      actor.library,
      "urgent",
    );
    return c.json({ sent }, 201);
  })

  /**
   * Change a staff member's role, or take them off the staff (admins only).
   * Someone who also borrows for a family stays a member of it. A library
   * always keeps at least one admin. Access changes on their next request.
   */
  .post("/admin/staff/:userId/role", async (c) => {
    const actor = await requirePermission(c, "library:admin");
    const body = await readBody(
      c,
      z.object({
        role: z.enum(["admin", "staff", "none"], { error: "Choose admin, staff or none." }),
      }),
    );
    const DB = c.env.DB;
    const userId = c.req.param("userId");
    const target = await DB.prepare(
      "select role, family_id as familyId from memberships where library_id = ? and user_id = ?",
    )
      .bind(actor.library.id, userId)
      .first<{ role: string; familyId: string | null }>();
    if (!target || target.role === "member") {
      fail(404, "not_found", "That person isn't on this library's staff.");
    }
    const newRole = body.role === "none" ? "member" : body.role;
    const statements: D1PreparedStatement[] =
      newRole === "member" && !target.familyId
        ? // Not borrowing for a family either: they leave the library.
          [
            DB.prepare(
              `delete from memberships where library_id = ?1 and user_id = ?2
                 and (role != 'admin'
                      or (select count(*) from memberships where library_id = ?1 and role = 'admin') > 1)`,
            ).bind(actor.library.id, userId),
          ]
        : [
            DB.prepare(
              `update memberships set role = ?3 where library_id = ?1 and user_id = ?2
                 and (role != 'admin' or ?3 = 'admin'
                      or (select count(*) from memberships where library_id = ?1 and role = 'admin') > 1)`,
            ).bind(actor.library.id, userId, newRole),
          ];
    statements.push(
      DB.prepare(
        `insert into events (id, library_id, actor_user_id, type, payload)
         select ?, ?, ?, 'staff_role_changed', ? where changes() = 1`,
      ).bind(newId(), actor.library.id, actor.userId, JSON.stringify({ role: body.role })),
    );
    const [changed] = await DB.batch(statements);
    if (changed?.meta.changes !== 1) {
      fail(
        409,
        "last_admin",
        "The library needs at least one admin. Make someone else admin first.",
      );
    }
    return c.json({ ok: true });
  })

  /** Invite someone to help run the library (admins only). */
  .post("/admin/staff/invite", async (c) => {
    const actor = await requirePermission(c, "library:admin");
    const body = await readBody(
      c,
      z.object({
        email: emailField,
        role: z.enum(["staff", "admin"], { error: "Choose staff or admin." }),
      }),
    );
    if (!canGrantRole(actor, body.role))
      fail(403, "forbidden", "Only the library admin can do that.");
    await assertNotMember(c, actor, body.email);
    await assertInviteBudget(c, actor.library.id, actor.userId);
    const DB = c.env.DB;
    const id = newId();
    await DB.batch([
      DB.prepare(
        "insert into invitations (id, library_id, family_id, email, role, token_hash, expires_at) values (?, ?, null, ?, ?, ?, 0)",
      ).bind(id, actor.library.id, body.email, body.role, `unsent:${id}`),
      event(DB, actor.library.id, actor.userId, "invite_created", { role: body.role }),
    ]);
    const sent = await sendInvite(
      { env: c.env, email: c.get("email") as QuotaMailer, origin: c.get("origin") },
      { id, email: body.email, role: body.role, familyName: null },
      actor.library,
      "urgent",
    );
    return c.json({ sent }, 201);
  })

  /** Send an invite again, with a new link (the old link stops working). */
  .post("/admin/invites/:id/resend", async (c) => {
    const actor = await requirePermission(c, "families:manage");
    const invite = await c.env.DB.prepare(
      `select i.id as id, i.email as email, i.role as role, f.name as familyName from invitations i
       left join families f on f.id = i.family_id and f.library_id = i.library_id
       where i.id = ? and i.library_id = ? and i.accepted_at is null and i.email is not null`,
    )
      .bind(c.req.param("id"), actor.library.id)
      .first<{
        id: string;
        email: string;
        role: "member" | "staff" | "admin";
        familyName: string | null;
      }>();
    if (!invite) fail(404, "not_found", "That invitation was not found, or has been accepted.");
    if (!canGrantRole(actor, invite.role))
      fail(403, "forbidden", "Only the library admin can do that.");
    await assertInviteBudget(c, actor.library.id, actor.userId);
    const sent = await sendInvite(
      { env: c.env, email: c.get("email") as QuotaMailer, origin: c.get("origin") },
      invite,
      actor.library,
      "urgent",
      true,
    );
    if (!sent)
      fail(503, "email_failed", "The invitation could not be sent. Please try again later.");
    return c.json({ sent });
  })

  .delete("/admin/invites/:id", async (c) => {
    const actor = await requirePermission(c, "families:manage");
    const role = await c.env.DB.prepare(
      "select role from invitations where id = ? and library_id = ? and accepted_at is null",
    )
      .bind(c.req.param("id"), actor.library.id)
      .first<{ role: "member" | "staff" | "admin" }>();
    if (role && !canGrantRole(actor, role.role))
      fail(403, "forbidden", "Only the library admin can do that.");
    const result = await c.env.DB.prepare(
      "delete from invitations where id = ? and library_id = ? and accepted_at is null",
    )
      .bind(c.req.param("id"), actor.library.id)
      .run();
    if (result.meta.changes !== 1) fail(404, "not_found", "That invitation was not found.");
    return c.json({ ok: true });
  })

  /** Checks a CSV before importing: what will be created, and what is skipped and why. */
  .post("/admin/import/preview", async (c) => {
    const actor = await requirePermission(c, "families:manage");
    const body = await readBody(
      c,
      z.object({ csv: z.string().max(500_000, "That file is too big.") }),
    );
    return c.json(await checkImport(c, actor, body.csv));
  })

  /** Imports a CSV: one family per family name, one invite per parent email. */
  .post("/admin/import", async (c) => {
    const actor = await requirePermission(c, "families:manage");
    const body = await readBody(
      c,
      z.object({ csv: z.string().max(500_000, "That file is too big.") }),
    );
    const plan = await checkImport(c, actor, body.csv);
    if (plan.error) fail(422, "bad_file", plan.error);
    const good = plan.rows.filter((r) => r.problem === null);
    if (good.length === 0)
      fail(422, "nothing_to_import", "There's nobody new to invite in this file.");

    const DB = c.env.DB;
    const families = new Map<string, string>();
    const familyRows: { id: string; name: string }[] = [];
    const inviteRows: { id: string; familyId: string; email: string }[] = [];
    for (const row of good) {
      const key = row.familyName.toLowerCase();
      let familyId = families.get(key);
      if (!familyId) {
        familyId = newId();
        families.set(key, familyId);
        familyRows.push({ id: familyId, name: row.familyName });
      }
      inviteRows.push({ id: newId(), familyId, email: row.email });
    }
    // Two bulk inserts (rows passed as JSON), so a 500-row file is still only a
    // few statements, inside D1's per-request limits.
    const statements = [
      DB.prepare(
        `insert into families (id, library_id, name, status)
         select json_extract(value, '$.id'), ?, json_extract(value, '$.name'), 'active' from json_each(?)`,
      ).bind(actor.library.id, JSON.stringify(familyRows)),
      DB.prepare(
        `insert into invitations (id, library_id, family_id, email, role, token_hash, expires_at)
         select json_extract(value, '$.id'), ?, json_extract(value, '$.familyId'), json_extract(value, '$.email'),
                'member', 'unsent:' || json_extract(value, '$.id'), 0
         from json_each(?)`,
      ).bind(actor.library.id, JSON.stringify(inviteRows)),
      event(DB, actor.library.id, actor.userId, "families_imported", {
        families: families.size,
        invites: good.length,
      }),
    ];
    // One transaction: the whole file goes in, or none of it.
    await DB.batch(statements);

    // Send the first few now; the hourly job sends the rest within the daily email limit.
    c.get("waitUntil")(
      (async () => {
        for (const invite of await unsentInvites(DB, actor.library.id, SEND_NOW)) {
          const ok = await sendInvite(
            { env: c.env, email: c.get("email") as QuotaMailer, origin: c.get("origin") },
            invite,
            actor.library,
            "routine",
          );
          if (!ok) break;
        }
      })().catch((error) => console.error("Sending invites failed:", error)),
    );
    return c.json({ families: families.size, invites: good.length }, 201);
  })

  /**
   * Remove a family (for example when a child leaves the centre). Books still
   * out block it, unless staff choose to mark them lost.
   */
  .post("/admin/families/:id/remove", async (c) => {
    const actor = await requirePermission(c, "families:manage");
    const body = await readBody(c, z.object({ markLost: z.boolean().default(false) }));
    const DB = c.env.DB;
    const lib = actor.library.id;
    const family = await DB.prepare("select id, name from families where id = ? and library_id = ?")
      .bind(c.req.param("id"), lib)
      .first<{ id: string; name: string }>();
    if (!family) fail(404, "not_found", "That family was not found.");
    const { results: open } = await DB.prepare(
      `select l.id as id, l.copy_id as copyId, t.title as title,
              l.return_requested_at as handedBackAt from loans l
       join copies c on c.id = l.copy_id and c.library_id = l.library_id
       join titles t on t.id = c.title_id and t.library_id = c.library_id
       where l.library_id = ? and l.family_id = ? and l.returned_at is null`,
    )
      .bind(lib, family.id)
      .all<{ id: string; copyId: string; title: string; handedBackAt: number | null }>();
    if (open.length > 0 && !body.markLost) {
      return c.json(
        {
          error: "books_out",
          message: `The ${family.name} family still has ${open.length} ${open.length === 1 ? "book" : "books"} out.`,
          books: open.map((b) => b.title),
        },
        409,
      );
    }
    const now = Date.now();
    try {
      await DB.batch([
        ...open.flatMap((loan) =>
          // A book the family handed back is treated as returned, not lost.
          loan.handedBackAt !== null
            ? [
                DB.prepare(
                  "update loans set returned_at = ?, returned_by = ?, outcome = 'returned' where id = ? and returned_at is null",
                ).bind(now, actor.userId, loan.id),
              ]
            : [
                DB.prepare(
                  "update loans set returned_at = ?, returned_by = ?, outcome = 'lost' where id = ? and returned_at is null",
                ).bind(now, actor.userId, loan.id),
                DB.prepare(
                  "update copies set status = 'lost' where id = ? and library_id = ?",
                ).bind(loan.copyId, lib),
              ],
        ),
        ...removeFamilyStatements(DB, lib, family.id),
        event(DB, lib, actor.userId, "family_removed", { booksMarkedLost: open.length }),
      ]);
    } catch (error) {
      if (!isOpenLoanConflict(error)) throw error;
      fail(
        409,
        "books_out",
        `The ${family.name} family borrowed a book a moment ago. Please try again.`,
      );
    }
    return c.json({ ok: true });
  })

  // ----------------------------------------------------- the sign-up link

  .post("/admin/join-link", async (c) => {
    const actor = await requirePermission(c, "library:admin");
    const body = await readBody(c, z.object({ enabled: z.boolean() }));
    const nonce = body.enabled ? randomToken() : null;
    const hash = nonce ? await sha256Hex(await joinTokenFor(c.env, nonce)) : null;
    const DB = c.env.DB;
    await DB.batch([
      DB.prepare("update libraries set join_nonce = ?, join_token_hash = ? where id = ?").bind(
        nonce,
        hash,
        actor.library.id,
      ),
      event(
        DB,
        actor.library.id,
        actor.userId,
        body.enabled ? "join_link_replaced" : "join_link_turned_off",
        {},
      ),
    ]);
    return c.json({ joinUrl: await joinUrl(c, nonce) });
  })

  // --------------------------------------------------------- deleting

  /** Step 1: check nothing blocks deletion, then email a confirmation code. */
  .post("/account/delete/start", async (c) => {
    const user = requireUser(c);
    const blockers = await accountBlockers(c);
    if (blockers.books.length > 0 || blockers.lastAdmin || blockers.lastOwner) {
      return c.json(
        {
          blocked: true,
          books: blockers.books,
          lastAdmin: blockers.lastAdmin,
          lastOwner: blockers.lastOwner,
        },
        409,
      );
    }
    const secret = authSecret(c.env);
    const limit = await consume(c.env.DB, secret, `delete-start:${user.id}`, {
      window: 600,
      max: 3,
    });
    if (!limit.allowed)
      fail(429, "too_many_attempts", "Please wait a few minutes before asking for another code.");
    const code = String((crypto.getRandomValues(new Uint32Array(1))[0] ?? 0) % 1_000_000).padStart(
      6,
      "0",
    );
    const identifier = `delete-account:${user.id}`;
    const DB = c.env.DB;
    await DB.batch([
      DB.prepare("delete from verifications where identifier = ?").bind(identifier),
      DB.prepare(
        "insert into verifications (id, identifier, value, expires_at, updated_at) values (?, ?, ?, ?, ?)",
      ).bind(
        newId(),
        identifier,
        await hmacHex(secret, `${identifier}:${code}`),
        Date.now() + DELETE_CODE_MINUTES * 60_000,
        Date.now(),
      ),
    ]);
    const result = await c
      .get("email")
      .send(
        deleteCodeEmail(
          blockers.actors.length === 1
            ? (blockers.actors[0]?.library.name ?? c.env.LIBRARY_NAME)
            : c.env.LIBRARY_NAME,
          user.email,
          code,
        ),
      );
    if (!result.ok) fail(503, "email_failed", "We couldn't send the code. Please try again later.");
    return c.json({ codeSent: true, familyWillBeRemoved: blockers.lastParent });
  })

  /** Step 2: with the emailed code, delete the account (and the family, if they were its last parent). */
  .post("/account/delete/confirm", async (c) => {
    const user = requireUser(c);
    const body = await readBody(
      c,
      z.object({
        code: z
          .string()
          .trim()
          .regex(/^\d{6}$/, "Enter the 6-digit code."),
      }),
    );
    const secret = authSecret(c.env);
    const limit = await consume(c.env.DB, secret, `delete-confirm:${user.id}`, {
      window: 600,
      max: 5,
    });
    if (!limit.allowed)
      fail(429, "too_many_attempts", "Too many tries. Please ask for a new code in a few minutes.");
    const DB = c.env.DB;
    const identifier = `delete-account:${user.id}`;
    const stored = await DB.prepare(
      "select value, expires_at as expiresAt from verifications where identifier = ?",
    )
      .bind(identifier)
      .first<{ value: string; expiresAt: number }>();
    if (
      !stored ||
      stored.expiresAt < Date.now() ||
      !timingSafeEqual(stored.value, await hmacHex(secret, `${identifier}:${body.code}`))
    ) {
      fail(400, "wrong_code", "That code didn't work. It may have expired; ask for a new one.");
    }
    // Check again: a book may have been borrowed since the code was sent.
    const blockers = await accountBlockers(c);
    if (blockers.books.length > 0 || blockers.lastAdmin || blockers.lastOwner) {
      return c.json(
        {
          blocked: true,
          books: blockers.books,
          lastAdmin: blockers.lastAdmin,
          lastOwner: blockers.lastOwner,
        },
        409,
      );
    }
    const email = user.email.toLowerCase();
    const statements: D1PreparedStatement[] = [
      DB.prepare("delete from verifications where identifier = ?").bind(identifier),
      // Pending sign-in codes and invitations for this address go too.
      // Codes for exactly this address: escaped, and anchored on the "-" before it.
      DB.prepare("delete from verifications where identifier like ? escape '\\'").bind(
        `%-${email.replace(/[\\%_]/g, (ch) => `\\${ch}`)}`,
      ),
      DB.prepare("delete from invitations where lower(email) = ?").bind(email),
    ];
    // In each library where they were their family's last parent, the family goes too.
    blockers.actors.forEach((actor, i) => {
      if (actor.family && blockers.each[i]?.lastParent) {
        statements.push(...removeFamilyStatements(DB, actor.library.id, actor.family.id));
      }
    });
    // Deleting the user removes their sessions, passkeys and memberships, and
    // clears their id from loans, copies and events.
    statements.push(DB.prepare("delete from users where id = ?").bind(user.id));
    blockers.actors.forEach((actor, i) => {
      statements.push(
        event(DB, actor.library.id, null, "account_deleted", {
          familyRemoved: blockers.each[i]?.lastParent ?? false,
        }),
      );
    });
    try {
      await DB.batch(statements);
    } catch (error) {
      if (!isOpenLoanConflict(error)) throw error;
      fail(409, "books_out", "Your family borrowed a book a moment ago. Please return it first.");
    }
    c.get("waitUntil")(
      c
        .get("email")
        .send(
          goodbyeEmail(
            blockers.actors.length === 1
              ? (blockers.actors[0]?.library.name ?? c.env.LIBRARY_NAME)
              : c.env.LIBRARY_NAME,
            user.email,
          ),
        )
        .catch((error) => console.error("Goodbye email failed:", error)),
    );
    return c.json({ deleted: true });
  });

/** Invitations a family can have waiting at once, when parents send them. */
const MAX_FAMILY_INVITES = 3;

/** The text when it's only letters, spaces, apostrophes and hyphens; otherwise null. */
function plainWords(text: string): string | null {
  return /^[\p{L}\p{M}][\p{L}\p{M} '’-]*$/u.test(text) ? text : null;
}

/** The signed-in member and their family, or a 404 when they have none here. */
async function requireFamily(c: AppContext) {
  const actor = await requirePermission(c, "loans:own");
  if (!actor.family) fail(404, "no_family", "Your sign-in isn't connected to a family.");
  return actor as Actor & { family: NonNullable<Actor["family"]> };
}

/** A family's invitations that haven't been accepted yet. */
async function openFamilyInvites(DB: D1Database, libraryId: string, familyId: string) {
  const { results } = await DB.prepare(
    `select id, email, sent_at as sentAt, expires_at as expiresAt from invitations
     where library_id = ? and family_id = ? and accepted_at is null and email is not null
     order by created_at`,
  )
    .bind(libraryId, familyId)
    .all<{ id: string; email: string; sentAt: number | null; expiresAt: number }>();
  return results;
}

/** Refuses to invite someone who already belongs to the library. */
async function assertNotMember(c: AppContext, actor: Actor, email: string, byFamily = false) {
  const member = await c.env.DB.prepare(
    `select 1 from memberships m join users u on u.id = m.user_id where m.library_id = ? and lower(u.email) = ?`,
  )
    .bind(actor.library.id, email)
    .first();
  if (member) {
    fail(
      409,
      "already_member",
      byFamily
        ? `${email} already uses this library, perhaps as a separate family. Ask the library staff to put you in one family.`
        : `${email} is already a member of this library.`,
    );
  }
  // One open invite per address: use "Resend" rather than stacking new ones.
  const open = await c.env.DB.prepare(
    "select 1 from invitations where library_id = ? and lower(email) = ? and accepted_at is null and (sent_at is null or expires_at > ?)",
  )
    .bind(actor.library.id, email, Date.now())
    .first();
  if (open) {
    fail(
      409,
      "already_invited",
      `${email} already has an invitation. Use Resend to send it again.`,
    );
  }
}

/**
 * Invites go out from the site's shared email allowance, so each library and
 * each person can send only so many: enough for real use, not for spam.
 */
export async function assertInviteBudget(c: AppContext, libraryId: string, userId: string) {
  const secret = authSecret(c.env);
  for (const [key, rule] of [
    [`invites-library:${libraryId}`, { window: 86_400, max: 60 }],
    [`invites-user:${userId}`, { window: 3600, max: 20 }],
  ] as const) {
    if (!(await consume(c.env.DB, secret, key, rule)).allowed) {
      fail(429, "too_many_invites", "That's a lot of invitations for now. Please try again later.");
    }
  }
}

/** Reads a CSV and marks rows that are already members or already invited. */
async function checkImport(c: AppContext, actor: Actor, csv: string) {
  const { rows, error } = readInvites(csv);
  if (error) return { error, rows: [], families: 0, invites: 0 };
  if (rows.length > MAX_IMPORT_ROWS) {
    return {
      error: `That's ${rows.length} rows. Import up to ${MAX_IMPORT_ROWS} at a time.`,
      rows: [],
      families: 0,
      invites: 0,
    };
  }
  const DB = c.env.DB;
  const [members, invited] = await Promise.all([
    DB.prepare(
      "select lower(u.email) as email from memberships m join users u on u.id = m.user_id where m.library_id = ?",
    )
      .bind(actor.library.id)
      .all<{ email: string }>(),
    DB.prepare(
      "select email from invitations where library_id = ? and accepted_at is null and email is not null",
    )
      .bind(actor.library.id)
      .all<{ email: string }>(),
  ]);
  const memberSet = new Set(members.results.map((m) => m.email));
  const invitedSet = new Set(invited.results.map((i) => i.email));
  const checked = rows.map((row) => ({
    ...row,
    problem:
      row.problem ??
      (memberSet.has(row.email)
        ? "already_member"
        : invitedSet.has(row.email)
          ? "already_invited"
          : null),
  }));
  const good = checked.filter((r) => r.problem === null);
  return {
    error: null,
    rows: checked,
    families: new Set(good.map((r) => r.familyName.toLowerCase())).size,
    invites: good.length,
  };
}
