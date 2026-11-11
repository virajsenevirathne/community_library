/** Per-library settings, stored as JSON on the libraries row. */
export interface LibrarySettings {
  /** Days a book may be kept. */
  loanDays: number;
  /** Most books a family may have out at once. */
  maxLoans: number;
  /** How many times a family may extend one loan. */
  maxExtensions: number;
  /** IANA timezone, used for due dates and reminder timing. Chosen at setup. */
  timezone: string;
  /** Local hour (0–23) when the daily reminder email goes out. */
  reminderHour: number;
  /** Days before the due date to send the heads-up. 0 turns it off. */
  remindBeforeDays: number;
  /** Days overdue that trigger a reminder to the family. */
  overdueReminderDays: number[];
  /** Days overdue after which the loan is flagged to staff. */
  staffFlagDays: number;
  /** Weekdays the centre is closed (0 = Sunday). No reminders go out, due dates move past them. */
  closedWeekdays: number[];
  /** Specific closed dates (YYYY-MM-DD), such as public holidays. */
  closedDates: string[];
  /** New families wait for staff approval before they can borrow. */
  requireApproval: boolean;
  /**
   * When on, a parent's "Return" marks the book as handed back, and the loan
   * closes when staff check it in (scan it from the returns basket). When off,
   * the parent's tap closes the loan straight away.
   */
  returnsNeedCheckIn: boolean;
  /** Months after which closed loans forget who borrowed them. */
  historyMonths: number;
}

export const DEFAULT_SETTINGS: Readonly<LibrarySettings> = Object.freeze({
  loanDays: 14,
  maxLoans: 5,
  maxExtensions: 1,
  timezone: "UTC",
  reminderHour: 9,
  remindBeforeDays: 2,
  overdueReminderDays: Object.freeze([1, 7, 14]) as number[],
  staffFlagDays: 14,
  closedWeekdays: Object.freeze([0, 6]) as number[],
  closedDates: Object.freeze([]) as unknown as string[],
  requireApproval: false,
  returnsNeedCheckIn: false,
  historyMonths: 12,
});

/** A fresh, independent copy of the defaults (the arrays are not shared). */
export function defaultSettings(): LibrarySettings {
  return structuredClone({ ...DEFAULT_SETTINGS }) as LibrarySettings;
}

/** Names shown next to each setting, and used to build error messages. */
export const SETTING_LABELS: Record<keyof LibrarySettings, string> = {
  loanDays: "Loan length (days)",
  maxLoans: "Books per family",
  maxExtensions: "Extensions per loan",
  timezone: "Timezone",
  reminderHour: "Reminder time",
  remindBeforeDays: "Heads-up before due (days)",
  overdueReminderDays: "Overdue reminders (days late)",
  staffFlagDays: "Flag to staff after (days late)",
  closedWeekdays: "Closed days",
  closedDates: "Closed dates",
  requireApproval: "Staff approve new families",
  returnsNeedCheckIn: "Staff check returned books in",
  historyMonths: "Forget who borrowed a book after (months)",
};

export type SettingsError = { field: keyof LibrarySettings; message: string };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isInt(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

/** A real calendar date written YYYY-MM-DD (rejects 2026-02-30). */
export function isRealDate(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_DATE.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(time) && new Date(time).toISOString().slice(0, 10) === value;
}

/** A named IANA timezone such as Australia/Sydney. Fixed offsets like +05:00 are refused. */
export function isValidTimezone(timezone: string): boolean {
  if (timezone === "UTC") return true;
  if (!/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)+$/.test(timezone)) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

type IntField =
  | "loanDays"
  | "maxLoans"
  | "maxExtensions"
  | "reminderHour"
  | "remindBeforeDays"
  | "staffFlagDays"
  | "historyMonths";

const INT_RANGES: Record<IntField, [number, number]> = {
  loanDays: [1, 120],
  maxLoans: [1, 50],
  maxExtensions: [0, 10],
  reminderHour: [0, 23],
  remindBeforeDays: [0, 14],
  staffFlagDays: [1, 365],
  historyMonths: [1, 120],
};

/**
 * Checks a partial settings update. Returns the merged settings, or the list of
 * fields that are wrong with a message a person can read. Unknown keys are ignored.
 */
export function mergeSettings(
  current: LibrarySettings,
  patch: Record<string, unknown>,
): { ok: true; settings: LibrarySettings } | { ok: false; errors: SettingsError[] } {
  const next = structuredClone(current);
  const errors: SettingsError[] = [];
  const fail = (field: keyof LibrarySettings, rule: string) =>
    errors.push({ field, message: `${SETTING_LABELS[field]}: ${rule}` });

  for (const [field, [min, max]] of Object.entries(INT_RANGES) as [IntField, [number, number]][]) {
    if (!(field in patch)) continue;
    const value = patch[field];
    if (isInt(value, min, max)) next[field] = value;
    else fail(field, `enter a whole number from ${min} to ${max}.`);
  }

  if ("timezone" in patch) {
    const value = patch.timezone;
    if (typeof value === "string" && isValidTimezone(value)) next.timezone = value;
    else fail("timezone", "choose a timezone from the list, for example Australia/Sydney.");
  }
  if ("overdueReminderDays" in patch) {
    const value = patch.overdueReminderDays;
    if (Array.isArray(value) && value.length <= 10 && value.every((d) => isInt(d, 1, 365))) {
      next.overdueReminderDays = [...new Set(value as number[])].sort((a, b) => a - b);
    } else {
      fail("overdueReminderDays", "enter up to 10 numbers of days late, each from 1 to 365.");
    }
  }
  if ("closedWeekdays" in patch) {
    const value = patch.closedWeekdays;
    if (!Array.isArray(value) || !value.every((d) => isInt(d, 0, 6))) {
      fail("closedWeekdays", "pick days of the week from the list.");
    } else if (new Set(value).size >= 7) {
      fail("closedWeekdays", "keep at least one day open.");
    } else {
      next.closedWeekdays = [...new Set(value as number[])].sort((a, b) => a - b);
    }
  }
  if ("closedDates" in patch) {
    const value = patch.closedDates;
    if (Array.isArray(value) && value.length <= 366 && value.every(isRealDate)) {
      next.closedDates = [...new Set(value as string[])].sort();
    } else {
      fail("closedDates", "pick each date from the calendar (up to 366 dates).");
    }
  }
  for (const field of ["requireApproval", "returnsNeedCheckIn"] as const) {
    if (!(field in patch)) continue;
    const value = patch[field];
    if (typeof value === "boolean") next[field] = value;
    else fail(field, "turn this on or off.");
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, settings: next };
}

/** Reads stored JSON, falling back to defaults for anything missing or invalid. */
export function parseSettings(json: string | null | undefined): LibrarySettings {
  let settings = defaultSettings();
  if (!json) return settings;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return settings;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return settings;
  // Merge field by field so one bad value does not throw away the rest.
  for (const [key, value] of Object.entries(raw)) {
    const merged = mergeSettings(settings, { [key]: value });
    if (merged.ok) settings = merged.settings;
  }
  return settings;
}

/**
 * When the library checks returns in, a book a family has handed back stops
 * counting towards their limit and their reminders for this many days. If
 * staff haven't checked it in by then, it counts again (so tapping Return
 * while keeping the book can't be used to borrow more).
 */
export const HANDBACK_GRACE_DAYS = 3;

/** Hand-backs made after this moment are still within the grace period. */
export function handBackCutoff(now = Date.now()): number {
  return now - HANDBACK_GRACE_DAYS * 86_400_000;
}
