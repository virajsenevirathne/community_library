import { expect, type Page, test } from "@playwright/test";
import { ADMIN, checkA11y } from "./helpers.ts";

// Changes the shared test data for good, so a retry would only fail on what
// the first attempt left behind: report the first failure instead.
test.describe.configure({ retries: 0 });

/*
 * Staff add books and print their stickers. Runs in the "chrome-barcode"
 * project, whose fake camera shows the barcode of ISBN 9780000000002. The
 * online lookup may find something for these ISBNs, find nothing, or be out
 * of reach: either way staff can check and fix the details, which the test
 * then types over.
 */
test.use({ storageState: ADMIN });

/** After the lookup, whatever it found, type the details and save. */
async function addDetails(page: Page, isbn: string, title: string, copies: string) {
  await expect(page.getByRole("heading", { name: "Check the details" })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByText(`ISBN ${isbn}`, { exact: true })).toBeVisible();
  await page.getByLabel("Title").fill(title);
  await page.getByLabel("Author (optional)").fill("E. Tester");
  await page.getByLabel("How many copies?").fill(copies);
  await checkA11y(page, "a new book's details");
  await page.getByRole("button", { name: "Add to the catalog" }).click();
}

test("staff add a book by barcode and one by typing its ISBN, then print the labels", async ({
  page,
}) => {
  // window.print would open the browser's print dialog.
  await page.addInitScript(() => {
    window.print = () => {};
  });

  // Typed: an ISBN with a mistake first, then the right one.
  await page.goto("/e2e-owls/admin/add");
  await expect(page.getByRole("heading", { name: "Add books" })).toBeVisible();
  await checkA11y(page, "Add books");
  await page.getByLabel("Scan or type the ISBN").fill("9780000000010");
  await page.getByRole("button", { name: "Look it up" }).click();
  await expect(page.getByText("That does not look like an ISBN.", { exact: false })).toBeVisible();
  await page.getByLabel("Scan or type the ISBN").fill("978-0-00-000001-9");
  await page.getByRole("button", { name: "Look it up" }).click();
  await addDetails(page, "9780000000019", "The Typed Book", "1");
  await expect(page.getByText(/Added The Typed Book\. New copy code:/)).toBeVisible();

  // Scanned with the camera, two copies.
  await page.getByRole("button", { name: "Add another book" }).click();
  await page.getByRole("button", { name: "Use the camera" }).click();
  await addDetails(page, "9780000000002", "The Scanned Book", "2");
  const saved = page.getByText(/Added The Scanned Book\. New copy codes:/);
  await expect(saved).toBeVisible();
  const codes = await saved.locator("strong.code").allTextContents();
  expect(codes).toHaveLength(2);

  // Their labels.
  await page.getByRole("button", { name: "Print their labels" }).click();
  await expect(page.getByRole("heading", { name: "Print labels" })).toBeVisible();
  await expect(page.getByText("2 labels on 1 sheet.")).toBeVisible();
  for (const code of codes) await expect(page.locator(".label", { hasText: code })).toHaveCount(1);
  await checkA11y(page, "Print labels");
  await page.getByRole("button", { name: "Print", exact: true }).click();
  await page.getByRole("button", { name: "Yes, mark them as printed" }).click();
  await expect(page.getByText("Marked as printed.", { exact: false })).toBeVisible();

  // The typed book still needs its label; the scanned ones don't.
  await page.goto("/e2e-owls/admin/labels");
  await expect(page.getByText("1 label on 1 sheet.", { exact: false })).toBeVisible();
  await expect(page.locator(".label", { hasText: "The Typed Book" })).toHaveCount(1);
  await expect(page.locator(".label", { hasText: "The Scanned Book" })).toHaveCount(0);
});
