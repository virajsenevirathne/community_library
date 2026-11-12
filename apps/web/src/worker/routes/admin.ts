import {
  daysOverdue,
  handBackCutoff,
  localParts,
  mergeSettings,
  needsStaff,
  SETTING_LABELS,
} from "@community-library/core";
import { Hono } from "hono";
import { z } from "zod";
import { type Actor, isPlatformOwner, requirePermission } from "../access.ts";
import { authSecret } from "../config.ts";
import { type AppContext, type AppEnv, fail, readBody } from "../context.ts";
import { hmacHex, timingSafeEqual } from "../crypto.ts";
import { newId } from "../db/client.ts";
import { reminderEmail } from "../email.ts";
import { JOB_NAME, nudgesOffUrl, STALE_AFTER_MS } from "../jobs/reminders.ts";
import { libraryById, libraryHome } from "../library.ts";
import { clientIp, consume } from "../limiter.ts";
import { PROVIDER_LIMITS, type QuotaMailer } from "../mailer.ts";
import { name } from "./account.ts";
import { extendLinkToken, extendLoan, tellWaitingFamily } from "./loans.ts";

/*
 * Staff screens: the dashboard ("who has what, and what is late"), the loans
 * list with its actions, and (admins only) the library's settings. All
 * queries are raw SQL with the library id bound, because they aggregate.
 */

function today(actor: Actor) {
  return localParts(new Date(), actor.library.settings.timezone).date;
}

interface LoanRow {
  id: string;
  dueOn: string;
  borrowedAt: number;
  extendedCount: number;
  foundAt: number | null;
  handedBackAt: number | null;
  code: string;
  copyId: string;
  title: string;
  titleId: string;
  familyId: string | null;
  familyName: string | null;
  /** Borrowed at a kiosk: who typed their code ("" when they've since been removed). */
  kioskName: string | null;
  /** Someone in the family has an email address for reminders. */
  hasEmail: number;
}

async function openLoans(c: AppContext, actor: Actor): Promise<LoanRow[]> {
  const { results } = await c.env.DB.prepare(
    `select l.id as id, l.due_on as dueOn, l.borrowed_at as borrowedAt, l.extended_count as extendedCount,
            c.found_at as foundAt, l.return_requested_at as handedBackAt, c.short_code as code, c.id as copyId, t.title as title, t.id as titleId,
            l.family_id as familyId, f.name as familyName,
            case when l.kiosk_device_id is null then null
                 else coalesce(nullif(ku.name, ''), k.first_name, '') end as kioskName,
            exists (select 1 from memberships m where m.library_id = l.library_id
                    and m.family_id = l.family_id) as hasEmail
     from loans l
     join copies c on c.id = l.copy_id and c.library_id = l.library_id
     join titles t on t.id = c.title_id and t.library_id = c.library_id
     left join families f on f.id = l.family_id and f.library_id = l.library_id
     left join kiosk_people k on k.id = l.kiosk_person_id and k.library_id = l.library_id
     left join users ku on ku.id = k.user_id
     where l.library_id = ? and l.returned_at is null
     order by l.due_on, t.title`,
  )
    .bind(actor.library.id)
    .all<LoanRow>();
  return results;
}

/** The goal for borrowing: from opening the book to "Enjoy the book!". */
export const BORROW_GOAL_MS = 10_000;

/**
 * How quick borrowing is: the share of borrows done within the goal, and the
 * time 9 in 10 borrows beat. Too few borrows say nothing, so none below 5.
 */
export function borrowSpeed(times: number[]) {
  if (times.length < 5) return null;
  const sorted = [...times].sort((a, b) => a - b);
  const p90 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.9) - 1)] ?? 0;
  return {
    borrows: sorted.length,
    withinGoal: sorted.filter((t) => t <= BORROW_GOAL_MS).length / sorted.length,
    p90Seconds: Math.round(p90 / 100) / 10,
    goalSeconds: BORROW_GOAL_MS / 1000,
  };
}

