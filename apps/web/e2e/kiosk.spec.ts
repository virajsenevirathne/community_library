import { expect, test } from "@playwright/test";
import { checkA11y, signIn } from "./helpers.ts";

test("a kiosk tablet: scan a book with the camera and borrow it with a code", async ({ page }) => {
  // An admin turns this browser into a kiosk; it signs them out. (Their own
  // sign-in, not the saved one other tests share, which this would end.)
  await signIn(page, "kiosk-admin@e2e.test", "/e2e-owls/admin/settings");
  await page.getByRole("button", { name: "Use this tablet as a kiosk" }).click();
  await expect(page).toHaveURL(/\/e2e-owls\/kiosk$/);
  await expect(page.getByRole("link", { name: "Staff" })).toBeVisible();

  // Staff sign back in to add a family without email; its code is shown once.
  await signIn(page, "kiosk-admin@e2e.test", "/e2e-owls/admin/families");
  await page.getByRole("button", { name: "Add a family without email" }).click();
  await page.getByLabel("Family name").fill("Silva");
  await page.getByLabel("First name of an adult").fill("Nana");
  await page.getByRole("button", { name: "Add the family and make a code" }).click();
  const shown = page.locator(".kiosk-code__digits");
  await expect(shown).toBeVisible();
  const code = ((await shown.textContent()) ?? "").replace(/\D/g, "");
  expect(code).toHaveLength(6);

  // Back to the kiosk, which warns that staff are still signed in.
  await page.goto("/e2e-owls/kiosk");
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("link", { name: "Staff" })).toBeVisible();
  await checkA11y(page, "the kiosk's start screen");

  // The fake camera shows the sticker of "The Gruffalo".
  await expect(page.getByRole("heading", { name: "Borrow this book?" })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByText("The Gruffalo")).toBeVisible();
  await checkA11y(page, "the kiosk's book screen");
  await page.getByRole("button", { name: "Borrow this book" }).click();
  await expect(page.getByRole("heading", { name: "Type your kiosk code" })).toBeVisible();
  await checkA11y(page, "the kiosk keypad");

  // A wrong code first, then the right one on the keypad.
  for (const digit of "000000" === code ? "111111" : "000000") {
    await page.getByRole("button", { name: digit, exact: true }).click();
  }
  await expect(page.getByText("That code didn't work.")).toBeVisible();
  for (const digit of code) await page.getByRole("button", { name: digit, exact: true }).click();
  await expect(page.getByRole("heading", { name: "Enjoy the book!" })).toBeVisible();
  await expect(page.getByText(/Borrowed by Nana/)).toBeVisible();
  await checkA11y(page, "the kiosk's confirmation");

  // Returning needs no code.
  await page.getByRole("button", { name: "Done" }).click();
  await page.getByRole("button", { name: "Turn the camera off" }).click();
  await page.getByLabel("Or type the code under the sticker").fill("BK3A");
  await page.getByRole("button", { name: "Find the book" }).click();
  await page.getByRole("button", { name: "Return this book" }).click();
  await expect(page.getByRole("heading", { name: "Thanks for bringing it back!" })).toBeVisible();
});
