import type { EmailMessage, PushResult, PushSender, SendResult } from "@community-library/adapters";
import {
  daysOverdue,
  handBackCutoff,
  isClosed,
  type LibrarySettings,
  localParts,
  parseSettings,
  remindersFor,
} from "@community-library/core";
import { authSecret } from "../config.ts";
import { hmacHex } from "../crypto.ts";
import { newId } from "../db/client.ts";
import { digestEmail, type ReminderLine, reminderEmail } from "../email.ts";
import { ELIGIBLE, HOLD_LAPSE_DAYS, NOTIFY_GAP_DAYS, notifyNextHold, ON_SHELF } from "../holds.ts";
import { libraryHome } from "../library.ts";
import type { Priority } from "../mailer.ts";
import { sendInvite, unsentInvites } from "../routes/families.ts";
import { extendLinkToken } from "../routes/loans.ts";

/*
 * The hourly job (Cron Trigger "0 * * * *"). Each library gets its reminders
 * once a day, at its own local reminder hour, and never on a closed day.
 *
 * Every reminder to every parent has its own key in the notifications table.
 * The key is claimed as "pending" before sending and marked "sent" after, so
 * overlapping runs cannot both send it. A failed send releases the claim, and
 * a claim left "pending" by a run that died is taken over after 15 minutes,
 * so nothing is lost. Each run makes at most MAX_EMAILS_PER_RUN email requests
 * (a Worker may only make 50 outgoing requests per run, and a send that falls
 * back to the second provider makes two); the rest go next hour.
 */

export const JOB_NAME = "hourly";
/** The dashboard warns when the job has not finished a run for this long. */
export const STALE_AFTER_MS = 3 * 60 * 60 * 1000;
export const MAX_EMAILS_PER_RUN = 40;
const PENDING_TIMEOUT_MS = 15 * 60 * 1000;

export interface JobMailer {
  send(message: EmailMessage, priority?: Priority): Promise<SendResult>;
}

export interface JobDeps {
  DB: D1Database;
  env: Env;
  mailer: JobMailer;
  /** Phone notifications, when the site has web push keys. */
  push?: PushSender | null;
  siteUrl: string;
  now?: Date;
}

/** Signed link that turns a family's reminder emails off. */
export async function nudgesOffUrl(env: Env, siteUrl: string, familyId: string) {
  const token = await hmacHex(authSecret(env), `nudges-off:${familyId}`);
  return `${siteUrl}/reminders-off?f=${encodeURIComponent(familyId)}&t=${token}`;
}

/** `date` minus `months`, keeping the day within the target month (31 March − 1 month = 28/29 February). */
export function monthsBefore(date: Date, months: number): Date {
  const result = new Date(date);
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() - months);
  const lastDay = new Date(
    Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0),
  ).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result;
}

interface Library {
  id: string;
  name: string;
  slug: string;
  settings: LibrarySettings;
  status: "active" | "paused";
}

/** Counts emails sent, and outgoing email requests made, to stay under the per-run limit. */
class Budget {
  sent = 0;
  requests = 0;
  get left() {
    return MAX_EMAILS_PER_RUN - this.requests;
  }
  /** Records one send, successful or not. */
  spend(result: SendResult) {
    this.requests += result.attempts ?? 1;
    if (result.ok) this.sent += 1;
  }
}

