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

/** SQL (?1 library, ?2 title): copies of the title on the shelf right now. */
export const ON_SHELF = `select count(*) from copies c where c.title_id = ?2 and c.library_id = ?1
  and c.status = 'available'
  and not exists (select 1 from loans l where l.copy_id = c.id and l.library_id = c.library_id
                  and l.returned_at is null)`;

/** SQL (?1 library, ?2 title, ?3 cutoff): families told about a copy since the cutoff. */
const TOLD_RECENTLY = `select count(*) from holds t where t.library_id = ?1 and t.title_id = ?2
  and t.notified_at is not null and t.notified_at > ?3`;

/**
 * SQL for a hold `h`: its family can borrow (active) and can be emailed. A
 * paused family, or one with nobody to email, doesn't take anyone's turn.
 */
export const ELIGIBLE = `exists (select 1 from families f where f.id = h.family_id and f.library_id = ?1
  and f.status = 'active'
  and exists (select 1 from memberships m where m.family_id = f.id and m.library_id = f.library_id))`;

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
  const gap = () => Date.now() - NOTIFY_GAP_DAYS * 86_400_000;
  // An upper bound only: each claim below re-checks there's still a copy free.
  const room = await DB.prepare(`select (${ON_SHELF}) - (${TOLD_RECENTLY}) as free`)
    .bind(library.id, titleId, gap())
    .first<number>("free");
  let told = 0;
  for (let i = 0; i < (room ?? 0); i++) {
    // One statement, so two returns at once can't both hand out the last copy.
    const hold = await DB.prepare(
      `update holds set notified_at = ?4
       where id = (select h.id from holds h
                   where h.library_id = ?1 and h.title_id = ?2
                     and (h.notified_at is null or h.notified_at <= ?3)
                     and ${ELIGIBLE.replaceAll("?1", "h.library_id")}
                   -- Families not told yet go first, then in the order they joined.
                   order by h.notified_at is not null, h.created_at, h.id limit 1)
         and (${ON_SHELF}) - (${TOLD_RECENTLY}) > 0
       returning family_id as familyId`,
    )
      .bind(library.id, titleId, gap(), Date.now())
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
