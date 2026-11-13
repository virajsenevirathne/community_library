import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { SERVER_LOG } from "./paths.ts";

export const SERVER_LOG_PATH = SERVER_LOG;

/** Saved sessions (see auth.setup.ts). */
export const PARENT = resolve(import.meta.dirname, "../.e2e-state/parent.json");
export const ADMIN = resolve(import.meta.dirname, "../.e2e-state/admin.json");
export const OTHER_PARENT = resolve(import.meta.dirname, "../.e2e-state/other-parent.json");

/** The newest sign-in code printed for `email` after `since` (a log length). */
export async function codeFor(email: string, since: number): Promise<string> {
  for (let i = 0; i < 50; i++) {
    const log = readFileSync(SERVER_LOG, "utf8").slice(since);
    const block = log.split("✉️  To: ").findLast((b) => b.startsWith(email));
    const code = block?.match(/Subject: (\d{6}) is your/)?.[1];
    if (code) return code;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`No sign-in code was printed for ${email}`);
}

/** How much the server has printed so far: pass it to emailTo to see only newer emails. */
export function logLength(): number {
  return readFileSync(SERVER_LOG, "utf8").length;
}

/** The newest email printed for `email` after `since` (a log length), whose subject matches. */
export async function emailTo(email: string, since: number, subject: RegExp): Promise<string> {
  for (let i = 0; i < 50; i++) {
    const log = readFileSync(SERVER_LOG, "utf8").slice(since);
    const block = log
      .split("✉️  To: ")
      .findLast((b) => b.startsWith(`${email}\n`) && subject.test(b.split("\n")[1] ?? ""));
    if (block) return block;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`No email matching ${subject} was printed for ${email}`);
}

/** The first link in an email that goes to `path` (such as "/invite/"), as a path to open. */
export function linkIn(email: string, path: string): string {
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const url = email.match(new RegExp(`https?://\\S+${escaped}[^\\s)>"]*`))?.[0];
  if (!url) throw new Error(`No ${path} link in the email:\n${email}`);
  return new URL(url).pathname + new URL(url).search;
}

/**
 * Gives the page its own network address, as each parent has on their own
 * phone, so the per-network limits on sign-in codes don't add up across tests.
 */
export async function ownAddress(page: Page) {
  const octet = () => Math.floor(Math.random() * 250) + 1;
  await page
    .context()
    .setExtraHTTPHeaders({ "cf-connecting-ip": `10.${octet()}.${octet()}.${octet()}` });
}

/** Signs in with an emailed code, the way a parent does. */
export async function signIn(page: Page, email: string, next = "/") {
  await ownAddress(page);
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

/**
 * Automated accessibility checks (WCAG 2.2 AA rules in axe) on the current
 * page. Serious and critical problems fail the test; smaller ones are noted
 * on the test's report. Automated checks find only part of the problems:
 * keyboard and screen-reader passes are still done by hand.
 */
export async function checkA11y(page: Page, where: string) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  // Each element with what axe measured, such as the two colours and their contrast.
  const summary = (v: (typeof results.violations)[number]) =>
    `${v.id}: ${v.help} (${v.nodes
      .map(
        (n) =>
          `${n.target.join(" ")} ${n.html.slice(0, 100)}${n.any[0]?.message ? `: ${n.any[0].message}` : ""}`,
      )
      .join("; ")})`;
  for (const v of results.violations.filter(
    (v) => v.impact !== "serious" && v.impact !== "critical",
  )) {
    test
      .info()
      .annotations.push({ type: `a11y (${v.impact}) on ${where}`, description: summary(v) });
  }
  expect(
    results.violations
      .filter((v) => v.impact === "serious" || v.impact === "critical")
      .map(summary),
    `Accessibility problems on ${where}`,
  ).toEqual([]);
}