function loanView(actor: Actor, loan: LoanRow, now: string) {
  const overdueDays = daysOverdue(loan.dueOn, now);
  return {
    id: loan.id,
    code: loan.code,
    title: loan.title,
    titleId: loan.titleId,
    familyId: loan.familyId,
    familyName: loan.familyName ?? "Deleted family",
    kioskName: loan.kioskName,
    hasEmail: loan.hasEmail === 1,
    dueOn: loan.dueOn,
    overdueDays,
    needsStaff: needsStaff(loan.dueOn, now, actor.library.settings.staffFlagDays),
    reportedFound: loan.foundAt !== null,
    /** The family handed it back; staff still need to check it in. */
    handedBack: loan.handedBackAt !== null,
    /** Handed back within the grace period: not counted as overdue yet. */
    recentlyHandedBack: loan.handedBackAt !== null && loan.handedBackAt >= handBackCutoff(),
    handedBackDaysAgo:
      loan.handedBackAt === null ? null : Math.floor((Date.now() - loan.handedBackAt) / 86_400_000),
    canExtend:
      loan.handedBackAt === null && loan.extendedCount < actor.library.settings.maxExtensions,
  };
}

const markBody = z.object({
  outcome: z.enum(["returned", "lost", "damaged"], { error: "Choose returned, lost or damaged." }),
});

const settingsBody = z
  .object({ libraryName: name("Library name", 80).optional() })
  .catchall(z.unknown());

/**
 * At most this many outgoing email requests per request: a Worker may make only
 * 50, and a send that falls back to the second provider makes two.
 */
export const MAX_REMINDER_REQUESTS = 40;
const MAX_BULK_LOANS = 100;
/** A claim left "pending" this long (the request died mid-send) can be taken over. */
const PENDING_TIMEOUT_MS = 15 * 60 * 1000;

interface RemindLoan {
  id: string;
  dueOn: string;
  familyId: string | null;
  title: string;
}

const remindLoanQuery = `select l.id as id, l.due_on as dueOn, l.family_id as familyId, t.title as title
  from loans l
  join copies c on c.id = l.copy_id and c.library_id = l.library_id
  join titles t on t.id = c.title_id and t.library_id = c.library_id
  where l.library_id = ? and l.returned_at is null and l.id in (select value from json_each(?))
  order by l.due_on, t.title`;

const reminderKey = (loanId: string, now: string) => `manual:${loanId}:${now}`;

/**
 * Sends each family one reminder email (per parent) listing its loans. Each
 * loan's key must already be claimed as "pending": a sent family's keys are
 * marked "sent", and every other key is released (even after an error) so it
 * can be tried again. Stops at the request budget or when today's routine
 * quota runs out.
 */
async function remindFamilies(
  c: AppContext,
  actor: Actor,
  families: Map<string, RemindLoan[]>,
  now: string,
) {
  const DB = c.env.DB;
  const result = {
    reminded: 0,
    books: 0,
    deferred: 0,
    failed: 0,
    notYet: 0,
    noEmail: 0,
    sentLoanIds: [] as string[],
  };
  const allKeys = [...families.values()].flat().map((l) => reminderKey(l.id, now));
  try {
    const { results: parents } = await DB.prepare(
      `select m.family_id as familyId, u.email as email from memberships m join users u on u.id = m.user_id
       where m.library_id = ? and m.family_id in (select value from json_each(?))`,
    )
      .bind(actor.library.id, JSON.stringify([...families.keys()]))
      .all<{ familyId: string; email: string }>();
    // In production this is the QuotaMailer; other senders ignore the priority.
    const mailer = c.get("email") as Pick<QuotaMailer, "send">;
    let requests = 0;
    let quotaHit = false;

    for (const [familyId, loans] of families) {
      const to = parents.filter((p) => p.familyId === familyId).map((p) => p.email);
      if (to.length === 0) {
        result.noEmail += 1;
        continue;
      }
      if (quotaHit) {
        result.deferred += 1;
        continue;
      }
      // Budget for the worst case (every send falls back), but always try one family.
      if (requests > 0 && requests + to.length * 2 > MAX_REMINDER_REQUESTS) {
        result.notYet += 1;
        continue;
      }
      let delivered = 0;
      try {
        const offUrl = await nudgesOffUrl(c.env, c.get("origin"), familyId);
        const lines = loans.map((loan) => {
          const overdueDays = daysOverdue(loan.dueOn, now);
          return {
            title: loan.title,
            dueOn: loan.dueOn,
            kind: overdueDays > 0 ? ("overdue" as const) : ("due_soon" as const),
            overdueDays,
          };
        });
        for (const email of to) {
          const message = reminderEmail({
            libraryName: actor.library.name,
            to: email,
            siteUrl: libraryHome(c.get("origin"), actor.library),
            nudgesOffUrl: offUrl,
            lines,
          });
          // Routine: a reminder must never use up the emails kept for sign-in codes.
          const sent = await mailer.send(message, "routine");
          requests += sent.attempts ?? 1;
          if (sent.ok) delivered += 1;
          else if (sent.error === "deferred_quota") quotaHit = true;
        }
      } catch {
        // Counted as failed below; its keys are released so it can be tried again.
      }
      if (delivered > 0) {
        result.reminded += 1;
        result.books += loans.length;
        result.sentLoanIds.push(...loans.map((l) => l.id));
      } else if (quotaHit) result.deferred += 1;
      else result.failed += 1;
    }
  } finally {
    const sentKeys = result.sentLoanIds.map((id) => reminderKey(id, now));
    const sent = new Set(sentKeys);
    await DB.batch([
      DB.prepare(
        "update notifications set status = 'sent' where dedupe_key in (select value from json_each(?))",
      ).bind(JSON.stringify(sentKeys)),
      DB.prepare(
        "delete from notifications where status = 'pending' and dedupe_key in (select value from json_each(?))",
      ).bind(JSON.stringify(allKeys.filter((k) => !sent.has(k)))),
    ]);
  }
  return result;
}