export async function runHourlyJob(
  deps: JobDeps,
): Promise<{ libraries: number; sent: number; failed: number }> {
  const { DB } = deps;
  const now = deps.now ?? new Date();
  await DB.prepare(
    `insert into job_runs (name, started_at, finished_at, error) values (?1, ?2, null, null)
     on conflict (name) do update set started_at = ?2`,
  )
    .bind(JOB_NAME, now.getTime())
    .run();
  const budget = new Budget();
  const errors: string[] = [];
  // Rate-limit records older than the longest window (a day) count for nothing.
  await DB.prepare("delete from rate_limits where last_request < ?")
    .bind(now.getTime() - 2 * 86_400_000)
    .run();
  const { results } = await DB.prepare(
    "select id, name, slug, settings, status from libraries",
  ).all<{
    id: string;
    name: string;
    slug: string;
    settings: string;
    status: "active" | "paused";
  }>();
  for (const row of results) {
    // One library's problem must not stop the others.
    try {
      await runForLibrary(deps, now, budget, {
        id: row.id,
        name: row.name,
        slug: row.slug,
        settings: parseSettings(row.settings),
        status: row.status,
      });
    } catch (error) {
      console.error(`Hourly job failed for library ${row.id}:`, error);
      errors.push(String(error).slice(0, 200));
    }
  }
  await DB.prepare("update job_runs set finished_at = ?, error = ? where name = ?")
    .bind(Date.now(), errors.length > 0 ? errors.join("; ").slice(0, 300) : null, JOB_NAME)
    .run();
  return { libraries: results.length, sent: budget.sent, failed: errors.length };
}

async function runForLibrary(deps: JobDeps, now: Date, budget: Budget, library: Library) {
  const settings = library.settings;
  const local = localParts(now, settings.timezone);
  // Paused libraries still get their privacy tidy-up, but send nothing.
  await tidyUp(deps.DB, library, now);
  if (library.status === "paused") return;
  await sendQueuedInvites(deps, library, budget);
  await tellWaitingFamilies(deps, library);

  if (local.hour < settings.reminderHour) return;
  // Staff get the weekly summary on Monday even when the centre is closed.
  if (local.weekday === 1) await sendWeeklyDigest(deps, library, local.date, now, budget);
  if (isClosed(local.date, settings)) return;
  await sendFamilyReminders(deps, library, local.date, budget);
}

/**
 * Sends a reminder as a phone notification to each of the person's devices.
 * Devices that are gone (unsubscribed, app removed) are forgotten. True when
 * at least one device got it; otherwise the email goes as usual.
 */
async function pushReminder(
  deps: JobDeps,
  library: Library,
  userId: string,
  lines: ReminderLine[],
): Promise<boolean> {
  if (!deps.push) return false;
  const { results: devices } = await deps.DB.prepare(
    "select id, endpoint, p256dh, auth from push_subscriptions where user_id = ?",
  )
    .bind(userId)
    .all<{ id: string; endpoint: string; p256dh: string; auth: string }>();
  if (devices.length === 0) return false;
  const overdue = lines.some((l) => l.kind === "overdue");
  // Like the email subject, the notification never names a book on the lock screen.
  const message = {
    title: overdue ? "A library book to bring back" : "A library book is due back soon",
    body:
      lines.length === 1
        ? overdue
          ? "It's past its due date. Tap to see it."
          : "Tap to see it, or keep it longer."
        : `${lines.length} books need attention. Tap to see them.`,
    url: `/${library.slug}/`,
    tag: `reminder-${library.slug}`,
  };
  let delivered = false;
  for (const device of devices) {
    const result = await deps.push
      .send(device, message)
      .catch((error): PushResult => ({ ok: false, gone: false, status: 0, error: String(error) }));
    if (result.ok) {
      delivered = true;
      await deps.DB.prepare("update push_subscriptions set last_sent_at = ? where id = ?")
        .bind(Date.now(), device.id)
        .run();
    } else if (result.gone) {
      await deps.DB.prepare("delete from push_subscriptions where id = ?").bind(device.id).run();
    } else {
      console.error(`Reminder notification not sent: ${result.error}`);
    }
  }
  return delivered;
}

/**
 * Books on the shelf that someone is waiting for (a place lapsed, or a copy
 * came back without a return, such as a lost book found): tell the next
 * family. Normally a return tells them straight away.
 */
