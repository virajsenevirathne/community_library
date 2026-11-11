import type { EmailMessage } from "@community-library/adapters";
import {
  addDays,
  daysOverdue,
  dueDateDetails,
  handBackCutoff,
  isClosed,
  type LibrarySettings,
  localParts,
  normalizeShortCode,
} from "@community-library/core";
import { and, asc, eq, isNull, lt, or } from "drizzle-orm";
import { Hono } from "hono";
import {
  type Actor,
  allow,
  canActOnFamily,
  requireBorrower,
  requireMember,
  requirePermission,
  scope,
} from "../access.ts";
import { authSecret } from "../config.ts";
import { type AppContext, type AppEnv, fail } from "../context.ts";
import { type Db, newId, schema } from "../db/client.ts";
import { checkoutEmail, foundEmail } from "../email.ts";
import { consume } from "../limiter.ts";

/*
 * Borrowing and returning. The page for a book is reached by scanning its
 * sticker (/c/K7R2) or typing its code, and offers the one action that makes
 * sense: Borrow, Return, or Found it.
 */

/** Finds a copy by the code on its sticker, in the actor's library, with its open loan. */
async function findCopy(db: Db, actor: Actor, rawCode: string) {
  const code = normalizeShortCode(rawCode);
  const notFound = (): never =>
    fail(
      404,
      "copy_not_found",
      "We couldn't find a book with that code. Check the code under the sticker, or ask staff.",
    );
  if (!code) notFound();
  const row = await db
    .select({
      copyId: schema.copies.id,
      shortCode: schema.copies.shortCode,
      status: schema.copies.status,
      foundAt: schema.copies.foundAt,
      titleId: schema.titles.id,
      title: schema.titles.title,
      authors: schema.titles.authors,
      coverUrl: schema.titles.coverUrl,
      loanId: schema.loans.id,
      loanFamilyId: schema.loans.familyId,
      dueOn: schema.loans.dueOn,
      extendedCount: schema.loans.extendedCount,
      returnRequestedAt: schema.loans.returnRequestedAt,
      familyName: schema.families.name,
    })
    .from(schema.copies)
    .innerJoin(
      schema.titles,
      and(
        eq(schema.titles.id, schema.copies.titleId),
        eq(schema.titles.libraryId, schema.copies.libraryId),
      ),
    )
    .leftJoin(
      schema.loans,
      and(
        eq(schema.loans.copyId, schema.copies.id),
        eq(schema.loans.libraryId, schema.copies.libraryId),
        isNull(schema.loans.returnedAt),
      ),
    )
    .leftJoin(
      schema.families,
      and(
        eq(schema.families.id, schema.loans.familyId),
        eq(schema.families.libraryId, schema.loans.libraryId),
      ),
    )
    .where(scope(actor).where(schema.copies, eq(schema.copies.shortCode, code as string)))
    .get();
  return row ?? notFound();
}

type CopyRow = Awaited<ReturnType<typeof findCopy>>;

function today(settings: LibrarySettings) {
  return localParts(new Date(), settings.timezone).date;
}

/** A new due date `loanDays` after `from`, moved past closed days. */
function extendedDue(from: string, settings: LibrarySettings) {
  let due = addDays(from, settings.loanDays);
  for (let i = 0; i < 400 && isClosed(due, settings); i++) due = addDays(due, 1);
  return due;
}

/** How many books the actor's family has out right now. */
async function openLoanCount(db: Db, actor: Actor) {
  if (!actor.family) return 0;
  const s = scope(actor);
  return db.$count(
    schema.loans,
    s.where(
      schema.loans,
      s.ownFamily(schema.loans.familyId),
      isNull(schema.loans.returnedAt),
      // Books handed back recently (waiting for staff check-in) don't count towards the limit.
      or(
        isNull(schema.loans.returnRequestedAt),
        lt(schema.loans.returnRequestedAt, new Date(handBackCutoff())),
      ),
    ),
  );
}

