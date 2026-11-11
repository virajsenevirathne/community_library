import { describe, expect, it } from "vitest";
import { normalizeIsbn, normalizeShortCode, randomShortCode } from "./codes.ts";
import { addDays, daysOverdue, dueDateDetails, dueDateFor, localParts } from "./dates.ts";
import { DEFAULT_SETTINGS, defaultSettings, mergeSettings, parseSettings } from "./settings.ts";

describe("dates", () => {
  it("reads the local date and hour in the library's timezone", () => {
    // 2026-11-10 22:30 UTC is 2026-11-11 09:30 in Sydney (daylight saving).
    const at = new Date("2026-11-10T22:30:00Z");
    expect(localParts(at, "Australia/Sydney")).toMatchObject({ date: "2026-11-11", hour: 9 });
    expect(localParts(at, "UTC")).toMatchObject({ date: "2026-11-10", hour: 22 });
  });

  it("moves a due date off a closed day", () => {
    const settings = { ...DEFAULT_SETTINGS, loanDays: 14, closedWeekdays: [0, 6] };
    // Borrowed Saturday 2026-11-07 → 14 days is Saturday 2026-11-21 → Monday 2026-11-23.
    expect(dueDateFor(new Date("2026-11-07T10:00:00Z"), settings)).toBe("2026-11-23");
    const holiday = { ...settings, closedDates: ["2026-11-23"] };
    expect(dueDateFor(new Date("2026-11-07T10:00:00Z"), holiday)).toBe("2026-11-24");
    expect(dueDateDetails(new Date("2026-11-07T10:00:00Z"), settings).movedForClosure).toBe(true);
    // Borrowed Monday 2026-11-09 → due Monday 2026-11-23, not moved.
    expect(dueDateDetails(new Date("2026-11-09T10:00:00Z"), settings)).toEqual({
      due: "2026-11-23",
      movedForClosure: false,
    });
  });

  it("reports midnight as hour 0, not 24", () => {
    expect(localParts(new Date("2026-11-10T00:00:00Z"), "UTC")).toMatchObject({
      date: "2026-11-10",
      hour: 0,
    });
  });

  it("counts days overdue", () => {
    expect(daysOverdue("2026-11-10", "2026-11-09")).toBe(0);
    expect(daysOverdue("2026-11-10", "2026-11-10")).toBe(0);
    expect(daysOverdue("2026-11-10", "2026-11-17")).toBe(7);
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });
});

describe("short codes", () => {
  it("are four characters from the printable alphabet", () => {
    for (let i = 0; i < 50; i++) expect(normalizeShortCode(randomShortCode())).not.toBeNull();
  });

  it("accept lowercase and spaces but reject characters never printed", () => {
    expect(normalizeShortCode(" k7-r2 ")).toBe("K7R2");
    expect(normalizeShortCode("K0R2")).toBeNull();
    expect(normalizeShortCode("KSR2")).toBeNull();
    expect(normalizeShortCode("K7Q")).toBeNull();
  });
});

describe("ISBNs", () => {
  it("accept valid ISBN-13 and convert ISBN-10", () => {
    expect(normalizeIsbn("978-0-14-032872-1")).toBe("9780140328721");
    expect(normalizeIsbn("0-14-032872-X")).toBeNull();
    expect(normalizeIsbn("0140328726")).toBe("9780140328721");
    expect(normalizeIsbn("9780140328722")).toBeNull();
    // A valid EAN-13 that is not a book.
    expect(normalizeIsbn("4006381333931")).toBeNull();
  });
});

describe("settings", () => {
  it("never share arrays with the defaults", () => {
    const a = defaultSettings();
    a.closedDates.push("2026-12-25");
    expect(defaultSettings().closedDates).toEqual([]);
    expect(parseSettings(null).closedDates).toEqual([]);
  });

  it("explain errors in plain words with the setting's name", () => {
    const result = mergeSettings(defaultSettings(), {
      maxLoans: 0,
      closedWeekdays: [0, 1, 2, 3, 4, 5, 6],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContainEqual({
        field: "maxLoans",
        message: "Books per family: enter a whole number from 1 to 50.",
      });
      expect(result.errors).toContainEqual({
        field: "closedWeekdays",
        message: "Closed days: keep at least one day open.",
      });
    }
  });

  it("refuse fixed offsets and unknown zones", () => {
    expect(mergeSettings(defaultSettings(), { timezone: "+05:00" }).ok).toBe(false);
    expect(mergeSettings(defaultSettings(), { timezone: "Mars/Base" }).ok).toBe(false);
    expect(mergeSettings(defaultSettings(), { timezone: "America/New_York" }).ok).toBe(true);
  });

  it("merge valid fields and report invalid ones", () => {
    const ok = mergeSettings(DEFAULT_SETTINGS, {
      loanDays: 21,
      timezone: "Australia/Sydney",
      junk: 1,
    });
    expect(ok).toMatchObject({
      ok: true,
      settings: { loanDays: 21, timezone: "Australia/Sydney" },
    });
    const bad = mergeSettings(DEFAULT_SETTINGS, {
      maxLoans: 0,
      timezone: "Mars/Base",
      closedWeekdays: [0, 1, 2, 3, 4, 5, 6],
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok)
      expect(bad.errors.map((e) => e.field).sort()).toEqual([
        "closedWeekdays",
        "maxLoans",
        "timezone",
      ]);
  });

  it("parse stored JSON, keeping good fields when one is bad", () => {
    expect(parseSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings('{"closedDates":["2026-02-30"]}').closedDates).toEqual([]);
    expect(parseSettings("not json")).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings('{"loanDays":7,"maxLoans":-1}')).toMatchObject({
      loanDays: 7,
      maxLoans: 5,
    });
  });
});
