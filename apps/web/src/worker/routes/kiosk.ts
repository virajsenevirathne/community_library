import { daysOverdue, dueDateDetails, handBackCutoff, localParts } from "@community-library/core";
import { type Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { type Actor, requirePermission } from "../access.ts";
import { authSecret } from "../config.ts";
import { type AppContext, type AppEnv, fail, readBody } from "../context.ts";
import { hmacHex, randomToken, sha256Hex } from "../crypto.ts";
import { newId } from "../db/client.ts";
import { type LibraryInfo, libraryById } from "../library.ts";
import { consume, lock, lockedFor, refund } from "../limiter.ts";
import { firstNameField, name } from "./account.ts";
import { event } from "./families.ts";
import { findCopy, inBackground, sendCheckoutEmails } from "./loans.ts";

/*
 * Kiosk mode: a shared tablet by the shelf where families borrow and return
 * without their phone.
 *
 * - An admin turns a tablet into a kiosk. The tablet gets its own pass (an
 *   HttpOnly cookie holding a random token; only its hash is stored), not a
 *   person's sign-in. The pass can only look a book up, borrow and return.
 * - Each adult has their own 6-digit code. Codes are made by the server,
 *   unique in the library, stored as a keyed hash (HMAC with the server
 *   secret) and shown only once.
 * - Wrong codes are limited per tablet (5 lock it for a minute, 20 an hour)
 *   and per library, and every kiosk borrow emails the family.
 */

const COOKIE = "kiosk_pass";
/** Browsers keep a cookie at most 400 days; each visit renews it. */
const COOKIE_DAYS = 400;
const LOCK_SECONDS = 60;
const WRONG_PER_MINUTE = 5;
const WRONG_PER_HOUR = 20;
const WRONG_PER_LIBRARY_HOUR = 60;
const MAX_KIOSKS = 10;

const codeField = z
  .string({ error: "Type your 6-digit code." })
  .regex(/^\d{6}$/, "Type your 6-digit code.");

/** On https the cookie gets the __Host- prefix: only this site, only over https. */
function cookieName(c: Context<AppEnv>) {
  return c.get("origin").startsWith("https://") ? `__Host-${COOKIE}` : COOKIE;
}

function setPass(c: Context<AppEnv>, token: string) {
  setCookie(c, cookieName(c), token, {
    httpOnly: true,
    secure: c.get("origin").startsWith("https://"),
    sameSite: "Strict",
    path: "/",
    maxAge: COOKIE_DAYS * 86_400,
  });
}

/** This tablet's kiosk pass, if it has one (any state). */
async function passHash(c: AppContext) {
  const token = getCookie(c, cookieName(c));
  return token && token.length >= 20 && token.length <= 100 ? sha256Hex(token) : null;
}

interface Kiosk {
  id: string;
  name: string;
  library: LibraryInfo;
}

/**
 * The kiosk this tablet is, from its pass. Fails with 401 when the tablet
 * isn't a kiosk or its kiosk was turned off. The request then acts in the
 * kiosk's own library, whatever page it came from.
 */
async function requireKiosk(c: AppContext): Promise<Kiosk> {
  const hash = await passHash(c);
  const row = hash
    ? await c.env.DB.prepare(
        `select id, name, library_id as libraryId, revoked_at as revokedAt, last_seen_at as lastSeenAt
         from kiosk_devices where token_hash = ?`,
      )
        .bind(hash)
        .first<{
          id: string;
          name: string;
          libraryId: string;
          revokedAt: number | null;
          lastSeenAt: number | null;
        }>()
    : null;
  if (!row || row.revokedAt !== null) {
    if (row) deleteCookie(c, cookieName(c), { path: "/", secure: true });
    fail(
      401,
      row ? "kiosk_off" : "not_a_kiosk",
      row
        ? "This kiosk has been turned off. Ask the library admin to set it up again."
        : "This tablet isn't set up as a kiosk. A library admin can set it up in Settings.",
    );
  }
  const library = await libraryById(c.get("db"), row.libraryId);
  if (!library) fail(401, "not_a_kiosk", "This tablet isn't set up as a kiosk.");
  c.set("library", library);
  // Last used, for the admin's list. Written at most every few minutes.
  const now = Date.now();
  if (row.lastSeenAt === null || row.lastSeenAt < now - 5 * 60_000) {
    await c.env.DB.prepare("update kiosk_devices set last_seen_at = ? where id = ?")
      .bind(now, row.id)
      .run();
  }
  return { id: row.id, name: row.name, library };
}

/** Borrowing and returning wait while the library is paused. */
function refuseIfPaused(kiosk: Kiosk) {
  if (kiosk.library.status === "paused") {
    fail(
      403,
      "library_paused",
      "The library is paused, so books can't be borrowed or returned here right now. Please ask the staff.",
    );
  }
}

/** A library-scoped view for the shared loan helpers. It has no person and no staff rights. */
function kioskActor(library: LibraryInfo, family: Actor["family"] = null): Actor {
  return { userId: "", email: "", library, role: "member", family };
}

/** A new random 6-digit code. */
function randomCode() {
  return String((crypto.getRandomValues(new Uint32Array(1))[0] ?? 0) % 1_000_000).padStart(6, "0");
}

/** The keyed hash a code is stored and looked up by. Codes belong to one library. */
function codeHash(secret: string, libraryId: string, code: string) {
  return hmacHex(secret, `kiosk-code:${libraryId}:${code}`);
}

/**
 * Gives a kiosk person a fresh code and returns it (the only time it can be
 * seen). Codes are unique in the library, so a clash just picks another.
 */
async function setNewCode(c: AppContext, libraryId: string, personId: string) {
  const secret = authSecret(c.env);
  for (let i = 0; i < 8; i++) {
    const code = randomCode();
    try {
      const result = await c.env.DB.prepare(
        "update kiosk_people set code_hash = ?, code_set_at = ? where id = ? and library_id = ?",
      )
        .bind(await codeHash(secret, libraryId, code), Date.now(), personId, libraryId)
        .run();
      if (result.meta.changes !== 1) fail(404, "not_found", "That person was not found.");
      return code;
    } catch (error) {
      if (!/UNIQUE/.test(String(error))) throw error;
    }
  }
  throw new Error("Could not find a free kiosk code");
}

/** Staff and parents may make only so many codes, so codes can't be churned. */
async function assertCodeBudget(c: AppContext, key: string, max: number) {
  const limit = await consume(c.env.DB, authSecret(c.env), key, { window: 86_400, max });
  if (!limit.allowed) {
    fail(429, "too_many_codes", "That's a lot of new kiosk codes for today. Try again tomorrow.");
  }
}

/** True when the library has a kiosk turned on, so codes are worth having. */
async function kioskInUse(DB: D1Database, libraryId: string) {
  const row = await DB.prepare(
    "select 1 from kiosk_devices where library_id = ? and revoked_at is null limit 1",
  )
    .bind(libraryId)
    .first();
  return row !== null;
}

/** "Too many wrong codes" with how long to wait, for the tablet's countdown. */
function locked(c: AppContext, retryAfter: number) {
  return c.json(
    {
      error: "kiosk_locked",
      message: "Too many wrong codes. Please wait a minute, then try again.",
      retryAfter,
    },
    429,
  );
}

/** What the tablet may know about a book: no family, no history. */
function kioskCopyView(row: Awaited<ReturnType<typeof findCopy>>) {
  const state: "available" | "out" | "handedBack" | "unavailable" =
    row.status !== "available"
      ? "unavailable"
      : row.loanId === null
        ? "available"
        : row.returnRequestedAt !== null
          ? "handedBack"
          : "out";
  return {
    code: row.shortCode,
    title: { title: row.title, authors: row.authors, coverUrl: row.coverUrl },
    state,
  };
}

const kioskNameField = name("Kiosk name", 40);

export const kioskRoutes = new Hono<AppEnv>()
  // ------------------------------------------------------------ the tablet

  /** Which kiosk this tablet is, and the library's rules it needs. */
  .get("/kiosk", async (c) => {
    const kiosk = await requireKiosk(c);
    // Keep the pass from expiring on a tablet that is in use.
    const token = getCookie(c, cookieName(c));
    if (token) setPass(c, token);
    return c.json({
      kiosk: { name: kiosk.name },
      library: {
        name: kiosk.library.name,
        slug: kiosk.library.slug,
        paused: kiosk.library.status === "paused",
        returnsNeedCheckIn: kiosk.library.settings.returnsNeedCheckIn,
      },
    });
  })

  /** A book by the code on its sticker. */
  .get("/kiosk/copies/:code", async (c) => {
    const kiosk = await requireKiosk(c);
    const row = await findCopy(c.get("db"), kioskActor(kiosk.library), c.req.param("code"));
    return c.json({ copy: kioskCopyView(row) });
  })

  /**
   * Borrow with a personal code. The book is checked first, so nobody types
   * their code for a book that can't be borrowed. Wrong codes are counted
   * before the check (so simultaneous guesses all count) and given back when
   * the code is right.
   */
  .post("/kiosk/copies/:code/borrow", async (c) => {
    const kiosk = await requireKiosk(c);
    refuseIfPaused(kiosk);
    const body = await readBody(c, z.object({ code: codeField }));
    const db = c.get("db");
    const DB = c.env.DB;
    const lib = kiosk.library.id;
    const row = await findCopy(db, kioskActor(kiosk.library), c.req.param("code"));
    if (row.status !== "available") {
      fail(409, "unavailable", "This book can't be borrowed right now. Please give it to staff.");
    }

    const secret = authSecret(c.env);
    const lockKey = `kiosk-lock:${kiosk.id}`;
    const wait = await lockedFor(DB, secret, lockKey, LOCK_SECONDS);
    if (wait !== null) return locked(c, wait);
    const counters = [
      [`kiosk-wrong-min:${kiosk.id}`, { window: 60, max: WRONG_PER_MINUTE }],
      [`kiosk-wrong-hour:${kiosk.id}`, { window: 3600, max: WRONG_PER_HOUR }],
      [`kiosk-wrong-library:${lib}`, { window: 3600, max: WRONG_PER_LIBRARY_HOUR }],
    ] as const;
    const counted: string[] = [];
    let minuteCount = 0;
    for (const [key, rule] of counters) {
      const result = await consume(DB, secret, key, rule);
      counted.push(key);
      if (!result.allowed) {
        // This try wasn't checked, so it doesn't count.
        await Promise.all(counted.map((k) => refund(DB, secret, k)));
        if (key === counters[0][0]) await lock(DB, secret, lockKey);
        return locked(c, key === counters[0][0] ? LOCK_SECONDS : (result.retryAfter ?? 60));
      }
      if (key === counters[0][0]) minuteCount = result.count;
    }

    // The person, and their family: an adult with a sign-in borrows for the
    // family they belong to now; an adult without one, for theirs.
    const person = await DB.prepare(
      `select k.id as id, k.user_id as userId,
              coalesce(nullif(u.name, ''), k.first_name, '') as name,
              f.id as familyId, f.name as familyName, f.status as familyStatus
       from kiosk_people k
       left join users u on u.id = k.user_id
       left join memberships m on m.user_id = k.user_id and m.library_id = k.library_id
       join families f on f.library_id = k.library_id
         and f.id = case when k.user_id is null then k.family_id else m.family_id end
       where k.library_id = ? and k.code_hash = ?`,
    )
      .bind(lib, await codeHash(secret, lib, body.code))
      .first<{
        id: string;
        userId: string | null;
        name: string;
        familyId: string;
        familyName: string;
        familyStatus: "active" | "pending" | "deactivated";
      }>();
    if (!person) {
      if (minuteCount >= WRONG_PER_MINUTE) await lock(DB, secret, lockKey);
      fail(400, "wrong_code", "That code didn't work. Check it and try again.");
    }
    await Promise.all(counted.map((k) => refund(DB, secret, k)));

    if (person.familyStatus === "pending") {
      fail(
        403,
        "family_pending",
        "Your family is waiting for staff approval, so you can't borrow yet. Please ask the staff.",
      );
    }
    if (person.familyStatus !== "active") {
      fail(
        403,
        "family_inactive",
        "Your family's library membership is paused, so you can't borrow right now. Please ask the staff.",
      );
    }
    const family = { id: person.familyId, name: person.familyName, status: person.familyStatus };
    if (row.loanId) {
      if (row.loanFamilyId === family.id) {
        return c.json({
          borrowed: { title: row.title, dueOn: row.dueOn, name: person.name, family: family.name },
          alreadyYours: true,
        });
      }
      fail(409, "on_loan", "Another family has this book out. Please give it to staff.");
    }

    const settings = kiosk.library.settings;
    const { due } = dueDateDetails(new Date(), settings);
    const loanId = newId();
    let inserted = 0;
    try {
      const [result] = await DB.batch([
        // The same rules as on a phone, in one statement: the family's limit
        // and one open loan per copy (a unique index) hold under races.
        DB.prepare(
          `insert into loans (id, library_id, copy_id, family_id, borrowed_by, borrowed_at, due_on,
                              kiosk_person_id, kiosk_device_id)
           select ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?10, ?11
           where (select count(*) from loans
                  where library_id = ?2 and family_id = ?4 and returned_at is null
                    and (return_requested_at is null or return_requested_at < ?9)) < ?8
             and exists (select 1 from copies where id = ?3 and library_id = ?2 and status = 'available')
             and exists (select 1 from families where id = ?4 and library_id = ?2 and status = 'active')`,
        ).bind(
          loanId,
          lib,
          row.copyId,
          family.id,
          person.userId,
          Date.now(),
          due,
          settings.maxLoans,
          handBackCutoff(),
          person.id,
          kiosk.id,
        ),
        DB.prepare(
          `insert into events (id, library_id, actor_user_id, type, payload)
           select ?, ?, ?, 'loan_created', ? where exists (select 1 from loans where id = ?)`,
        ).bind(
          newId(),
          lib,
          person.userId,
          JSON.stringify({
            loanId,
            copyId: row.copyId,
            titleId: row.titleId,
            familyId: family.id,
            kioskDeviceId: kiosk.id,
            kioskPersonId: person.id,
          }),
          loanId,
        ),
        DB.prepare(
          "update copies set found_at = null, found_by = null where id = ? and found_at is not null and exists (select 1 from loans where id = ?)",
        ).bind(row.copyId, loanId),
      ]);
      inserted = result?.meta.changes ?? 0;
    } catch (error) {
      if (!/UNIQUE/.test(String(error))) throw error;
      fail(409, "on_loan", "Someone borrowed this book a moment ago.");
    }
    if (inserted !== 1) {
      fail(
        409,
        "limit_reached",
        `Your family already has ${settings.maxLoans} books out, the most allowed. Bring one back to borrow another.`,
      );
    }
    inBackground(
      c,
      sendCheckoutEmails(
        c,
        { ...kioskActor(kiosk.library, family), family },
        { title: row.title, dueOn: due },
        { personName: person.name || "Someone" },
      ),
    );
    return c.json(
      { borrowed: { title: row.title, dueOn: due, name: person.name, family: family.name } },
      201,
    );
  })

  /**
   * Return a book. No code is needed: whoever has the book in hand can bring
   * it back. Libraries that check returns in get "put it in the basket".
   */
  .post("/kiosk/copies/:code/return", async (c) => {
    const kiosk = await requireKiosk(c);
    refuseIfPaused(kiosk);
    const secret = authSecret(c.env);
    const limit = await consume(c.env.DB, secret, `kiosk-returns:${kiosk.id}`, {
      window: 3600,
      max: 300,
    });
    if (!limit.allowed) {
      fail(429, "too_many_returns", "That's a lot of returns. Please hand the rest to staff.");
    }
    const db = c.get("db");
    const DB = c.env.DB;
    const lib = kiosk.library.id;
    const row = await findCopy(db, kioskActor(kiosk.library), c.req.param("code"));
    if (!row.loanId) return c.json({ title: row.title, alreadyReturned: true });
    const settings = kiosk.library.settings;
    const late = row.dueOn
      ? daysOverdue(row.dueOn, localParts(new Date(), settings.timezone).date)
      : 0;
    if (settings.returnsNeedCheckIn) {
      await DB.batch([
        DB.prepare(
          "update loans set return_requested_at = ? where id = ? and library_id = ? and returned_at is null and return_requested_at is null",
        ).bind(Date.now(), row.loanId, lib),
        DB.prepare(
          `insert into events (id, library_id, actor_user_id, type, payload)
           select ?, ?, null, 'loan_handed_back', ? where changes() = 1`,
        ).bind(
          newId(),
          lib,
          JSON.stringify({ loanId: row.loanId, copyId: row.copyId, kioskDeviceId: kiosk.id }),
        ),
      ]);
      return c.json({ title: row.title, pendingCheckIn: true });
    }
    const returnedAt = Date.now();
    const closedByUs =
      "exists (select 1 from loans where id = ? and returned_at = ? and outcome = 'returned' and returned_by is null)";
    const [closed] = await DB.batch([
      DB.prepare(
        "update loans set returned_at = ?, returned_by = null, outcome = 'returned' where id = ? and library_id = ? and returned_at is null",
      ).bind(returnedAt, row.loanId, lib),
      DB.prepare(
        `update copies set found_at = null, found_by = null where id = ? and library_id = ? and ${closedByUs}`,
      ).bind(row.copyId, lib, row.loanId, returnedAt),
      DB.prepare(
        `insert into events (id, library_id, actor_user_id, type, payload)
         select ?, ?, null, 'loan_returned', ? where ${closedByUs}`,
      ).bind(
        newId(),
        lib,
        JSON.stringify({
          loanId: row.loanId,
          copyId: row.copyId,
          familyId: row.loanFamilyId,
          kioskDeviceId: kiosk.id,
          wasFound: row.foundAt !== null,
        }),
        row.loanId,
        returnedAt,
      ),
    ]);
    if (closed?.meta.changes !== 1) return c.json({ title: row.title, alreadyReturned: true });
    return c.json({ title: row.title, returned: true, overdueDays: late });
  })

  // ------------------------------------------------- admins: the tablets

  /** The library's kiosks, newest first, and whether this tablet is one of them. */
  .get("/admin/kiosks", async (c) => {
    const actor = await requirePermission(c, "library:admin");
    const hash = await passHash(c);
    const { results } = await c.env.DB.prepare(
      `select id, name, created_at as createdAt, last_seen_at as lastSeenAt,
              revoked_at as revokedAt, token_hash = ? as thisTablet
       from kiosk_devices where library_id = ? order by revoked_at is not null, created_at desc`,
    )
      .bind(hash ?? "", actor.library.id)
      .all<{
        id: string;
        name: string;
        createdAt: number;
        lastSeenAt: number | null;
        revokedAt: number | null;
        thisTablet: number;
      }>();
    return c.json({
      kiosks: results.map((k) => ({
        id: k.id,
        name: k.name,
        createdAt: k.createdAt,
        lastSeenAt: k.lastSeenAt,
        on: k.revokedAt === null,
        thisTablet: k.thisTablet === 1 && k.revokedAt === null,
      })),
    });
  })

  /**
   * Turn the tablet this request comes from into a kiosk. It gets a new pass
   * (replacing any earlier one on this tablet). The page then signs the admin
   * out, so the tablet never keeps a person's sign-in.
   */
  .post("/admin/kiosks", async (c) => {
    const actor = await requirePermission(c, "library:admin");
    const body = await readBody(c, z.object({ name: kioskNameField }));
    const DB = c.env.DB;
    const lib = actor.library.id;
    const limit = await consume(DB, authSecret(c.env), `kiosk-create:${lib}`, {
      window: 86_400,
      max: 20,
    });
    if (!limit.allowed) {
      fail(429, "too_many_kiosks", "That's a lot of kiosks for today. Try again tomorrow.");
    }
    const id = newId();
    const token = randomToken();
    const earlier = await passHash(c);
    const [created] = await DB.batch([
      DB.prepare(
        `insert into kiosk_devices (id, library_id, name, token_hash, created_by)
         select ?, ?, ?, ?, ? where (select count(*) from kiosk_devices
                                     where library_id = ? and revoked_at is null) < ?`,
      ).bind(id, lib, body.name, await sha256Hex(token), actor.userId, lib, MAX_KIOSKS),
      // This tablet's earlier pass (for any library) stops working.
      DB.prepare(
        "update kiosk_devices set revoked_at = ? where token_hash = ? and revoked_at is null and changes() = 1",
      ).bind(Date.now(), earlier ?? ""),
      DB.prepare(
        `insert into events (id, library_id, actor_user_id, type, payload)
         select ?, ?, ?, 'kiosk_created', ? where exists (select 1 from kiosk_devices where id = ?)`,
      ).bind(newId(), lib, actor.userId, JSON.stringify({ kioskId: id }), id),
    ]);
    if (created?.meta.changes !== 1) {
      fail(
        409,
        "too_many_kiosks",
        `A library can have ${MAX_KIOSKS} kiosks turned on. Turn one off first.`,
      );
    }
    setPass(c, token);
    return c.json({ kiosk: { id, name: body.name } }, 201);
  })

  /** Turn a kiosk off at once: its tablet can't borrow or return any more. */
  .post("/admin/kiosks/:id/off", async (c) => {
    const actor = await requirePermission(c, "library:admin");
    const DB = c.env.DB;
    const [result] = await DB.batch([
      DB.prepare(
        "update kiosk_devices set revoked_at = ? where id = ? and library_id = ? and revoked_at is null",
      ).bind(Date.now(), c.req.param("id"), actor.library.id),
      DB.prepare(
        `insert into events (id, library_id, actor_user_id, type, payload)
         select ?, ?, ?, 'kiosk_turned_off', ? where changes() = 1`,
      ).bind(
        newId(),
        actor.library.id,
        actor.userId,
        JSON.stringify({ kioskId: c.req.param("id") }),
      ),
    ]);
    if (result?.meta.changes !== 1) fail(404, "not_found", "That kiosk was not found.");
    return c.json({ ok: true });
  })

  // ------------------------------------------------- your own code

  /** Whether you have a kiosk code here, and whether the library has a kiosk. */
  .get("/family/kiosk-code", async (c) => {
    const actor = await requirePermission(c, "loans:own");
    const DB = c.env.DB;
    const [inUse, mine] = await Promise.all([
      kioskInUse(DB, actor.library.id),
      DB.prepare(
        "select code_set_at as setAt from kiosk_people where library_id = ? and user_id = ? and code_hash is not null",
      )
        .bind(actor.library.id, actor.userId)
        .first<{ setAt: number }>(),
    ]);
    return c.json({ kioskInUse: inUse, code: mine ? { setAt: mine.setAt } : null });
  })

  /** Make your kiosk code, or a new one in place of the old. Shown this once. */
  .post("/family/kiosk-code", async (c) => {
    const actor = await requirePermission(c, "loans:own");
    if (!actor.family) {
      fail(404, "no_family", "Your sign-in isn't connected to a family, so you can't borrow.");
    }
    const DB = c.env.DB;
    const user = await DB.prepare("select name from users where id = ?")
      .bind(actor.userId)
      .first<{ name: string }>();
    if (!user?.name) {
      fail(422, "name_needed", "Add your first name first, so the kiosk can greet you.");
    }
    await assertCodeBudget(c, `kiosk-code-user:${actor.userId}`, 10);
    await DB.prepare(
      `insert into kiosk_people (id, library_id, family_id, user_id) values (?, ?, ?, ?)
       on conflict (library_id, user_id) where user_id is not null do update set family_id = excluded.family_id`,
    )
      .bind(newId(), actor.library.id, actor.family.id, actor.userId)
      .run();
    const person = await DB.prepare(
      "select id from kiosk_people where library_id = ? and user_id = ?",
    )
      .bind(actor.library.id, actor.userId)
      .first<{ id: string }>();
    if (!person) throw new Error("Kiosk person was not saved");
    const code = await setNewCode(c, actor.library.id, person.id);
    await event(DB, actor.library.id, actor.userId, "kiosk_code_set", {
      familyId: actor.family.id,
      kioskPersonId: person.id,
    }).run();
    return c.json({ code }, 201);
  })

  /** Turn your kiosk code off. */
  .delete("/family/kiosk-code", async (c) => {
    const actor = await requirePermission(c, "loans:own");
    await c.env.DB.prepare(
      "update kiosk_people set code_hash = null, code_set_at = null where library_id = ? and user_id = ?",
    )
      .bind(actor.library.id, actor.userId)
      .run();
    return c.json({ ok: true });
  })

  // ------------------------------------------------- staff: people's codes

  /**
   * Give someone in a family a kiosk code: an adult who signs in (by their
   * user id), or an adult without email (by first name). The code is shown
   * this once, to read out or print.
   */
  .post("/admin/families/:id/kiosk-people", async (c) => {
    const actor = await requirePermission(c, "families:manage");
    const body = await readBody(
      c,
      z.union(
        [z.object({ userId: z.string().min(1).max(100) }), z.object({ firstName: firstNameField })],
        { error: "Enter their first name." },
      ),
    );
    const DB = c.env.DB;
    const lib = actor.library.id;
    const familyId = c.req.param("id");
    const family = await DB.prepare("select 1 from families where id = ? and library_id = ?")
      .bind(familyId, lib)
      .first();
    if (!family) fail(404, "not_found", "That family was not found.");
    await assertCodeBudget(c, `kiosk-codes-library:${lib}`, 200);
    let personId: string;
    if ("userId" in body) {
      const member = await DB.prepare(
        "select 1 from memberships where library_id = ? and family_id = ? and user_id = ?",
      )
        .bind(lib, familyId, body.userId)
        .first();
      if (!member) fail(404, "not_found", "That person isn't in this family.");
      await DB.prepare(
        `insert into kiosk_people (id, library_id, family_id, user_id) values (?, ?, ?, ?)
         on conflict (library_id, user_id) where user_id is not null do update set family_id = excluded.family_id`,
      )
        .bind(newId(), lib, familyId, body.userId)
        .run();
      const row = await DB.prepare(
        "select id from kiosk_people where library_id = ? and user_id = ?",
      )
        .bind(lib, body.userId)
        .first<{ id: string }>();
      if (!row) throw new Error("Kiosk person was not saved");
      personId = row.id;
    } else {
      const count = await DB.prepare(
        "select count(*) as n from kiosk_people where library_id = ? and family_id = ? and user_id is null",
      )
        .bind(lib, familyId)
        .first<number>("n");
      if ((count ?? 0) >= 10) {
        fail(409, "too_many_people", "A family can have up to 10 people without email.");
      }
      personId = newId();
      await DB.prepare(
        "insert into kiosk_people (id, library_id, family_id, first_name) values (?, ?, ?, ?)",
      )
        .bind(personId, lib, familyId, body.firstName)
        .run();
    }
    const code = await setNewCode(c, lib, personId);
    await event(DB, lib, actor.userId, "kiosk_code_set", {
      familyId,
      kioskPersonId: personId,
    }).run();
    return c.json({ code, id: personId }, 201);
  })

  /** A new code for someone (lost or overheard). The old one stops working. */
  .post("/admin/kiosk-people/:id/renew", async (c) => {
    const actor = await requirePermission(c, "families:manage");
    const person = await kioskPerson(c, actor, c.req.param("id"));
    await assertCodeBudget(c, `kiosk-codes-library:${actor.library.id}`, 200);
    const code = await setNewCode(c, actor.library.id, person.id);
    await event(c.env.DB, actor.library.id, actor.userId, "kiosk_code_set", {
      familyId: person.familyId,
      kioskPersonId: person.id,
    }).run();
    return c.json({ code });
  })

  /** Turn someone's code off. They can be given a new one later. */
  .post("/admin/kiosk-people/:id/off", async (c) => {
    const actor = await requirePermission(c, "families:manage");
    const person = await kioskPerson(c, actor, c.req.param("id"));
    await c.env.DB.batch([
      c.env.DB.prepare(
        "update kiosk_people set code_hash = null, code_set_at = null where id = ? and library_id = ?",
      ).bind(person.id, actor.library.id),
      event(c.env.DB, actor.library.id, actor.userId, "kiosk_code_off", {
        familyId: person.familyId,
        kioskPersonId: person.id,
      }),
    ]);
    return c.json({ ok: true });
  })

  /** Remove someone without email from a family (their past kiosk loans stay, without them). */
  .delete("/admin/kiosk-people/:id", async (c) => {
    const actor = await requirePermission(c, "families:manage");
    const person = await kioskPerson(c, actor, c.req.param("id"));
    if (person.userId !== null) {
      fail(409, "has_sign_in", "This person signs in with email. Turn their code off instead.");
    }
    await c.env.DB.batch([
      c.env.DB.prepare("delete from kiosk_people where id = ? and library_id = ?").bind(
        person.id,
        actor.library.id,
      ),
      event(c.env.DB, actor.library.id, actor.userId, "kiosk_person_removed", {
        familyId: person.familyId,
      }),
    ]);
    return c.json({ ok: true });
  })

  /**
   * A family without email: staff add it with its first adult, who borrows
   * at the kiosk with their code. Staff follow its late books up from Loans.
   */
  .post("/admin/families/kiosk-only", async (c) => {
    const actor = await requirePermission(c, "families:manage");
    const body = await readBody(
      c,
      z.object({ familyName: name("Family name", 60), firstName: firstNameField }),
    );
    const DB = c.env.DB;
    const lib = actor.library.id;
    await assertCodeBudget(c, `kiosk-codes-library:${lib}`, 200);
    const familyId = newId();
    const personId = newId();
    await DB.batch([
      DB.prepare(
        "insert into families (id, library_id, name, status) values (?, ?, ?, 'active')",
      ).bind(familyId, lib, body.familyName),
      DB.prepare(
        "insert into kiosk_people (id, library_id, family_id, first_name) values (?, ?, ?, ?)",
      ).bind(personId, lib, familyId, body.firstName),
      event(DB, lib, actor.userId, "family_created", { familyId, kioskOnly: true }),
    ]);
    const code = await setNewCode(c, lib, personId);
    return c.json({ code, familyId, id: personId }, 201);
  });

/** A kiosk person in the actor's library, or 404. */
async function kioskPerson(c: AppContext, actor: Actor, id: string) {
  const person = await c.env.DB.prepare(
    "select id, user_id as userId, family_id as familyId from kiosk_people where id = ? and library_id = ?",
  )
    .bind(id, actor.library.id)
    .first<{ id: string; userId: string | null; familyId: string }>();
  if (!person) fail(404, "not_found", "That person was not found.");
  return person;
}
