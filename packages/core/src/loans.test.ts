import { describe, expect, it } from "vitest";
import { checkLoanLimit } from "./loans.ts";

describe("checkLoanLimit", () => {
  it("allows a borrow under the limit and reports what is left after it", () => {
    expect(checkLoanLimit(0, 5)).toEqual({ ok: true, remaining: 4 });
    expect(checkLoanLimit(4, 5)).toEqual({ ok: true, remaining: 0 });
  });

  it("refuses a borrow at or over the limit", () => {
    expect(checkLoanLimit(5, 5)).toEqual({ ok: false, reason: "limit_reached" });
    expect(checkLoanLimit(6, 5)).toEqual({ ok: false, reason: "limit_reached" });
  });

  it("rejects invalid input", () => {
    expect(() => checkLoanLimit(-1, 5)).toThrow(RangeError);
    expect(() => checkLoanLimit(1.5, 5)).toThrow(RangeError);
    expect(() => checkLoanLimit(0, 0)).toThrow(RangeError);
  });
});
