import { expect, test } from "@playwright/test";
import { PARENT } from "./helpers.ts";

test.use({ storageState: PARENT });

test("a parent borrows a book by its sticker, then returns it", async ({ page }) => {
  // Scanning the sticker opens the book's address.
  await page.goto("/c/BK2A");
  await expect(page).toHaveURL(/\/e2e-owls\/c\/BK2A/);
  await expect(page.getByRole("heading", { name: "Owl Babies" })).toBeVisible();
  await page.getByRole("button", { name: "Borrow this book" }).click();
  await expect(page.getByRole("heading", { name: "Enjoy the book!" })).toBeVisible();
  await expect(page.getByText(/Due back/)).toBeVisible();

  await page.goto("/e2e-owls/");
  await expect(page.getByText("Owl Babies")).toBeVisible();

  await page.goto("/c/BK2A");
  await page.getByRole("button", { name: /^Return/ }).click();
  await expect(page.getByRole("heading", { name: "Thanks for bringing it back" })).toBeVisible();
});

test("a parent scans a book's sticker from inside the app", async ({ page }, testInfo) => {
  // Only Chrome here has a fake camera, which shows the sticker of "The Gruffalo".
  test.skip(testInfo.project.name !== "chrome", "needs the fake camera");
  await page.goto("/e2e-owls/");
  await page.getByRole("link", { name: "Scan a book" }).click();
  await expect(page.getByRole("heading", { name: "Scan a book" })).toBeVisible();
  await expect(page).toHaveURL(/\/e2e-owls\/c\/BK3A$/, { timeout: 20_000 });
  await expect(page.getByRole("heading", { name: "The Gruffalo" })).toBeVisible();
});

test("without a working camera, a parent types the book's code instead", async ({
  page,
}, testInfo) => {
  // Chrome's fake camera would scan before anything could be typed.
  test.skip(testInfo.project.name === "chrome", "has a camera");
  await page.goto("/e2e-owls/c");
  await expect(page.getByRole("heading", { name: "Scan a book" })).toBeVisible();
  if (testInfo.project.name === "safari") {
    // Safari here has no camera: the page says so, and points at typing.
    await expect(page.getByRole("alert")).toContainText("type the code");
  }
  await page.getByLabel("Book code").fill("bk2a");
  await page.getByRole("button", { name: "Find the book" }).click();
  await expect(page).toHaveURL(/\/e2e-owls\/c\/BK2A$/);
  await expect(page.getByRole("heading", { name: "Owl Babies" })).toBeVisible();
});
