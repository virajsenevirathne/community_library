import type { EmailMessage, SendResult } from "@community-library/adapters";
import { holdReadyEmail } from "./email.ts";
import { type LibraryInfo, libraryHome } from "./library.ts";
import type { Priority } from "./mailer.ts";

/*
 * Waiting lists ("holds"). A family waits for a title, not a copy. When a
 * copy is back on the shelf, the first family waiting is told by email. The
 * copy isn't kept aside: if another family borrows it first, the family is
 * told again when the next copy comes back. Borrowing the book (any copy)
 * removes the hold; it lapses HOLD_LAPSE_DAYS after the last email.
 */

/** A family told "it's back" isn't told again within this many days. */
export const NOTIFY_GAP_DAYS = 2;
/** A hold lapses this many days after its family was last told. */
export const HOLD_LAPSE_DAYS = 14;

interface Mailer {
  send(message: EmailMessage, priority?: Priority): Promise<SendResult>;
}

/**
 * When a copy of `titleId` is on the shelf and someone is waiting who hasn't
 * been told yet, tells the first of them (one family per copy on the shelf).
 * Safe to call more than once: each family is claimed before it is emailed.
 */
export async function notifyNextHold(
  deps: { DB: D1Database; mailer: Mailer; origin: string },
  library: Pick<LibraryInfo, "id" | "name" | "slug">,
  titleId: string,
): Promise<number> {
  const { DB } = deps;
  // Copies on the shelf, less families told about one in the last few days.
  const room = await DB.prepare(
    `select (select count(*) from copies c where c.title_id = ?2 and c.library_id = ?1
               and c.status = 'available'
               and not exists (select 1 from loans l where l.copy_id = c.id and l.library_id = c.library_id
                               and l.returned_at is null))
          - (select count(*) from holds where library_id = ?1 and title_id = ?2
               and notified_at is not null and notified_at > ?3) as free`,
  )
    .bind(library.id, titleId, Date.now() - NOTIFY_GAP_DAYS * 86_400_000)
    .first<number>("free");
  let told = 0;
  for (let i = 0; i < (room ?? 0); i++) {
    const hold = await DB.prepare(
      `update holds set notified_at = ?3
       where id = (select id from holds where library_id = ?1 and title_id = ?2
                     and (notified_at is null or notified_at <= ?4)
                   -- Families not told yet go first, then in the order they joined.
                   order by notified_at is not null, created_at, id limit 1)
       returning family_id as familyId`,
    )
      .bind(library.id, titleId, Date.now(), Date.now() - NOTIFY_GAP_DAYS * 86_400_000)
      .first<{ familyId: string }>();
    if (!hold) break;
    told++;
    const [title, emails] = await Promise.all([
      DB.prepare("select title from titles where id = ? and library_id = ?")
        .bind(titleId, library.id)
        .first<string>("title"),
      DB.prepare(
        `select u.email as email from memberships m join users u on u.id = m.user_id
         where m.library_id = ? and m.family_id = ?`,
      )
        .bind(library.id, hold.familyId)
        .all<{ email: string }>(),
    ]);
    for (const { email } of emails.results) {
      try {
        const result = await deps.mailer.send(
          holdReadyEmail({
            libraryName: library.name,
            to: email,
            title: title ?? "A book you asked for",
            lapseDays: HOLD_LAPSE_DAYS,
            siteUrl: libraryHome(deps.origin, library),
          }),
          "urgent",
        );
        if (!result.ok) console.error(`Waitlist email not sent via ${result.provider}`);
      } catch (error) {
        console.error("Waitlist email failed:", error);
      }
    }
  }
  return told;
}