/** The copy as the actor may see it. Only staff are told which family has it. */
async function copyView(db: Db, actor: Actor, row: CopyRow) {
  const mine = row.loanId !== null && actor.family !== null && row.loanFamilyId === actor.family.id;
  const state: "available" | "mine" | "out" | "unavailable" =
    row.status !== "available"
      ? "unavailable"
      : row.loanId === null
        ? "available"
        : mine
          ? "mine"
          : "out";
  const settings = actor.library.settings;
  const isStaff = allow(actor, "loans:manage");
  const booksOut = await openLoanCount(db, actor);
  /** The family handed it back; it waits for staff to check it in. */
  const handedBack = row.returnRequestedAt !== null && row.loanId !== null;
  return {
    code: row.shortCode,
    title: { id: row.titleId, title: row.title, authors: row.authors, coverUrl: row.coverUrl },
    state,
    status: row.status,
    loan:
      row.loanId && row.dueOn && (mine || isStaff)
        ? {
            id: row.loanId,
            dueOn: row.dueOn,
            overdueDays: daysOverdue(row.dueOn, today(settings)),
            canExtend: mine && !handedBack && (row.extendedCount ?? 0) < settings.maxExtensions,
            extensionsLeft: Math.max(0, settings.maxExtensions - (row.extendedCount ?? 0)),
            handedBack,
            ...(isStaff ? { familyName: row.familyName ?? "Deleted family" } : {}),
          }
        : null,
    reportedFound: row.foundAt !== null,
    family: actor.family
      ? { status: actor.family.status, booksOut, maxLoans: settings.maxLoans }
      : null,
    can: {
      borrow:
        state === "available" && actor.family?.status === "active" && booksOut < settings.maxLoans,
      // A handed-back book can still be returned by its family if the library
      // has since switched to self-serve returns.
      return:
        (state === "mine" && (!handedBack || !settings.returnsNeedCheckIn)) ||
        (state === "out" && isStaff) ||
        (handedBack && isStaff),
      reportFound: state === "out" && !isStaff && row.foundAt === null,
    },
  };
}

/** Emails of every parent in a family (each family member with a sign-in). */
async function familyEmails(db: Db, actor: Actor, familyId: string) {
  const rows = await db
    .select({ email: schema.users.email })
    .from(schema.memberships)
    .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
    .where(scope(actor).where(schema.memberships, eq(schema.memberships.familyId, familyId)))
    .all();
  return rows.map((r) => r.email);
}

/** Tells every parent in the family what they borrowed, with all their books out. */
async function sendCheckoutEmails(
  c: AppContext,
  actor: Actor & { family: { id: string } },
  borrowed: { title: string; dueOn: string },
) {
  const db = c.get("db");
  const s = scope(actor);
  const [emails, booksOut] = await Promise.all([
    familyEmails(db, actor, actor.family.id),
    db
      .select({ title: schema.titles.title, dueOn: schema.loans.dueOn })
      .from(schema.loans)
      .innerJoin(
        schema.copies,
        and(
          eq(schema.copies.id, schema.loans.copyId),
          eq(schema.copies.libraryId, schema.loans.libraryId),
        ),
      )
      .innerJoin(
        schema.titles,
        and(
          eq(schema.titles.id, schema.copies.titleId),
          eq(schema.titles.libraryId, schema.copies.libraryId),
        ),
      )
      .where(
        s.where(schema.loans, s.ownFamily(schema.loans.familyId), isNull(schema.loans.returnedAt)),
      )
      .orderBy(asc(schema.loans.dueOn))
      .all(),
  ]);
  await sendEach(
    c,
    "Checkout",
    emails.map((to) =>
      checkoutEmail({
        libraryName: actor.library.name,
        to,
        siteUrl: c.get("origin"),
        borrowed,
        booksOut,
      }),
    ),
  );
}

/** Sends each message on its own, so one failure (or a provider error) never skips the others. */
async function sendEach(c: AppContext, kind: string, messages: EmailMessage[]) {
  const results = await Promise.allSettled(messages.map((m) => c.get("email").send(m)));
  for (const result of results) {
    if (result.status === "rejected")
      console.error(`${kind} email failed: ${String(result.reason)}`);
    else if (!result.value.ok) {
      console.error(`${kind} email failed via ${result.value.provider}: ${result.value.error}`);
    }
  }
}

