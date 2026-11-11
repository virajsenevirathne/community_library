import { daysBetween, type LocalDate } from "./dates.ts";
import type { LibrarySettings } from "./settings.ts";

export interface OpenLoan {
  loanId: string;
  familyId: string;
  dueOn: LocalDate;
}

/** One reminder about one loan. `key` is unique per loan and stage, so it is never sent twice. */
export interface LoanReminder {
  loanId: string;
  kind: "due_soon" | "overdue";
  /** Days overdue for this stage (0 for due_soon). */
  stage: number;
  key: string;
}

/**
 * Which reminder each open loan needs today. A loan gets at most one: the
 * latest stage it has reached. Stages already sent are skipped by the caller
 * using `key`, so a missed day catches up without sending old stages.
 */
export function remindersFor(
  loans: OpenLoan[],
  settings: Pick<LibrarySettings, "remindBeforeDays" | "overdueReminderDays">,
  today: LocalDate,
): Map<string, LoanReminder[]> {
  const byFamily = new Map<string, LoanReminder[]>();
  const stages = [...settings.overdueReminderDays].sort((a, b) => a - b);
  for (const loan of loans) {
    const late = daysBetween(loan.dueOn, today);
    let reminder: LoanReminder | null = null;
    if (late > 0) {
      const stage = stages.filter((s) => s <= late).at(-1);
      if (stage !== undefined) {
        reminder = {
          loanId: loan.loanId,
          kind: "overdue",
          stage,
          key: `loan:${loan.loanId}:overdue:${stage}`,
        };
      }
    } else if (settings.remindBeforeDays > 0 && -late <= settings.remindBeforeDays) {
      reminder = {
        loanId: loan.loanId,
        kind: "due_soon",
        stage: 0,
        key: `loan:${loan.loanId}:due_soon`,
      };
    }
    if (!reminder) continue;
    const list = byFamily.get(loan.familyId) ?? [];
    list.push(reminder);
    byFamily.set(loan.familyId, list);
  }
  return byFamily;
}

/** True when the loan is late enough that staff should follow it up. */
export function needsStaff(dueOn: LocalDate, today: LocalDate, staffFlagDays: number): boolean {
  return daysBetween(dueOn, today) >= staffFlagDays;
}
