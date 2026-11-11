/**
 * Short codes printed under each QR sticker, such as K7Q2.
 * The alphabet leaves out characters that are easy to confuse on a worn
 * sticker or when typed: 0/O/Q, 1/I/L, S (5), Z (2) and U/V.
 * 26 characters over 4 places gives about 457,000 codes. Codes are unique
 * across all libraries, so the insert path retries on a clash.
 */
export const CODE_ALPHABET = "23456789ABCDEFGHJKMNPRTWXY";
export const CODE_LENGTH = 4;

/** Highest byte value that maps evenly onto the alphabet (no modulo bias). */
const BYTE_LIMIT = 256 - (256 % CODE_ALPHABET.length);

export function randomShortCode(random: (n: number) => Uint8Array = defaultRandom): string {
  let code = "";
  while (code.length < CODE_LENGTH) {
    for (const byte of random(CODE_LENGTH * 2)) {
      if (byte >= BYTE_LIMIT) continue; // rejection sampling
      code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
      if (code.length === CODE_LENGTH) break;
    }
  }
  return code;
}

function defaultRandom(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

/**
 * Cleans a code someone typed: uppercase, with spaces and dashes removed.
 * Returns null if it cannot be a valid code. Characters we never print
 * (such as O or 1) are rejected rather than guessed.
 */
export function normalizeShortCode(input: string): string | null {
  const cleaned = input.toUpperCase().replace(/[\s-]/g, "");
  if (cleaned.length !== CODE_LENGTH) return null;
  for (const ch of cleaned) if (!CODE_ALPHABET.includes(ch)) return null;
  return cleaned;
}

/** Normalises an ISBN-10 or ISBN-13 to ISBN-13 digits, or null if the checksum fails. */
export function normalizeIsbn(input: string): string | null {
  const raw = input.toUpperCase().replace(/[\s-]/g, "");
  // Only 978/979 numbers are books; other 13-digit barcodes are products.
  if (/^97[89]\d{10}$/.test(raw)) {
    const sum = [...raw.slice(0, 12)].reduce(
      (acc, d, i) => acc + Number(d) * (i % 2 === 0 ? 1 : 3),
      0,
    );
    const check = (10 - (sum % 10)) % 10;
    return check === Number(raw[12]) ? raw : null;
  }
  if (/^\d{9}[\dX]$/.test(raw)) {
    const sum = [...raw].reduce((acc, ch, i) => acc + (ch === "X" ? 10 : Number(ch)) * (10 - i), 0);
    if (sum % 11 !== 0) return null;
    const body = `978${raw.slice(0, 9)}`;
    const s13 = [...body].reduce((acc, d, i) => acc + Number(d) * (i % 2 === 0 ? 1 : 3), 0);
    return `${body}${(10 - (s13 % 10)) % 10}`;
  }
  return null;
}