/** Runs background work, logging instead of losing an error. */
function inBackground(c: AppContext, work: Promise<unknown>) {
  c.get("waitUntil")(work.catch((error) => console.error("Background work failed:", error)));
}

/**
 * An audit event that is only written when `condition` (SQL, with its own
 * parameters) is true at that moment in the batch, so a refused or repeated
 * action leaves no event.
 */
function eventIf(
  DB: D1Database,
  actor: Actor,
  type: string,
  payload: Record<string, unknown>,
  condition: string,
  ...params: unknown[]
) {
  return DB.prepare(
    `insert into events (id, library_id, actor_user_id, type, payload) select ?, ?, ?, ?, ? where ${condition}`,
  ).bind(newId(), actor.library.id, actor.userId, type, JSON.stringify(payload), ...params);
}

export const loanRoutes = new Hono<AppEnv>()
  .get("/copies/:code", async (c) => {
    const actor = await requireMember(c);
    const db = c.get("db");
    const row = await findCopy(db, actor, c.req.param("code"));
    return c.json({ copy: await copyView(db, actor, row) });
  })

  /**
   * Borrow a copy. The limit check and the insert are one SQL statement, and a
   * copy can only have one open loan (a unique index), so two parents scanning
   * at the same moment can neither both get it nor pass their family's limit.
   * Borrowing a book your family already has is answered as a success.
   */
  .post("/copies/:code/borrow", async (c) => {
    const actor = await requireBorrower(c);
    const db = c.get("db");
    const row = await findCopy(db, actor, c.req.param("code"));
    if (row.loanId && row.loanFamilyId === actor.family.id) {
      if (row.returnRequestedAt !== null) {
        // "Tapped Return by mistake": keep the book after all. Only while the
        // family is under its limit, so hand-backs can't be used to borrow more.
        const DB = c.env.DB;
        const [undone] = await DB.batch([
          DB.prepare(
            `update loans set return_requested_at = null
             where id = ?1 and library_id = ?2 and returned_at is null and return_requested_at is not null
               and (select count(*) from loans where library_id = ?2 and family_id = ?3 and returned_at is null
                    and (return_requested_at is null or return_requested_at < ?4)) < ?5`,
          ).bind(
            row.loanId,
            actor.library.id,
            actor.family.id,
            handBackCutoff(),
            actor.library.settings.maxLoans,
          ),
          DB.prepare(
            `insert into events (id, library_id, actor_user_id, type, payload)
             select ?, ?, ?, 'loan_handback_undone', ? where changes() = 1`,
          ).bind(newId(), actor.library.id, actor.userId, JSON.stringify({ loanId: row.loanId })),
        ]);
        const now = await findCopy(db, actor, row.shortCode);
        if (undone?.meta.changes !== 1) {
          if (now.loanId === null) {
            return c.json({ copy: await copyView(db, actor, now), alreadyReturned: true });
          }
          fail(
            409,
            "limit_reached",
            `Your family already has ${actor.library.settings.maxLoans} books out, the most allowed. Return one first.`,
          );
        }
        return c.json({ copy: await copyView(db, actor, now), alreadyYours: true });
      }
      return c.json({ copy: await copyView(db, actor, row), alreadyYours: true });
    }
    if (row.status !== "available") {
      fail(409, "unavailable", "This copy can't be borrowed right now. Please give it to staff.");
    }
    if (row.loanId) {
      fail(
        409,
        "on_loan",
        "Another family has this book out. If you found it lying around, tap “Found it” instead.",
      );
    }

    const settings = actor.library.settings;
    const now = new Date();
    const { due, movedForClosure } = dueDateDetails(now, settings);
    const loanId = newId();
    let inserted = 0;
    try {
      const DB = c.env.DB;
      // D1's own batch: one transaction, so the event only exists if the loan does.
      const [result] = await DB.batch([
        DB.prepare(
          `insert into loans (id, library_id, copy_id, family_id, borrowed_by, borrowed_at, due_on)
           select ?1, ?2, ?3, ?4, ?5, ?6, ?7
           where (select count(*) from loans
                  where library_id = ?2 and family_id = ?4 and returned_at is null
                    and (return_requested_at is null or return_requested_at < ?9)) < ?8
             and exists (select 1 from copies where id = ?3 and library_id = ?2 and status = 'available')`,
        ).bind(
          loanId,
          actor.library.id,
          row.copyId,
          actor.family.id,
          actor.userId,
          now.getTime(),
          due,
          settings.maxLoans,
          handBackCutoff(),
        ),
        eventIf(
          DB,
          actor,
          "loan_created",
          { loanId, copyId: row.copyId, titleId: row.titleId, familyId: actor.family.id },
          "exists (select 1 from loans where id = ?)",
          loanId,
        ),
        // A "found" flag from an earlier loan must not carry over to this one.
        DB.prepare(
          "update copies set found_at = null, found_by = null where id = ? and found_at is not null and exists (select 1 from loans where id = ?)",
        ).bind(row.copyId, loanId),
      ]);
      if (!result) throw new Error("D1 batch returned no result");
      inserted = result.meta.changes;
    } catch (error) {
      if (!/UNIQUE/.test(String(error))) throw error;
      // Both parents of one family scanned it at once: the other one got it for the family.
      const now = await findCopy(db, actor, row.shortCode);
      if (now.loanFamilyId === actor.family.id) {
        return c.json({ copy: await copyView(db, actor, now), alreadyYours: true });
      }
      fail(409, "on_loan", "Someone borrowed this book a moment ago.");
    }
    if (inserted !== 1) {
      const out = await openLoanCount(db, actor);
      if (out >= settings.maxLoans) {
        fail(
          409,
          "limit_reached",
          `Your family already has ${settings.maxLoans} books out, the most allowed. Return one to borrow another.`,
        );
      }
      fail(409, "unavailable", "This copy can't be borrowed right now. Please give it to staff.");
    }

    inBackground(c, sendCheckoutEmails(c, actor, { title: row.title, dueOn: due }));
    const updated = await findCopy(db, actor, row.shortCode);
    return c.json({ copy: await copyView(db, actor, updated), dueOn: due, movedForClosure }, 201);
  })

  /**
   * Return a copy: your own family's book, or any book for staff (bulk
   * return). Returning a book that is already back is answered as a success.
   */
  .post("/copies/:code/return", async (c) => {
    const actor = await requirePermission(c, "loans:own");
    const db = c.get("db");
    const row = await findCopy(db, actor, c.req.param("code"));
    if (!row.loanId) {
      return c.json({ copy: await copyView(db, actor, row), alreadyReturned: true });
    }
    if (!canActOnFamily(actor, row.loanFamilyId)) {
      fail(
        403,
        "not_your_loan",
        "This book is out with another family, so it can't be returned from your account. If you found it, tap “Found it”, or put it in the returns basket.",
      );
    }
    const DB = c.env.DB;
    if (actor.library.settings.returnsNeedCheckIn && !allow(actor, "loans:manage")) {
      // The library checks returns in: record the hand-back; staff close the loan.
      // A repeat tap changes nothing and writes no second event.
      await DB.batch([
        DB.prepare(
          "update loans set return_requested_at = ? where id = ? and library_id = ? and returned_at is null and return_requested_at is null",
        ).bind(Date.now(), row.loanId, actor.library.id),
        DB.prepare(
          `insert into events (id, library_id, actor_user_id, type, payload)
           select ?, ?, ?, 'loan_handed_back', ? where changes() = 1`,
        ).bind(
          newId(),
          actor.library.id,
          actor.userId,
          JSON.stringify({ loanId: row.loanId, copyId: row.copyId }),
        ),
      ]);
      const handed = await findCopy(db, actor, row.shortCode);
      return c.json({ copy: await copyView(db, actor, handed), pendingCheckIn: true });
    }
    const returnedAt = Date.now();
    const wasFound = row.foundAt !== null;
    // "We closed it" = the loan now carries exactly this return's time and person.
    const closedByUs =
      "exists (select 1 from loans where id = ? and returned_at = ? and returned_by = ?)";
    const [closed] = await DB.batch([
      DB.prepare(
        "update loans set returned_at = ?, returned_by = ?, outcome = 'returned' where id = ? and library_id = ? and returned_at is null",
      ).bind(returnedAt, actor.userId, row.loanId, actor.library.id),
      DB.prepare(
        `update copies set found_at = null, found_by = null where id = ? and library_id = ? and ${closedByUs}`,
      ).bind(row.copyId, actor.library.id, row.loanId, returnedAt, actor.userId),
      eventIf(
        DB,
        actor,
        "loan_returned",
        {
          loanId: row.loanId,
          copyId: row.copyId,
          familyId: row.loanFamilyId,
          byStaff: row.loanFamilyId !== actor.family?.id,
          wasFound,
        },
        closedByUs,
        row.loanId,
        returnedAt,
        actor.userId,
      ),
    ]);
    if (closed?.meta.changes !== 1) {
      // Someone else returned it a moment ago.
      const now = await findCopy(db, actor, row.shortCode);
      return c.json({ copy: await copyView(db, actor, now), alreadyReturned: true });
    }
    const updated = await findCopy(db, actor, row.shortCode);
    return c.json({
      copy: await copyView(db, actor, updated),
      returned: {
        title: row.title,
        overdueDays: row.dueOn ? daysOverdue(row.dueOn, today(actor.library.settings)) : 0,
        wasFound,
        // Staff doing a bulk return see whose book it was.
        ...(allow(actor, "loans:manage") ? { familyName: row.familyName ?? "Deleted family" } : {}),
      },
    });
  })

  /**
   * "Found it": a member found a book another family has out. The copy is
   * flagged for staff, who confirm it when it is scanned in. It never closes
   * the loan by itself. The borrowing family is told by email.
   */
  .post("/copies/:code/found", async (c) => {
    const actor = await requirePermission(c, "copies:report-found");
    const db = c.get("db");
    const row = await findCopy(db, actor, c.req.param("code"));
    if (!row.loanId) {
      return c.json({ copy: await copyView(db, actor, row), notOnLoan: true });
    }
    if (actor.family && row.loanFamilyId === actor.family.id) {
      fail(409, "yours", "Your family has this book. Tap “Return” instead.");
    }
    if (row.foundAt === null) {
      // Each report emails a family, so limit how often one person (and the library) can report.
      const secret = authSecret(c.env);
      for (const [key, max] of [
        [`found:user:${actor.userId}`, 10],
        [`found:library:${actor.library.id}`, 30],
      ] as const) {
        const limit = await consume(c.env.DB, secret, key, { window: 3600, max });
        if (!limit.allowed) {
          fail(
            429,
            "too_many_reports",
            "Thanks! That's a lot of found books. Please hand the rest to staff.",
          );
        }
      }
      const DB = c.env.DB;
      const flaggedAt = Date.now();
      // Only flag a copy that is still out with another family and not yet flagged.
      const [flagged] = await DB.batch([
        DB.prepare(
          `update copies set found_at = ?, found_by = ?
           where id = ? and library_id = ? and found_at is null
             and exists (select 1 from loans where copy_id = ? and library_id = ? and returned_at is null
                         and family_id is not ?)`,
        ).bind(
          flaggedAt,
          actor.userId,
          row.copyId,
          actor.library.id,
          row.copyId,
          actor.library.id,
          actor.family?.id ?? null,
        ),
        eventIf(
          DB,
          actor,
          "copy_found",
          { loanId: row.loanId, copyId: row.copyId, familyId: row.loanFamilyId },
          "exists (select 1 from copies where id = ? and found_at = ? and found_by = ?)",
          row.copyId,
          flaggedAt,
          actor.userId,
        ),
      ]);
      if (flagged?.meta.changes === 1 && row.loanFamilyId && row.dueOn) {
        const familyId = row.loanFamilyId;
        const dueOn = row.dueOn;
        inBackground(
          c,
          familyEmails(db, actor, familyId).then((emails) =>
            sendEach(
              c,
              "Found",
              emails.map((to) =>
                foundEmail({
                  libraryName: actor.library.name,
                  to,
                  title: row.title,
                  dueOn,
                  siteUrl: c.get("origin"),
                }),
              ),
            ),
          ),
        );
      }
    }
    const updated = await findCopy(db, actor, row.shortCode);
    return c.json({ copy: await copyView(db, actor, updated) });
  })

  /** The signed-in family's books that are out, soonest due first. */
  .get("/loans/mine", async (c) => {
    const actor = await requireMember(c);
    const db = c.get("db");
    const s = scope(actor);
    const settings = actor.library.settings;
    const rows = await db
      .select({
        id: schema.loans.id,
        dueOn: schema.loans.dueOn,
        extendedCount: schema.loans.extendedCount,
        returnRequestedAt: schema.loans.returnRequestedAt,
        code: schema.copies.shortCode,
        title: schema.titles.title,
        authors: schema.titles.authors,
        coverUrl: schema.titles.coverUrl,
      })
      .from(schema.loans)
      .innerJoin(
        schema.copies,
        and(
          eq(schema.copies.id, schema.loans.copyId),
          eq(schema.copies.libraryId, schema.loans.libraryId),
        ),
      )
      .innerJoin(
        schema.titles,
        and(
          eq(schema.titles.id, schema.copies.titleId),
          eq(schema.titles.libraryId, schema.copies.libraryId),
        ),
      )
      .where(
        s.where(schema.loans, s.ownFamily(schema.loans.familyId), isNull(schema.loans.returnedAt)),
      )
      .orderBy(asc(schema.loans.dueOn))
      .all();
    const now = today(settings);
    return c.json({
      loans: rows.map((r) => ({
        id: r.id,
        code: r.code,
        title: r.title,
        authors: r.authors,
        coverUrl: r.coverUrl,
        dueOn: r.dueOn,
        overdueDays: daysOverdue(r.dueOn, now),
        canExtend: r.returnRequestedAt === null && r.extendedCount < settings.maxExtensions,
        handedBack: r.returnRequestedAt !== null,
      })),
      maxLoans: settings.maxLoans,
      loanDays: settings.loanDays,
    });
  })

  /** Keep a book longer: a new due date one loan length from today (or the due date, if later). */
  .post("/loans/:id/extend", async (c) => {
    const actor = await requirePermission(c, "loans:own");
    const db = c.get("db");
    const s = scope(actor);
    const settings = actor.library.settings;
    const loan = await db.query.loans.findFirst({
      columns: {
        id: true,
        familyId: true,
        dueOn: true,
        extendedCount: true,
        returnRequestedAt: true,
      },
      where: s.where(
        schema.loans,
        eq(schema.loans.id, c.req.param("id")),
        isNull(schema.loans.returnedAt),
      ),
    });
    if (!loan || !canActOnFamily(actor, loan.familyId)) {
      fail(404, "not_found", "That loan was not found. The book may already be back.");
    }
    if (loan.returnRequestedAt !== null) {
      fail(409, "handed_back", "This book has been handed back, so it can't be extended.");
    }
    if (loan.extendedCount >= settings.maxExtensions) {
      fail(
        409,
        "no_more_extensions",
        settings.maxExtensions === 0
          ? "Loans can't be extended at this library."
          : `This book has already been extended ${settings.maxExtensions === 1 ? "once" : `${settings.maxExtensions} times`}. Please bring it back.`,
      );
    }
    const now = today(settings);
    // Dates are YYYY-MM-DD strings, so the later one is the larger string.
    const from = [loan.dueOn, now].sort().at(-1) ?? now;
    const dueOn = extendedDue(from, settings);
    const DB = c.env.DB;
    const [result] = await DB.batch([
      DB.prepare(
        "update loans set due_on = ?, extended_count = ? where id = ? and library_id = ? and extended_count = ? and returned_at is null",
      ).bind(dueOn, loan.extendedCount + 1, loan.id, actor.library.id, loan.extendedCount),
      eventIf(
        DB,
        actor,
        "loan_extended",
        { loanId: loan.id, familyId: loan.familyId, from: loan.dueOn, to: dueOn },
        "exists (select 1 from loans where id = ? and due_on = ? and extended_count = ?)",
        loan.id,
        dueOn,
        loan.extendedCount + 1,
      ),
    ]);
    if (result?.meta.changes !== 1) {
      fail(409, "changed_meanwhile", "This loan just changed. Please refresh.");
    }
    return c.json({ dueOn });
  });
