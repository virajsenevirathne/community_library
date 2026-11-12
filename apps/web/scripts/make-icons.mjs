// Renders the home-screen app icons (PNG) from public/favicon.svg.
// Run after changing the logo: node scripts/make-icons.mjs
import { readFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const dir = new URL("../public", import.meta.url).pathname;
const svg = readFileSync(`${dir}/favicon.svg`, "utf8");
const browser = await chromium.launch();
const page = await browser.newPage();
// Full-bleed icons (any) and a padded one for Android's masks.
for (const [name, size, pad] of [
  ["icon-192.png", 192, 0.1],
  ["icon-512.png", 512, 0.1],
  ["icon-maskable-512.png", 512, 0.2],
  ["apple-touch-icon.png", 180, 0.1],
]) {
  const inner = Math.round(size * (1 - 2 * pad));
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<html><body style="margin:0;background:#fbf7ee;display:grid;place-items:center;width:${size}px;height:${size}px">
     <div style="width:${inner}px;height:${inner}px">${svg.replace("<svg ", `<svg width="${inner}" height="${inner}" `)}</div></body></html>`,
  );
  await page.screenshot({ path: `${dir}/${name}`, omitBackground: false });
}
await browser.close();