/**
 * Claims today's reminder key for each loan; returns the loans whose key was
 * free (or left pending by a request that died more than 15 minutes ago).
 */
async function claimReminders(c: AppContext, actor: Actor, loans: RemindLoan[], now: string) {
  if (loans.length === 0) return [];
  const DB = c.env.DB;
  const at = Date.now();
  const claims = await DB.batch<{ id: string }>(
    loans.map((loan) =>
      DB.prepare(
        `insert into notifications (id, library_id, family_id, kind, dedupe_key, status, created_at)
         values (?1, ?2, ?3, 'manual_reminder', ?4, 'pending', ?5)
         on conflict (dedupe_key) do update set created_at = ?5
           where notifications.status = 'pending' and notifications.created_at < ?6
         returning id`,
      ).bind(
        newId(),
        actor.library.id,
        loan.familyId,
        reminderKey(loan.id, now),
        at,
        at - PENDING_TIMEOUT_MS,
      ),
    ),
  );
  return loans.filter((_, i) => (claims[i]?.results.length ?? 0) > 0);
}

const groupByFamily = (loans: RemindLoan[]) => {
  const families = new Map<string, RemindLoan[]>();
  for (const loan of loans) {
    if (!loan.familyId) continue;
    families.set(loan.familyId, [...(families.get(loan.familyId) ?? []), loan]);
  }
  return families;
};

const quotaMessage =
  "Today's emails are nearly used up, so reminders wait until tomorrow. Sign-in codes still work.";

const bulkRemindBody = z.object({
  loanIds: z
    .array(z.string().max(64))
    .min(1, "Choose at least one loan.")
    .max(MAX_BULK_LOANS, `Choose up to ${MAX_BULK_LOANS} loans at a time.`),
});

