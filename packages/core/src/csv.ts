/**
 * Reads a CSV file exported from another system (a spreadsheet, a centre's
 * parent contact list). Handles quoted fields, commas inside quotes, CRLF,
 * a byte-order mark, and semicolon-separated files (common in Europe).
 */
export function parseCsv(text: string): string[][] {
  const input = text.replace(/^﻿/, "");
  const firstLine = input.split(/\r?\n/, 1)[0] ?? "";
  const delimiter =
    (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ";" : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quoted) {
      if (ch === '"' && input[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === "") quoted = true;
    else if (ch === delimiter) {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && input[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ""));
}

/**
 * Writes rows as CSV that spreadsheets open safely: every cell is quoted,
 * CRLF line ends and a byte-order mark (so Excel reads accents right), and a
 * cell that starts like a formula (=, +, -, @, tab or a line break, also
 * after spaces, since some programs trim them) is prefixed with ' so a
 * spreadsheet shows it as text instead of running it.
 */
export function toCsv(
  rows: (string | number | null | undefined)[][],
  /** False for the later parts of a file written in pieces. */
  withBom = true,
): string {
  const cell = (value: string | number | null | undefined) => {
    let text = value === null || value === undefined ? "" : String(value);
    if (/^[\s]*[=+\-@]|^[\t\r\n]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  };
  if (rows.length === 0) return withBom ? "\uFEFF" : "";
  return `${withBom ? "\uFEFF" : ""}${rows.map((row) => row.map(cell).join(",")).join("\r\n")}\r\n`;
}

// A plain address only: no display names, quotes or angle brackets.
const EMAIL =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

export function isEmail(value: string): boolean {
  return EMAIL.test(value.trim());
}

export interface InviteRow {
  /** Line number in the file, counting the header as line 1. */
  line: number;
  familyName: string;
  email: string;
  problem: null | "invalid_email" | "missing_family" | "duplicate_in_file";
}

/**
 * Finds the family-name and email columns and reads one invite per row.
 * Only those two columns are read; everything else (children's names,
 * phone numbers, rooms) is ignored and never stored.
 */
export function readInvites(text: string): { rows: InviteRow[]; error: string | null } {
  const table = parseCsv(text);
  const header = (table[0] ?? []).map((h) => h.trim().toLowerCase());
  const find = (patterns: RegExp[]) => {
    for (const pattern of patterns) {
      const index = header.findIndex((h) => pattern.test(h));
      if (index >= 0) return index;
    }
    return -1;
  };
  const emailCol = find([/^e-?mail/, /e-?mail/]);
  // A plain "Name" column is usually the child's name, so it is never used.
  const familyCol = find([/^family/, /surname|last.?name|family/]);
  if (emailCol < 0 || familyCol < 0) {
    return {
      rows: [],
      error:
        "We couldn't find the columns. The first row must have headings, including one for the family name (such as “Family name” or “Surname”) and one for “Email”.",
    };
  }
  const seen = new Set<string>();
  const rows = table.slice(1).map((cells, i): InviteRow => {
    const familyName = (cells[familyCol] ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
    const email = (cells[emailCol] ?? "").trim().toLowerCase();
    let problem: InviteRow["problem"] = null;
    if (!familyName) problem = "missing_family";
    else if (!isEmail(email)) problem = "invalid_email";
    else if (seen.has(email)) problem = "duplicate_in_file";
    if (!problem) seen.add(email);
    return { line: i + 2, familyName, email, problem };
  });
  return { rows, error: null };
}