async function tellWaitingFamilies(deps: JobDeps, library: Library) {
  const { results } = await deps.DB.prepare(
    `select h.title_id as titleId from holds h
     where h.library_id = ?1 and (h.notified_at is null or h.notified_at <= ?3)
       and (${ON_SHELF.replaceAll("?2", "h.title_id")}) > 0
     group by h.title_id order by min(coalesce(h.notified_at, 0)) limit 50`,
  )
    .bind(library.id, null, Date.now() - NOTIFY_GAP_DAYS * 86_400_000)
    .all<{ titleId: string }>();
  for (const { titleId } of results) {
    await notifyNextHold(
      { DB: deps.DB, mailer: deps.mailer, origin: deps.siteUrl },
      library,
      titleId,
    );
  }
}

/**
 * Privacy housekeeping: after the history period, closed loans and their
 * events lose the family, and old notification records are deleted. Expired
 * invitations lose their email address.
 */
async function tidyUp(DB: D1Database, library: Library, now: Date) {
  const cutoff = monthsBefore(now, library.settings.historyMonths).getTime();
  await DB.batch([
    // Nothing left to wait for: no copy of the book can be lent any more.
    DB.prepare(
      `delete from holds where library_id = ? and not exists (
         select 1 from copies c where c.title_id = holds.title_id and c.library_id = holds.library_id
           and c.status = 'available')`,
    ).bind(library.id),
    // Waiting lists lapse some days after the family was told the book is back.
    DB.prepare(
      "delete from holds where library_id = ? and notified_at is not null and notified_at < ?",
    ).bind(library.id, now.getTime() - HOLD_LAPSE_DAYS * 86_400_000),
    DB.prepare(
      `update loans set family_id = null, borrowed_by = null, returned_by = null, kiosk_person_id = null
       where library_id = ? and returned_at is not null and returned_at < ?
         and (family_id is not null or borrowed_by is not null or returned_by is not null
              or kiosk_person_id is not null)`,
    ).bind(library.id, cutoff),
    DB.prepare(
      `update events set payload = json_remove(payload, '$.familyId'), actor_user_id = null
       where library_id = ? and created_at < ?
         and (json_extract(payload, '$.familyId') is not null or actor_user_id is not null)`,
    ).bind(library.id, cutoff),
    DB.prepare("delete from notifications where library_id = ? and created_at < ?").bind(
      library.id,
      cutoff,
    ),
    DB.prepare(
      `update invitations set email = null
       where library_id = ? and accepted_at is null and sent_at is not null and expires_at < ?
         and email is not null`,
    ).bind(library.id, now.getTime()),
    // Invites that were never sent (an import over the daily limit) are
    // dropped after 30 days, so their addresses aren't kept.
    DB.prepare(
      `delete from invitations
       where library_id = ? and accepted_at is null and sent_at is null and created_at < ?`,
    ).bind(library.id, now.getTime() - 30 * 86_400_000),
  ]);
}

/**
 * Claims a notification key as "pending". Returns false when it was already
 * sent, or another run is sending it right now.
 */
async function claim(
  DB: D1Database,
  library: Library,
  key: string,
  kind: string,
  familyId: string | null,
): Promise<boolean> {
  const now = Date.now();
  const row = await DB.prepare(
    `insert into notifications (id, library_id, family_id, kind, dedupe_key, status, created_at)
     values (?1, ?2, ?3, ?4, ?5, 'pending', ?6)
     on conflict (dedupe_key) do update set created_at = ?6
       where notifications.status = 'pending' and notifications.created_at < ?7
     returning id`,
  )
    .bind(newId(), library.id, familyId, kind, key, now, now - PENDING_TIMEOUT_MS)
    .first();
  return row !== null;
}

