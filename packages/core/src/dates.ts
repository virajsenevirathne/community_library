import type { LibrarySettings } from "./settings.ts";

/** A calendar date in the library's timezone, written YYYY-MM-DD. */
export type LocalDate = string;

const DAY_MS = 86_400_000;

/** The calendar date and hour at `instant` in `timezone`. */
export function localParts(
  instant: Date,
  timezone: string,
): { date: LocalDate; hour: number; weekday: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const date = `${get("year")}-${get("month")}-${get("day")}`;
  return { date, hour: Number(get("hour")), weekday: weekdayOf(date) };
}

/** 0 = Sunday. Works on the calendar date, so no timezone is involved. */
export function weekdayOf(date: LocalDate): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

export function addDays(date: LocalDate, days: number): LocalDate {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Whole days from `from` to `to` (negative if `to` is earlier). */
export function daysBetween(from: LocalDate, to: LocalDate): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

export function isClosed(
  date: LocalDate,
  settings: Pick<LibrarySettings, "closedWeekdays" | "closedDates">,
): boolean {
  return settings.closedWeekdays.includes(weekdayOf(date)) || settings.closedDates.includes(date);
}

/**
 * The due date for a loan made at `borrowedAt`: loanDays later, moved forward
 * to the next open day so a book is never due while the centre is closed.
 */
export function dueDateFor(borrowedAt: Date, settings: LibrarySettings): LocalDate {
  return dueDateDetails(borrowedAt, settings).due;
}

/**
 * Like dueDateFor, but also says whether the date was moved past closed days,
 * so the borrow screen can explain "Due Monday (we're closed at the weekend)".
 */
export function dueDateDetails(
  borrowedAt: Date,
  settings: LibrarySettings,
): { due: LocalDate; movedForClosure: boolean } {
  const start = addDays(localParts(borrowedAt, settings.timezone).date, settings.loanDays);
  let due = start;
  // closedWeekdays always leaves an open day, so this ends within a week plus holidays.
  for (let i = 0; i < 400 && isClosed(due, settings); i++) due = addDays(due, 1);
  return { due, movedForClosure: due !== start };
}

/** Days late on `today` for a loan due on `due`. 0 if not late. */
export function daysOverdue(due: LocalDate, today: LocalDate): number {
  return Math.max(0, daysBetween(due, today));
}
