import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { checkA11y, codeFor, ownAddress, SERVER_LOG_PATH } from "./helpers.ts";

test("signing in by code offers a passkey, then opens the page asked for", async ({
  page,
}, testInfo) => {
  // Someone of the Lee family, with their own address per browser (codes are rate limited).
  const email = `signin-${testInfo.project.name}@e2e.test`;
  await ownAddress(page);
  const since = readFileSync(SERVER_LOG_PATH, "utf8").length;
  await page.goto(`/signin?next=${encodeURIComponent("/e2e-owls/account")}`);
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Email me a code" }).click();
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
  await checkA11y(page, "the code step");
  await page.getByLabel("6-digit code").fill(await codeFor(email, since));

  // The offer stays on screen, and its heading takes focus so it is read out.
  await expect(page.getByRole("heading", { name: "Save a passkey?" })).toBeFocused();
  await checkA11y(page, "the passkey offer");
  await page.getByRole("button", { name: "Not now" }).click();
  await expect(page).toHaveURL(/\/e2e-owls\/account$/);
  await expect(page.getByRole("heading", { name: "Your account" })).toBeVisible();
});

test("on the front page, the passkey offer is read out too", async ({ page }, testInfo) => {
  // Someone of the Lee family, with their own address per browser (codes are rate limited).
  const email = `signin-${testInfo.project.name}@e2e.test`;
  await ownAddress(page);
  const since = readFileSync(SERVER_LOG_PATH, "utf8").length;
  await page.goto("/");
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Email me a code" }).click();
  await page.getByLabel("6-digit code").fill(await codeFor(email, since));
  await expect(page.getByText("You're signed in. Next time, skip the email code?")).toBeFocused();
  await page.getByRole("button", { name: "Not now" }).click();
  // Someone in one library goes straight into it.
  await expect(page).toHaveURL(/\/e2e-owls\/?$/);
});