export const adminRoutes = new Hono<AppEnv>()
  .get("/dashboard", async (c) => {
    const actor = await requirePermission(c, "loans:manage");
    const DB = c.env.DB;
    const now = today(actor);
    const loans = (await openLoans(c, actor)).map((l) => loanView(actor, l, now));
    const weekAhead = new Date(`${now}T00:00:00Z`);
    weekAhead.setUTCDate(weekAhead.getUTCDate() + 7);
    const weekEnd = weekAhead.toISOString().slice(0, 10);
    const ninetyDaysAgo = Date.now() - 90 * 86_400_000;

    const thirtyDaysAgo = Date.now() - 30 * 86_400_000;
    const [popular, counts, job, neverBorrowed, timings] = await Promise.all([
      DB.prepare(
        `select t.id as id, t.title as title, count(*) as times
         from loans l
         join copies c on c.id = l.copy_id and c.library_id = l.library_id
         join titles t on t.id = c.title_id and t.library_id = c.library_id
         where l.library_id = ? and l.borrowed_at >= ?
         group by t.id order by times desc, t.title limit 5`,
      )
        .bind(actor.library.id, ninetyDaysAgo)
        .all<{ id: string; title: string; times: number }>(),
      DB.prepare(
        `select (select count(*) from titles where library_id = ?1) as titles,
                (select count(*) from copies where library_id = ?1 and status != 'retired') as copies,
                (select count(*) from families where library_id = ?1 and status = 'active') as families,
                (select count(*) from families where library_id = ?1 and status = 'pending') as pendingFamilies,
                (select count(*) from copies where library_id = ?1 and label_printed_at is null and status != 'retired') as needLabels`,
      )
        .bind(actor.library.id)
        .first<Record<string, number>>(),
      DB.prepare(
        "select started_at as startedAt, finished_at as finishedAt, error from job_runs where name = ?",
      )
        .bind(JOB_NAME)
        .first<{ startedAt: number; finishedAt: number | null; error: string | null }>(),
      // Books on the shelf that nobody has borrowed yet, oldest first.
      DB.prepare(
        `select t.id as id, t.title as title, count(*) over () as total
         from titles t
         where t.library_id = ?1
           and exists (select 1 from copies c where c.title_id = t.id and c.library_id = t.library_id
                       and c.status = 'available')
           and not exists (select 1 from copies c join loans l on l.copy_id = c.id and l.library_id = c.library_id
                           where c.title_id = t.id and c.library_id = t.library_id)
         order by t.created_at, t.title limit 5`,
      )
        .bind(actor.library.id)
        .all<{ id: string; title: string; total: number }>(),
      // How long borrows took, from opening the book to "Enjoy the book!".
      DB.prepare(
        `select json_extract(payload, '$.elapsedMs') as ms from events
         where library_id = ? and type = 'loan_created' and created_at >= ?
           and json_extract(payload, '$.elapsedMs') > 0`,
      )
        .bind(actor.library.id, thirtyDaysAgo)
        .all<{ ms: number }>(),
    ]);

    const mailer = c.get("email") as Partial<QuotaMailer>;
    const emailLeft =
      typeof mailer.remainingToday === "function" ? await mailer.remainingToday() : null;
    const lastFinished = job?.finishedAt ?? null;
    return c.json({
      today: now,
      booksOut: loans.length,
      overdue: loans.filter((l) => l.overdueDays > 0 && !l.recentlyHandedBack).length,
      needsStaff: loans.filter(
        (l) => (l.needsStaff && !l.recentlyHandedBack) || (l.handedBack && !l.recentlyHandedBack),
      ).length,
      dueThisWeek: loans.filter((l) => l.overdueDays === 0 && l.dueOn <= weekEnd).length,
      reportedFound: loans.filter((l) => l.reportedFound).length,
      waitingForCheckIn: loans.filter((l) => l.handedBack).length,
      returnsNeedCheckIn: actor.library.settings.returnsNeedCheckIn,
      mostBorrowed: popular.results,
      neverBorrowed: {
        total: neverBorrowed.results[0]?.total ?? 0,
        titles: neverBorrowed.results.map((t) => ({ id: t.id, title: t.title })),
      },
      borrowSpeed: borrowSpeed(timings.results.map((t) => t.ms)),
      counts,
      reminders: {
        lastRun: lastFinished,
        // A missed run is a problem only once there is something to remind about.
        stale:
          lastFinished === null ? loans.length > 0 : Date.now() - lastFinished > STALE_AFTER_MS,
        // The job runs for every library, so its raw error text is for the
        // site's owner only; everyone else sees that it failed.
        error: job?.error
          ? (await isPlatformOwner(c))
            ? job.error
            : "The last run had a problem."
          : null,
      },
      email: {
        leftToday: emailLeft === Number.POSITIVE_INFINITY ? null : emailLeft,
        dailyLimit: Object.values(PROVIDER_LIMITS).reduce((sum, l) => sum + l.day, 0),
      },
    });
  })

  /** Open loans, optionally only overdue, needing staff follow-up, or reported found. */
  .get("/loans", async (c) => {
    const actor = await requirePermission(c, "loans:manage");
    const filter = c.req.query("filter") ?? "all";
    const now = today(actor);
    const loans = (await openLoans(c, actor)).map((l) => loanView(actor, l, now));
    const weekEnd = new Date(`${now}T00:00:00Z`);
    weekEnd.setUTCDate(weekEnd.getUTCDate() + 7);
    const dueBy = weekEnd.toISOString().slice(0, 10);
    // One rule per filter, so the list and the counts on the filter buttons agree.
    const rules: Record<string, (l: (typeof loans)[number]) => boolean> = {
      all: () => true,
      overdue: (l) => l.overdueDays > 0 && !l.recentlyHandedBack,
      "due-soon": (l) => l.overdueDays === 0 && l.dueOn <= dueBy && !l.handedBack,
      "follow-up": (l) => (l.needsStaff || l.handedBack) && !l.recentlyHandedBack,
      found: (l) => l.reportedFound,
      "check-in": (l) => l.handedBack,
    };
    const rule = rules[filter] ?? rules.all ?? (() => true);
    const filtered = loans.filter(rule);
    const counts = Object.fromEntries(
      Object.entries(rules).map(([name, test]) => [name, loans.filter(test).length]),
    );
    // Waiting longest first for check-in; most overdue first for late books.
    if (filter === "check-in") {
      filtered.sort((a, b) => (b.handedBackDaysAgo ?? 0) - (a.handedBackDaysAgo ?? 0));
    } else if (filter === "due-soon") {
      filtered.sort((a, b) => a.dueOn.localeCompare(b.dueOn));
    } else if (filter !== "all") filtered.sort((a, b) => b.overdueDays - a.overdueDays);
    return c.json({ loans: filtered, counts });
  })

  /** Close a loan as returned, lost or damaged (the copy's status follows). */
  .post("/loans/:id/close", async (c) => {
    const actor = await requirePermission(c, "loans:manage");
    const body = await readBody(c, markBody);
    const DB = c.env.DB;
    const loan = await DB.prepare(
      "select id, copy_id as copyId, family_id as familyId from loans where id = ? and library_id = ? and returned_at is null",
    )
      .bind(c.req.param("id"), actor.library.id)
      .first<{ id: string; copyId: string; familyId: string | null }>();
    if (!loan) fail(404, "not_found", "That loan was not found. The book may already be back.");
    const at = Date.now();
    const closedByUs =
      "exists (select 1 from loans where id = ? and returned_at = ? and returned_by = ?)";
    const copyStatus = body.outcome === "returned" ? null : body.outcome;
    const [closed] = await DB.batch([
      DB.prepare(
        "update loans set returned_at = ?, returned_by = ?, outcome = ? where id = ? and library_id = ? and returned_at is null",
      ).bind(at, actor.userId, body.outcome, loan.id, actor.library.id),
      DB.prepare(
        `update copies set found_at = null, found_by = null, status = coalesce(?, status)
         where id = ? and library_id = ? and ${closedByUs}`,
      ).bind(copyStatus, loan.copyId, actor.library.id, loan.id, at, actor.userId),
      DB.prepare(
        `insert into events (id, library_id, actor_user_id, type, payload)
         select ?, ?, ?, 'loan_closed', ? where ${closedByUs}`,
      ).bind(
        newId(),
        actor.library.id,
        actor.userId,
        JSON.stringify({
          loanId: loan.id,
          copyId: loan.copyId,
          familyId: loan.familyId,
          outcome: body.outcome,
        }),
        loan.id,
        at,
        actor.userId,
      ),
    ]);
    if (closed?.meta.changes !== 1)
      fail(409, "changed_meanwhile", "This loan just changed. Please refresh.");
    if (body.outcome === "returned") {
      const copy = await DB.prepare(
        "select title_id as titleId from copies where id = ? and library_id = ?",
      )
        .bind(loan.copyId, actor.library.id)
        .first<{ titleId: string }>();
      if (copy) tellWaitingFamily(c, actor.library, copy.titleId);
    }
    return c.json({ ok: true });
  })

  /** Email the family a reminder about this book now (at most once a day per loan). */
  .post("/loans/:id/remind", async (c) => {
    const actor = await requirePermission(c, "loans:manage");
    const now = today(actor);
    const { results } = await c.env.DB.prepare(remindLoanQuery)
      .bind(actor.library.id, JSON.stringify([c.req.param("id")]))
      .all<RemindLoan>();
    const loan = results[0];
    if (!loan) fail(404, "not_found", "That loan was not found. The book may already be back.");
    if (!loan.familyId) {
      fail(409, "no_family", "This family's account was deleted, so there is no one to email.");
    }
    if ((await claimReminders(c, actor, [loan], now)).length === 0) {
      fail(409, "already_reminded", "This family was already reminded about this book today.");
    }
    const result = await remindFamilies(c, actor, groupByFamily([loan]), now);
    if (result.noEmail) {
      fail(409, "no_email", "No parent in this family has an email address to send to.");
    }
    if (result.reminded === 0) {
      fail(
        503,
        result.deferred ? "email_quota" : "email_failed",
        result.deferred
          ? quotaMessage
          : "The reminder could not be sent. Check the email settings, then try again.",
      );
    }
    return c.json({ sent: 1 });
  })

  /**
   * Email reminders for several loans at once: one email per family listing
   * its chosen books. Books already reminded about today are skipped.
   */
  .post("/loans/remind", async (c) => {
    const actor = await requirePermission(c, "loans:manage");
    const { loanIds } = await readBody(c, bulkRemindBody);
    const now = today(actor);
    const ids = [...new Set(loanIds)];
    const { results: loans } = await c.env.DB.prepare(remindLoanQuery)
      .bind(actor.library.id, JSON.stringify(ids))
      .all<RemindLoan>();
    const withFamily = loans.filter((l) => l.familyId);
    const claimed = await claimReminders(c, actor, withFamily, now);
    const result = await remindFamilies(c, actor, groupByFamily(claimed), now);
    return c.json({
      ...result,
      alreadyReminded: withFamily.length - claimed.length,
      // Returned, removed, or a family whose account was deleted.
      skipped: ids.length - withFamily.length,
    });
  })

  .get("/settings", async (c) => {
    const actor = await requirePermission(c, "library:admin");
    // Days the site's owner opened this library for support (see access.ts).
    const { results: supportVisits } = await c.env.DB.prepare(
      `select json_extract(payload, '$.day') as day from events
       where library_id = ? and type = 'owner_access' order by created_at desc limit 20`,
    )
      .bind(actor.library.id)
      .all<{ day: string }>();
    return c.json({
      libraryName: actor.library.name,
      settings: actor.library.settings,
      labels: SETTING_LABELS,
      supportVisits: supportVisits.map((v) => v.day),
    });
  })

  /**
   * A new library's first admin finishes setting it up: accepts the terms and
   * privacy policy, and chooses how returns work.
   */
  .post("/welcome", async (c) => {
    const actor = await requirePermission(c, "library:admin");
    if (actor.support) {
      fail(403, "forbidden", "The library's own admin accepts the terms, not site support.");
    }
    const body = await readBody(
      c,
      z.object({
        acceptTerms: z.literal(true, { error: "Please accept the terms and privacy policy." }),
        returnsNeedCheckIn: z.boolean({ error: "Choose how returns work." }),
      }),
    );
    const merged = mergeSettings(actor.library.settings, {
      returnsNeedCheckIn: body.returnsNeedCheckIn,
    });
    if (!merged.ok) fail(422, "invalid_input", merged.errors[0]?.message ?? "Invalid settings.");
    const DB = c.env.DB;
    await DB.batch([
      DB.prepare(
        "update libraries set terms_accepted_at = coalesce(terms_accepted_at, ?), settings = ? where id = ?",
      ).bind(Date.now(), JSON.stringify(merged.settings), actor.library.id),
      DB.prepare(
        "insert into events (id, library_id, actor_user_id, type) values (?, ?, ?, 'terms_accepted')",
      ).bind(newId(), actor.library.id, actor.userId),
    ]);
    return c.json({ ok: true });
  })

  .patch("/settings", async (c) => {
    const actor = await requirePermission(c, "library:admin");
    const body = await readBody(c, settingsBody);
    const { libraryName, ...patch } = body;
    const merged = mergeSettings(actor.library.settings, patch);
    if (!merged.ok) {
      return c.json(
        { error: "invalid_settings", message: merged.errors[0]?.message, errors: merged.errors },
        422,
      );
    }
    const DB = c.env.DB;
    await DB.batch([
      DB.prepare("update libraries set settings = ?, name = coalesce(?, name) where id = ?").bind(
        JSON.stringify(merged.settings),
        libraryName ?? null,
        actor.library.id,
      ),
      DB.prepare(
        "insert into events (id, library_id, actor_user_id, type, payload) values (?, ?, ?, 'settings_changed', ?)",
      ).bind(
        newId(),
        actor.library.id,
        actor.userId,
        JSON.stringify({
          fields: [...Object.keys(patch), ...(libraryName ? ["libraryName"] : [])],
        }),
      ),
    ]);
    return c.json({ libraryName: libraryName ?? actor.library.name, settings: merged.settings });
  });