async function settle(DB: D1Database, keys: string[], delivered: boolean, provider: string) {
  try {
    for (const key of keys) {
      if (delivered) {
        await DB.prepare(
          "update notifications set status = 'sent', provider = ? where dedupe_key = ?",
        )
          .bind(provider, key)
          .run();
      } else {
        await DB.prepare("delete from notifications where dedupe_key = ? and status = 'pending'")
          .bind(key)
          .run();
      }
    }
  } catch (error) {
    // A claim left "pending" is retried after 15 minutes, so nothing is lost.
    console.error("Could not record a notification result:", error);
  }
}

async function sendFamilyReminders(deps: JobDeps, library: Library, today: string, budget: Budget) {
  const { DB } = deps;
  // Open loans of active families that have not turned reminders off.
  const { results: loans } = await DB.prepare(
    `select l.id as loanId, l.family_id as familyId, l.due_on as dueOn, t.title as title,
            l.extended_count as extendedCount, l.return_requested_at is not null as handedBack,
            exists (select 1 from holds h where h.library_id = l.library_id and h.title_id = t.id
                    and h.family_id is not l.family_id
                    and ${ELIGIBLE.replaceAll("?1", "h.library_id")}) as othersWaiting
     from loans l
     join families f on f.id = l.family_id and f.library_id = l.library_id
     join copies c on c.id = l.copy_id and c.library_id = l.library_id
     join titles t on t.id = c.title_id and t.library_id = c.library_id
     where l.library_id = ? and l.returned_at is null
       and (l.return_requested_at is null or l.return_requested_at < ?)
       and f.status = 'active' and f.nudges_off = 0`,
  )
    .bind(library.id, handBackCutoff())
    .all<{
      loanId: string;
      familyId: string;
      dueOn: string;
      title: string;
      extendedCount: number;
      handedBack: number;
      othersWaiting: number;
    }>();
  const byLoan = new Map(loans.map((l) => [l.loanId, l]));
  const plan = remindersFor(loans, library.settings, today);
  if (plan.size === 0) return;

  const { results: parents } = await DB.prepare(
    `select m.family_id as familyId, u.id as userId, u.email as email, u.notify_by as notifyBy
     from memberships m join users u on u.id = m.user_id
     where m.library_id = ? and m.family_id is not null`,
  )
    .bind(library.id)
    .all<{ familyId: string; userId: string; email: string; notifyBy: string }>();

  for (const [familyId, reminders] of plan) {
    const offUrl = await nudgesOffUrl(deps.env, deps.siteUrl, familyId);
    for (const parent of parents.filter((p) => p.familyId === familyId)) {
      if (budget.left <= 0) return;
      // Each parent has their own key per stage, so one parent's failed email is retried
      // without sending the other parent a second copy.
      const claimed: { key: string; line: ReminderLine }[] = [];
      for (const reminder of reminders) {
        const key = `${reminder.key}:to:${parent.userId}`;
        if (!(await claim(DB, library, key, reminder.kind, familyId))) continue;
        const loan = byLoan.get(reminder.loanId);
        // "Keep it another week" in the due-soon email, when it's allowed.
        const extendable =
          loan &&
          reminder.kind === "due_soon" &&
          !loan.handedBack &&
          !loan.othersWaiting &&
          loan.extendedCount < library.settings.maxExtensions;
        claimed.push({
          key,
          line: {
            title: loan?.title ?? "A library book",
            dueOn: loan?.dueOn ?? today,
            kind: reminder.kind,
            overdueDays: loan ? daysOverdue(loan.dueOn, today) : 0,
            ...(extendable
              ? {
                  extendUrl: `${deps.siteUrl}/extend?l=${encodeURIComponent(loan.loanId)}&t=${await extendLinkToken(deps.env, loan.loanId, loan.dueOn)}`,
                }
              : {}),
          },
        });
      }
      if (claimed.length === 0) continue;

      // Phone notifications first, for people who chose them.
      const pushed =
        parent.notifyBy !== "email"
          ? await pushReminder(
              deps,
              library,
              parent.userId,
              claimed.map((c) => c.line),
            )
          : false;
      if (parent.notifyBy === "push" && pushed) {
        await settle(
          DB,
          claimed.map((c) => c.key),
          true,
          "push",
        );
        continue;
      }

      let result: SendResult;
      try {
        result = await deps.mailer.send(
          reminderEmail({
            libraryName: library.name,
            to: parent.email,
            siteUrl: libraryHome(deps.siteUrl, library),
            lines: claimed.map((c) => c.line),
            nudgesOffUrl: offUrl,
          }),
          "routine",
        );
      } catch (error) {
        result = { ok: false, provider: "error", retryable: true, error: String(error) };
      }
      await settle(
        DB,
        claimed.map((c) => c.key),
        result.ok,
        result.provider,
      );
      budget.spend(result);
      if (!result.ok)
        console.error(`Reminder email not sent via ${result.provider}: ${result.error}`);
    }
  }
}

