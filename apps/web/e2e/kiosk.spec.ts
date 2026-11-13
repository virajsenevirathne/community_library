import { expect, test } from "@playwright/test";
import { checkA11y, PARENT, signIn } from "./helpers.ts";

// Adds a family for good, so a retry would fail on the first attempt's family.
test.describe.configure({ retries: 0 });

test("a kiosk tablet: scan a book with the camera and borrow it with a code", async ({
  page,
  browser,
}) => {
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
  await page.getByRole("button", { name: "Add the family and give a PIN" }).click();
  const shown = page.locator(".kiosk-code__digits");
  await expect(shown).toBeVisible();
  const code = ((await shown.textContent()) ?? "").replace(/\D/g, "");
  expect(code).toHaveLength(6);
  await checkA11y(page, "a new family's kiosk PIN");

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
  await expect(page.getByRole("heading", { name: "Type your PIN" })).toBeVisible();
  await checkA11y(page, "the kiosk keypad");

  // A wrong code first, then the right one on the keypad.
  for (const digit of "000000" === code ? "111111" : "000000") {
    await page.getByRole("button", { name: digit, exact: true }).click();
  }
  await expect(page.getByText("That PIN didn't work.")).toBeVisible();
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

  // A parent chooses their own PIN on their Account page, then borrows with it.
  const parent = await browser.newContext({ storageState: PARENT });
  const phone = await parent.newPage();
  await phone.goto("/e2e-owls/account");
  const pin = phone.getByRole("region", { name: "Kiosk PIN" });
  await pin.getByLabel("Your PIN", { exact: true }).fill("123456");
  await pin.getByLabel("Type your PIN again").fill("123456");
  await pin.getByRole("button", { name: "Save my PIN" }).click();
  await expect(pin.getByText(/can't be used here/)).toBeVisible();
  await pin.getByLabel("Your PIN", { exact: true }).fill("583920");
  await pin.getByLabel("Type your PIN again").fill("583920");
  await pin.getByRole("button", { name: "Save my PIN" }).click();
  await expect(pin.getByText("Your PIN is saved.", { exact: false })).toBeVisible();
  await expect(pin.getByRole("button", { name: "Change my PIN" })).toBeVisible();
  await checkA11y(phone, "the Account page's kiosk PIN");
  await parent.close();

  await page.getByRole("button", { name: "Done" }).click();
  await page.getByLabel("Or type the code under the sticker").fill("BK3A");
  await page.getByRole("button", { name: "Find the book" }).click();
  await page.getByRole("button", { name: "Borrow this book" }).click();
  for (const digit of "583920")
    await page.getByRole("button", { name: digit, exact: true }).click();
  await expect(page.getByRole("heading", { name: "Enjoy the book!" })).toBeVisible();
  await page.getByRole("button", { name: "Done" }).click();
  await page.getByLabel("Or type the code under the sticker").fill("BK3A");
  await page.getByRole("button", { name: "Find the book" }).click();
  await page.getByRole("button", { name: "Return this book" }).click();
  await expect(page.getByRole("heading", { name: "Thanks for bringing it back!" })).toBeVisible();
});
