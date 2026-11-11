import { normalizeShortCode } from "@community-library/core";

export interface CopyView {
  code: string;
  title: { id: string; title: string; authors: string; coverUrl: string | null };
  state: "available" | "mine" | "out" | "unavailable";
  status: "available" | "lost" | "damaged" | "retired";
  loan: {
    id: string;
    dueOn: string;
    overdueDays: number;
    canExtend: boolean;
    extensionsLeft?: number;
    /** Handed back by the family; waiting for staff to check it in. */
    handedBack?: boolean;
    familyName?: string;
  } | null;
  reportedFound: boolean;
  family: {
    status: "active" | "pending" | "deactivated";
    booksOut: number;
    maxLoans: number;
  } | null;
  can: { borrow: boolean; return: boolean; reportFound: boolean };
}

/**
 * Reads a copy code from what a camera or a person gave us: a sticker link
 * such as https://library.example.org/c/K7R2, or just the code.
 */
export function parseCopyCode(value: string): string | null {
  const fromLink = value.trim().match(/\/c\/([A-Za-z0-9-]{4,6})\/?$/i)?.[1];
  return normalizeShortCode(fromLink ?? value);
}

const DUE = new Intl.DateTimeFormat(undefined, {
  weekday: "long",
  day: "numeric",
  month: "long",
  timeZone: "UTC",
});

/** "Friday 21 November" for a YYYY-MM-DD date. */
export function formatDate(date: string): string {
  return DUE.format(new Date(`${date}T12:00:00Z`));
}

export function lateText(days: number): string {
  if (days <= 0) return "";
  return days === 1 ? "1 day late" : `${days} days late`;
}
