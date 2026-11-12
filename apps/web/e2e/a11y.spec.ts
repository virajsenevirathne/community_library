import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { ADMIN, PARENT } from "./helpers.ts";

/*
 * Automated accessibility checks (WCAG 2.2 AA rules in axe) on the main
 * pages. Serious and critical problems fail the build. Automated checks
 * catch only part of the problems: keyboard and screen-reader passes are
 * still done by hand.
 */
async function check(page: Page, path: string, ready: string) {
  await page.goto(path);
  await expect(page.getByRole("heading", { name: ready }).first()).toBeVisible();
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  const serious = results.violations.filter(
    (v) => v.impact === "serious" || v.impact === "critical",
  );
  expect(
    serious.map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(" ")).join(", ")})`),
    `Accessibility problems on ${path}`,
  ).toEqual([]);
}

test.describe("light and dark", () => {
  for (const scheme of ["light", "dark"] as const) {
    test(`public pages (${scheme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await check(page, "/", "Borrow a book. Scan. Read together.");
      await check(page, "/privacy", "Privacy policy");
      await check(page, "/signin", "Sign in");
    });

    test(`a parent's pages (${scheme})`, async ({ browser }) => {
      const page = await (await browser.newContext({ storageState: PARENT })).newPage();
      await page.emulateMedia({ colorScheme: scheme });
      await check(page, "/e2e-owls/", "Your books");
      await check(page, "/e2e-owls/c/BK2A", "Owl Babies");
      await check(page, "/e2e-owls/account", "Your account");
    });

    test(`staff pages (${scheme})`, async ({ browser }) => {
      const page = await (await browser.newContext({ storageState: ADMIN })).newPage();
      await page.emulateMedia({ colorScheme: scheme });
      await check(page, "/e2e-owls/admin", "Dashboard");
      await check(page, "/e2e-owls/admin/loans", "Loans");
      await check(page, "/e2e-owls/admin/families", "Families");
      await check(page, "/e2e-owls/admin/catalog", "Catalog");
      await check(page, "/e2e-owls/admin/settings", "Settings");
    });
  }
});
