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
