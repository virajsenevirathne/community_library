import { expect, type Page, test } from "@playwright/test";
import { ADMIN, checkA11y, PARENT } from "./helpers.ts";

/* The main pages, in light and dark. The kiosk is checked in kiosk.spec.ts. */
async function check(page: Page, path: string, ready: string) {
  await page.goto(path);
  await expect(page.getByRole("heading", { name: ready }).first()).toBeVisible();
  await checkA11y(page, path);
}

for (const scheme of ["light", "dark"] as const) {
  test.describe(`${scheme} mode`, () => {
    test.use({ colorScheme: scheme });

    test("public pages", async ({ page }) => {
      await check(page, "/", "Borrow a book. Scan. Read together.");
      await check(page, "/privacy", "Privacy policy");
      await check(page, "/terms", "Terms of use");
      await check(page, "/signin", "Sign in");
    });

    test.describe("a parent's pages", () => {
      test.use({ storageState: PARENT });
      test("home, a book, account", async ({ page }) => {
        await check(page, "/e2e-owls/", "Your books");
        await check(page, "/e2e-owls/c/BK2A", "Owl Babies");
        await check(page, "/e2e-owls/account", "Your account");
        await expect(page.getByRole("heading", { name: "Due-date reminders" })).toBeVisible();
      });
    });

    test.describe("staff pages", () => {
      test.use({ storageState: ADMIN });
      test("dashboard, loans, families, books, settings", async ({ page }) => {
        await check(page, "/e2e-owls/admin", "Dashboard");
        await check(page, "/e2e-owls/admin/loans", "Loans");
        await check(page, "/e2e-owls/admin/returns", "Check in");
        await check(page, "/e2e-owls/admin/families", "Families");
        await check(page, "/e2e-owls/admin/catalog", "Catalog");
        await check(page, "/e2e-owls/admin/add", "Add books");
        await check(page, "/e2e-owls/admin/labels", "labels");
        await check(page, "/e2e-owls/admin/settings", "Settings");
      });
    });
  });
}