/** Public: the "turn off reminders" link in reminder emails. Needs the signed token from the email. */
export const nudgeRoutes = new Hono<AppEnv>()
  .post("/reminders-off", async (c) => {
    const body = await readBody(c, z.object({ f: z.string().max(64), t: z.string().max(128) }));
    const secret = authSecret(c.env);
    const expected = await hmacHex(secret, `nudges-off:${body.f}`);
    if (!timingSafeEqual(expected, body.t)) {
      // Only wrong links count towards the limit, so nobody can block a family's real link.
      const limit = await consume(
        c.env.DB,
        secret,
        `nudges-off-bad:${clientIp(c.req.raw.headers)}`,
        {
          window: 3600,
          max: 20,
        },
      );
      if (!limit.allowed) fail(429, "too_many_attempts", "Please wait a little and try again.");
      fail(
        400,
        "bad_link",
        "This link is not valid. Use the link from your most recent reminder email.",
      );
    }
    await c.env.DB.prepare("update families set nudges_off = 1 where id = ?").bind(body.f).run();
    return c.json({ ok: true });
  })

  /**
   * Public: "Keep it another week" from a reminder email. The link is signed
   * and tied to the book's due date, so it works once and only for that loan.
   */
  .post("/extend-by-link", async (c) => {
    const body = await readBody(c, z.object({ l: z.string().max(64), t: z.string().max(128) }));
    const DB = c.env.DB;
    const secret = authSecret(c.env);
    const loan = await DB.prepare(
      `select l.id as id, l.library_id as libraryId, l.copy_id as copyId, l.family_id as familyId,
              l.due_on as dueOn, l.extended_count as extendedCount,
              l.return_requested_at as returnRequestedAt, t.title as title
       from loans l
       join copies c on c.id = l.copy_id and c.library_id = l.library_id
       join titles t on t.id = c.title_id and t.library_id = c.library_id
       where l.id = ? and l.returned_at is null`,
    )
      .bind(body.l)
      .first<{
        id: string;
        libraryId: string;
        copyId: string;
        familyId: string | null;
        dueOn: string;
        extendedCount: number;
        returnRequestedAt: number | null;
        title: string;
      }>();
    const valid =
      loan !== null && timingSafeEqual(await extendLinkToken(c.env, loan.id, loan.dueOn), body.t);
    if (!valid) {
      const limit = await consume(DB, secret, `extend-link-bad:${clientIp(c.req.raw.headers)}`, {
        window: 3600,
        max: 20,
      });
      if (!limit.allowed) fail(429, "too_many_attempts", "Please wait a little and try again.");
      fail(
        400,
        "bad_link",
        "This link has already been used or the book is back. Open the library to see your books.",
      );
    }
    const library = await libraryById(c.get("db"), loan.libraryId);
    if (!library || library.status === "paused") {
      fail(403, "library_paused", "The library is paused, so loans can't be changed right now.");
    }
    const dueOn = await extendLoan(DB, library, loan, null);
    return c.json({ title: loan.title, dueOn, library: { slug: library.slug } });
  })

  /** A family's reminder emails: on or off. Any parent in the family can change it. */
  .get("/family/reminders", async (c) => {
    const actor = await requirePermission(c, "loans:own");
    if (!actor.family) fail(404, "no_family", "Your sign-in isn't connected to a family.");
    const row = await c.env.DB.prepare(
      "select nudges_off as off from families where id = ? and library_id = ?",
    )
      .bind(actor.family.id, actor.library.id)
      .first<{ off: number }>();
    return c.json({ on: row?.off !== 1 });
  })
  .put("/family/reminders", async (c) => {
    const actor = await requirePermission(c, "loans:own");
    if (!actor.family) fail(404, "no_family", "Your sign-in isn't connected to a family.");
    const body = await readBody(c, z.object({ on: z.boolean({ error: "Choose on or off." }) }));
    await c.env.DB.prepare("update families set nudges_off = ? where id = ? and library_id = ?")
      .bind(body.on ? 0 : 1, actor.family.id, actor.library.id)
      .run();
    return c.json({ on: body.on });
  });
