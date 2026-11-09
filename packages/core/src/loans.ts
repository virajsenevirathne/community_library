export type LoanLimitResult =
  | { ok: true; remaining: number }
  | { ok: false; reason: "limit_reached" };

/**
 * Whether a family may borrow one more book.
 *
 * This is the rule only. The Worker must still check and insert in one atomic
 * D1 batch, so two parents borrowing at the same moment cannot pass the limit.
 */
export function checkLoanLimit(openLoans: number, maxLoans: number): LoanLimitResult {
  if (!Number.isInteger(openLoans) || openLoans < 0) {
    throw new RangeError(`openLoans must be a non-negative integer, got ${openLoans}`);
  }
  if (!Number.isInteger(maxLoans) || maxLoans < 1) {
    throw new RangeError(`maxLoans must be a positive integer, got ${maxLoans}`);
  }
  if (openLoans >= maxLoans) {
    return { ok: false, reason: "limit_reached" };
  }
  return { ok: true, remaining: maxLoans - openLoans - 1 };
}
