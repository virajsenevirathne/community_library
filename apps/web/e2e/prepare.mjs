// Prepares the browser tests: a fresh local database with every migration
// and the test data, and fake camera videos: a book's QR sticker, and a
// book's ISBN barcode.
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import QRCode from "qrcode";

const here = import.meta.dirname;
const web = resolve(here, "..");
const state = resolve(web, ".e2e-state");
const origin = process.env.E2E_ORIGIN ?? "http://localhost:5174";

rmSync(state, { recursive: true, force: true });
mkdirSync(state, { recursive: true });
const wrangler = (...args) =>
  execFileSync("npx", ["wrangler", ...args, "--local", "--persist-to", state], {
    cwd: web,
    stdio: ["ignore", "ignore", "inherit"],
  });
wrangler("d1", "migrations", "apply", "DB");
wrangler("d1", "execute", "DB", "--file", resolve(here, "seed.sql"));

/** A Y4M video (the format Chrome's fake camera reads) of a black-and-white picture. */
function y4m(luma, width, height, frames = 5) {
  const chroma = Buffer.alloc((width / 2) * (height / 2) * 2, 128);
  const frame = Buffer.concat([Buffer.from("FRAME\n"), luma, chroma]);
  const header = Buffer.from(`YUV4MPEG2 W${width} H${height} F10:1 Ip A1:1 C420jpeg\n`);
  return Buffer.concat([header, ...Array.from({ length: frames }, () => frame)]);
}

/** A video of a QR code, such as a book's sticker. */
function qrVideo(text, width = 640, height = 480) {
  const qr = QRCode.create(text, { errorCorrectionLevel: "M" });
  const size = qr.modules.size + 8; // with a quiet zone
  const scale = Math.floor(Math.min(width, height) / size);
  const left = Math.floor((width - size * scale) / 2);
  const top = Math.floor((height - size * scale) / 2);
  const y = Buffer.alloc(width * height, 255);
  for (let row = 0; row < qr.modules.size; row++) {
    for (let col = 0; col < qr.modules.size; col++) {
      if (!qr.modules.get(row, col)) continue;
      for (let dy = 0; dy < scale; dy++) {
        const start = (top + (row + 4) * scale + dy) * width + left + (col + 4) * scale;
        y.fill(0, start, start + scale);
      }
    }
  }
  return y4m(y, width, height);
}

/** The bars (1 = black) of an EAN-13 barcode, the kind on a book's back cover. */
function ean13Bars(digits) {
  const L = [
    "0001101",
    "0011001",
    "0010011",
    "0111101",
    "0100011",
    "0110001",
    "0101111",
    "0111011",
    "0110111",
    "0001011",
  ];
  const G = L.map((code) =>
    [...code]
      .map((b) => (b === "1" ? "0" : "1"))
      .reverse()
      .join(""),
  );
  const R = L.map((code) => [...code].map((b) => (b === "1" ? "0" : "1")).join(""));
  const parity = [
    "LLLLLL",
    "LLGLGG",
    "LLGGLG",
    "LLGGGL",
    "LGLLGG",
    "LGGLLG",
    "LGGGLL",
    "LGLGLG",
    "LGLGGL",
    "LGGLGL",
  ];
  const d = [...digits].map(Number);
  const left = d
    .slice(1, 7)
    .map((n, i) => (parity[d[0]][i] === "L" ? L[n] : G[n]))
    .join("");
  const right = d
    .slice(7)
    .map((n) => R[n])
    .join("");
  return `101${left}01010${right}101`;
}

/** A video of a book's ISBN barcode. */
function barcodeVideo(isbn, width = 640, height = 480) {
  const bars = ean13Bars(isbn);
  const scale = Math.floor(width / (bars.length + 20));
  const left = Math.floor((width - bars.length * scale) / 2);
  const y = Buffer.alloc(width * height, 255);
  for (let row = Math.floor(height * 0.25); row < Math.floor(height * 0.75); row++) {
    for (const [i, bar] of [...bars].entries()) {
      if (bar === "1")
        y.fill(0, row * width + left + i * scale, row * width + left + (i + 1) * scale);
    }
  }
  return y4m(y, width, height);
}

writeFileSync(resolve(state, "book-qr.y4m"), qrVideo(`${origin}/c/BK3A`));
// A made-up ISBN that no book service knows, so the tests never depend on one.
writeFileSync(resolve(state, "book-isbn.y4m"), barcodeVideo("9780000000002"));
