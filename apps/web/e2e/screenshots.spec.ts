import { resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { ADMIN, PARENT, signIn } from "./helpers.ts";

/*
 * Screenshots for docs/setup.md, taken from the test site. Skipped in normal
 * runs; make them with: npm run docs-screenshots -w @community-library/web
 */
test.skip(!process.env.DOCS_SCREENSHOTS, "Only when making the docs' screenshots");

const out = (name: string) => resolve(import.meta.dirname, "../../../docs/images", `${name}.png`);
const shot = async (page: Page, name: string) => {
  await page.waitForTimeout(300);
  await page.screenshot({ path: out(name) });
};

test.use({ viewport: { width: 1100, height: 760 }, colorScheme: "light" });

test("the owner's page", async ({ page }) => {
  await signIn(page, "owner@e2e.test", "/owner");
  await expect(page.getByRole("heading", { name: "Site checklist" })).toBeVisible();
  await shot(page, "owner-checklist");
});

test.describe("a library admin", () => {
  test.use({ storageState: ADMIN });
  test("dashboard and settings", async ({ page }) => {
    await page.goto("/e2e-owls/admin");
    await expect(page.getByRole("heading", { name: "Library dashboard" })).toBeVisible();
    await shot(page, "dashboard");
    await page.goto("/e2e-owls/admin/settings");
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
    await shot(page, "settings");
  });
});

test.describe("a parent on a phone", () => {
  test.use({ storageState: PARENT, viewport: { width: 390, height: 780 } });
  test("a book's page", async ({ page }) => {
    await page.goto("/e2e-owls/c/BK3A");
    await expect(page.getByRole("button", { name: "Borrow this book" })).toBeVisible();
    await shot(page, "phone-book");
  });
});
