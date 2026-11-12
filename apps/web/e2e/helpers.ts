import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, type Page } from "@playwright/test";
import { SERVER_LOG } from "./playwright.config.ts";

/** Saved sessions (see auth.setup.ts). */
export const PARENT = resolve(import.meta.dirname, "../.e2e-state/parent.json");
export const ADMIN = resolve(import.meta.dirname, "../.e2e-state/admin.json");

/** The newest sign-in code printed for `email` after `since` (a log length). */
async function codeFor(email: string, since: number): Promise<string> {
  for (let i = 0; i < 50; i++) {
    const log = readFileSync(SERVER_LOG, "utf8").slice(since);
    const block = log.split("✉️  To: ").findLast((b) => b.startsWith(email));
    const code = block?.match(/Subject: (\d{6}) is your/)?.[1];
    if (code) return code;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`No sign-in code was printed for ${email}`);
}

/** Signs in with an emailed code, the way a parent does. */
export async function signIn(page: Page, email: string, next = "/") {
  const since = readFileSync(SERVER_LOG, "utf8").length;
  await page.goto(`/signin?next=${encodeURIComponent(next)}`);
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Email me a code" }).click();
  const code = await codeFor(email, since);
  // The form signs in by itself once the sixth digit is typed.
  await page.getByLabel("6-digit code").fill(code);
  // Then it may offer to save a passkey (unless declined before), which tests decline.
  const notNow = page.getByRole("button", { name: "Not now" });
  await expect
    .poll(
      async () => (await notNow.isVisible()) || !new URL(page.url()).pathname.startsWith("/signin"),
    )
    .toBe(true);
  if (await notNow.isVisible()) await notNow.click();
  await page.waitForURL((url) => !url.pathname.startsWith("/signin"), { timeout: 15_000 });
  await expect(page.getByRole("heading").first()).toBeVisible();
}
