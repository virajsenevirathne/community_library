import type { EmailMessage, SendResult } from "@community-library/adapters";
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
import type { Priority } from "../mailer.ts";
import { sendInvite, unsentInvites } from "../routes/families.ts";

/*
 * The hourly job (Cron Trigger "0 * * * *"). Each library gets its reminders
 * once a day, at its own local reminder hour, and never on a closed day.
 *
 * Every reminder to every parent has its own key in the notifications table.
 * The key is claimed as "pending" before sending and marked "sent" after, so
 * overlapping runs cannot both send it. A failed send releases the claim, and
 * a claim left "pending" by a run that died is taken over after 15 minutes,
 * so nothing is lost. Each run sends at most MAX_EMAILS_PER_RUN emails (a
 * Worker may only make 50 outgoing requests per run); the rest go next hour.
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
  settings: LibrarySettings;
}

/** Counts emails sent in this run, to stay under the per-run limit. */
class Budget {
  sent = 0;
  get left() {
    return MAX_EMAILS_PER_RUN - this.sent;
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
  const { results } = await DB.prepare("select id, name, settings from libraries").all<{
    id: string;
    name: string;
    settings: string;
  }>();
  for (const row of results) {
    // One library's problem must not stop the others.
    try {
      await runForLibrary(deps, now, budget, {
        id: row.id,
        name: row.name,
        settings: parseSettings(row.settings),
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
  await tidyUp(deps.DB, library, now);
  await sendQueuedInvites(deps, library, budget);

  if (local.hour < settings.reminderHour) return;
  // Staff get the weekly summary on Monday even when the centre is closed.
  if (local.weekday === 1) await sendWeeklyDigest(deps, library, local.date, now, budget);
  if (isClosed(local.date, settings)) return;
  await sendFamilyReminders(deps, library, local.date, budget);
}

/**
 * Privacy housekeeping: after the history period, closed loans and their
 * events lose the family, and old notification records are deleted. Expired
 * invitations lose their email address.
 */
async function tidyUp(DB: D1Database, library: Library, now: Date) {
  const cutoff = monthsBefore(now, library.settings.historyMonths).getTime();
  await DB.batch([
    DB.prepare(
      `update loans set family_id = null, borrowed_by = null, returned_by = null
       where library_id = ? and returned_at is not null and returned_at < ?
         and (family_id is not null or borrowed_by is not null or returned_by is not null)`,
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
    `select l.id as loanId, l.family_id as familyId, l.due_on as dueOn, t.title as title
     from loans l
     join families f on f.id = l.family_id and f.library_id = l.library_id
     join copies c on c.id = l.copy_id and c.library_id = l.library_id
     join titles t on t.id = c.title_id and t.library_id = c.library_id
     where l.library_id = ? and l.returned_at is null
       and (l.return_requested_at is null or l.return_requested_at < ?)
       and f.status = 'active' and f.nudges_off = 0`,
  )
    .bind(library.id, handBackCutoff())
    .all<{ loanId: string; familyId: string; dueOn: string; title: string }>();
  const byLoan = new Map(loans.map((l) => [l.loanId, l]));
  const plan = remindersFor(loans, library.settings, today);
  if (plan.size === 0) return;

  const { results: parents } = await DB.prepare(
    `select m.family_id as familyId, u.id as userId, u.email as email
     from memberships m join users u on u.id = m.user_id
     where m.library_id = ? and m.family_id is not null`,
  )
    .bind(library.id)
    .all<{ familyId: string; userId: string; email: string }>();

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
        claimed.push({
          key,
          line: {
            title: loan?.title ?? "A library book",
            dueOn: loan?.dueOn ?? today,
            kind: reminder.kind,
            overdueDays: loan ? daysOverdue(loan.dueOn, today) : 0,
          },
        });
      }
      if (claimed.length === 0) continue;

      let result: SendResult;
      try {
        result = await deps.mailer.send(
          reminderEmail({
            libraryName: library.name,
            to: parent.email,
            siteUrl: deps.siteUrl,
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
      if (result.ok) budget.sent += 1;
      else console.error(`Reminder email not sent via ${result.provider}: ${result.error}`);
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
          siteUrl: deps.siteUrl,
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
    if (result.ok) budget.sent += 1;
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
    // Out of quota for today: the rest wait for tomorrow.
    if (!ok) return;
    budget.sent += 1;
  }
}
