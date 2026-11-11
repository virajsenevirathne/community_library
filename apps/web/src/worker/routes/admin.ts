import {
  daysOverdue,
  localParts,
  mergeSettings,
  needsStaff,
  SETTING_LABELS,
} from "@community-library/core";
import { Hono } from "hono";
import { z } from "zod";
import { type Actor, requirePermission } from "../access.ts";
import { authSecret } from "../config.ts";
import { type AppContext, type AppEnv, fail, readBody } from "../context.ts";
import { hmacHex, timingSafeEqual } from "../crypto.ts";
import { newId } from "../db/client.ts";
import { reminderEmail } from "../email.ts";
import { JOB_NAME, nudgesOffUrl, STALE_AFTER_MS } from "../jobs/reminders.ts";
import { clientIp, consume } from "../limiter.ts";
import { PROVIDER_LIMITS, type QuotaMailer } from "../mailer.ts";
import { name } from "./account.ts";

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
  code: string;
  copyId: string;
  title: string;
  titleId: string;
  familyId: string | null;
  familyName: string | null;
}

async function openLoans(c: AppContext, actor: Actor): Promise<LoanRow[]> {
  const { results } = await c.env.DB.prepare(
    `select l.id as id, l.due_on as dueOn, l.borrowed_at as borrowedAt, l.extended_count as extendedCount,
            c.found_at as foundAt, c.short_code as code, c.id as copyId, t.title as title, t.id as titleId,
            l.family_id as familyId, f.name as familyName
     from loans l
     join copies c on c.id = l.copy_id and c.library_id = l.library_id
     join titles t on t.id = c.title_id and t.library_id = c.library_id
     left join families f on f.id = l.family_id and f.library_id = l.library_id
     where l.library_id = ? and l.returned_at is null
     order by l.due_on, t.title`,
  )
    .bind(actor.library.id)
    .all<LoanRow>();
  return results;
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
    dueOn: loan.dueOn,
    overdueDays,
    needsStaff: needsStaff(loan.dueOn, now, actor.library.settings.staffFlagDays),
    reportedFound: loan.foundAt !== null,
    canExtend: loan.extendedCount < actor.library.settings.maxExtensions,
  };
}

const markBody = z.object({
  outcome: z.enum(["returned", "lost", "damaged"], { error: "Choose returned, lost or damaged." }),
});

const settingsBody = z
  .object({ libraryName: name("Library name", 80).optional() })
  .catchall(z.unknown());

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

    const [popular, counts, job] = await Promise.all([
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
    ]);

    const mailer = c.get("email") as Partial<QuotaMailer>;
    const emailLeft =
      typeof mailer.remainingToday === "function" ? await mailer.remainingToday() : null;
    const lastFinished = job?.finishedAt ?? null;
    return c.json({
      today: now,
      booksOut: loans.length,
      overdue: loans.filter((l) => l.overdueDays > 0).length,
      needsStaff: loans.filter((l) => l.needsStaff).length,
      dueThisWeek: loans.filter((l) => l.overdueDays === 0 && l.dueOn <= weekEnd).length,
      reportedFound: loans.filter((l) => l.reportedFound).length,
      mostBorrowed: popular.results,
      counts,
      reminders: {
        lastRun: lastFinished,
        // A missed run is a problem only once there is something to remind about.
        stale:
          lastFinished === null ? loans.length > 0 : Date.now() - lastFinished > STALE_AFTER_MS,
        // Raw error text is for the admin only; staff see that it failed.
        error: job?.error
          ? actor.role === "admin"
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
    const filtered =
      filter === "overdue"
        ? loans.filter((l) => l.overdueDays > 0)
        : filter === "follow-up"
          ? loans.filter((l) => l.needsStaff)
          : filter === "found"
            ? loans.filter((l) => l.reportedFound)
            : loans;
    // Most overdue first when looking at late books.
    if (filter !== "all") filtered.sort((a, b) => b.overdueDays - a.overdueDays);
    return c.json({ loans: filtered });
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
    return c.json({ ok: true });
  })

  /** Email the family a reminder about this book now (at most once a day per loan). */
  .post("/loans/:id/remind", async (c) => {
    const actor = await requirePermission(c, "loans:manage");
    const DB = c.env.DB;
    const now = today(actor);
    const loan = await DB.prepare(
      `select l.id as id, l.due_on as dueOn, l.family_id as familyId, t.title as title
       from loans l
       join copies c on c.id = l.copy_id and c.library_id = l.library_id
       join titles t on t.id = c.title_id and t.library_id = c.library_id
       where l.id = ? and l.library_id = ? and l.returned_at is null`,
    )
      .bind(c.req.param("id"), actor.library.id)
      .first<{ id: string; dueOn: string; familyId: string | null; title: string }>();
    if (!loan) fail(404, "not_found", "That loan was not found. The book may already be back.");
    if (!loan.familyId) {
      fail(409, "no_family", "This family's account was deleted, so there is no one to email.");
    }
    const key = `manual:${loan.id}:${now}`;
    const claimed = await DB.prepare(
      `insert into notifications (id, library_id, family_id, kind, dedupe_key, status)
       values (?, ?, ?, 'manual_reminder', ?, 'pending') on conflict (dedupe_key) do nothing returning id`,
    )
      .bind(newId(), actor.library.id, loan.familyId, key)
      .first();
    if (!claimed) {
      fail(409, "already_reminded", "This family was already reminded about this book today.");
    }

    let delivered = 0;
    let deferred = false;
    try {
      const { results: parents } = await DB.prepare(
        `select u.email as email from memberships m join users u on u.id = m.user_id
         where m.library_id = ? and m.family_id = ?`,
      )
        .bind(actor.library.id, loan.familyId)
        .all<{ email: string }>();
      const overdueDays = daysOverdue(loan.dueOn, now);
      const offUrl = await nudgesOffUrl(c.env, c.get("origin"), loan.familyId);
      // In production this is the QuotaMailer; other senders ignore the priority.
      const mailer = c.get("email") as Pick<QuotaMailer, "send">;
      for (const parent of parents) {
        const message = reminderEmail({
          libraryName: actor.library.name,
          to: parent.email,
          siteUrl: c.get("origin"),
          nudgesOffUrl: offUrl,
          lines: [
            {
              title: loan.title,
              dueOn: loan.dueOn,
              kind: overdueDays > 0 ? "overdue" : "due_soon",
              overdueDays,
            },
          ],
        });
        // Routine: a reminder must never use up the emails kept for sign-in codes.
        const result = await mailer.send(message, "routine");
        if (result.ok) delivered += 1;
        else if (result.error === "deferred_quota") deferred = true;
      }
    } finally {
      await DB.prepare(
        delivered > 0
          ? "update notifications set status = 'sent' where dedupe_key = ?"
          : "delete from notifications where dedupe_key = ?",
      )
        .bind(key)
        .run();
    }
    if (delivered === 0) {
      fail(
        503,
        deferred ? "email_quota" : "email_failed",
        deferred
          ? "Today's emails are nearly used up, so reminders wait until tomorrow. Sign-in codes still work."
          : "The reminder could not be sent. Check the email settings, then try again.",
      );
    }
    return c.json({ sent: delivered });
  })

  .get("/settings", async (c) => {
    const actor = await requirePermission(c, "library:admin");
    return c.json({
      libraryName: actor.library.name,
      settings: actor.library.settings,
      labels: SETTING_LABELS,
    });
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