async function sendWeeklyDigest(
  deps: JobDeps,
  library: Library,
  today: string,
  now: Date,
  budget: Budget,
) {
  const { DB } = deps;
  const { results: staff } = await DB.prepare(
    `select u.id as userId, u.email as email from memberships m join users u on u.id = m.user_id
     where m.library_id = ? and m.role in ('staff', 'admin')`,
  )
    .bind(library.id)
    .all<{ userId: string; email: string }>();
  if (staff.length === 0) return;

  const { results: overdue } = await DB.prepare(
    `select t.title as title, coalesce(f.name, 'Deleted family') as familyName, l.due_on as dueOn
     from loans l
     left join families f on f.id = l.family_id and f.library_id = l.library_id
     join copies c on c.id = l.copy_id and c.library_id = l.library_id
     join titles t on t.id = c.title_id and t.library_id = c.library_id
     where l.library_id = ? and l.returned_at is null and l.due_on < ?
       and (l.return_requested_at is null or l.return_requested_at < ?)
     order by l.due_on`,
  )
    .bind(library.id, today, handBackCutoff())
    .all<{ title: string; familyName: string; dueOn: string }>();
  const counts = await DB.prepare(
    `select (select count(*) from titles where library_id = ?1 and created_at >= ?2) as newTitles,
            (select count(*) from families where library_id = ?1 and status = 'pending') as pending`,
  )
    .bind(library.id, now.getTime() - 7 * 86_400_000)
    .first<{ newTitles: number; pending: number }>();

  for (const person of staff) {
    if (budget.left <= 0) return;
    const key = `digest:${library.id}:${today}:to:${person.userId}`;
    if (!(await claim(DB, library, key, "weekly_digest", null))) continue;
    let result: SendResult;
    try {
      result = await deps.mailer.send(
        digestEmail({
          libraryName: library.name,
          to: person.email,
          siteUrl: libraryHome(deps.siteUrl, library),
          overdue: overdue.map((o) => ({ ...o, overdueDays: daysOverdue(o.dueOn, today) })),
          staffFlagDays: library.settings.staffFlagDays,
          newTitles: counts?.newTitles ?? 0,
          pendingFamilies: counts?.pending ?? 0,
        }),
        "routine",
      );
    } catch (error) {
      result = { ok: false, provider: "error", retryable: true, error: String(error) };
    }
    await settle(DB, [key], result.ok, result.provider);
    budget.spend(result);
  }
}

/** Invites from a CSV import that have not gone out yet (kept under the daily email limit). */
async function sendQueuedInvites(deps: JobDeps, library: Library, budget: Budget) {
  if (budget.left <= 0) return;
  for (const invite of await unsentInvites(deps.DB, library.id, budget.left)) {
    const ok = await sendInvite(
      { env: deps.env, email: deps.mailer, origin: deps.siteUrl },
      invite,
      library,
      "routine",
    );
    // Counted as the worst case: the invite helper doesn't say whether it fell back.
    budget.requests += 2;
    // Out of quota for today: the rest wait for tomorrow.
    if (!ok) return;
    budget.sent += 1;
  }
}
