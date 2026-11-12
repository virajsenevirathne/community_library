// Prepares the browser tests: a fresh local database with every migration
// and the test data, and a fake camera video showing a book's QR sticker.
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

/** A Y4M video (the format Chrome's fake camera reads) of a QR code. */
function qrVideo(text, width = 640, height = 480, frames = 5) {
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
  const chroma = Buffer.alloc((width / 2) * (height / 2) * 2, 128);
  const frame = Buffer.concat([Buffer.from("FRAME\n"), y, chroma]);
  const header = Buffer.from(`YUV4MPEG2 W${width} H${height} F10:1 Ip A1:1 C420jpeg\n`);
  return Buffer.concat([header, ...Array.from({ length: frames }, () => frame)]);
}
writeFileSync(resolve(state, "book-qr.y4m"), qrVideo(`${origin}/c/BK3A`));
