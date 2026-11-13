import { expect, test } from "@playwright/test";
import { checkA11y, OTHER_PARENT, PARENT } from "./helpers.ts";

test("a family joins the waiting list for a book another family has, then leaves it", async ({
  browser,
}) => {
  // The Lee family borrows the only copy.
  const lee = await browser.newContext({ storageState: PARENT });
  const leePage = await lee.newPage();
  await leePage.goto("/e2e-owls/c/BK4A");
  await leePage.getByRole("button", { name: "Borrow this book" }).click();
  await expect(leePage.getByRole("heading", { name: "Enjoy the book!" })).toBeVisible();

  // Another family finds it out, and joins the waiting list.
  const okafor = await browser.newContext({ storageState: OTHER_PARENT });
  const page = await okafor.newPage();
  await page.goto("/e2e-owls/c/BK4A");
  await expect(page.getByText("This book shows as borrowed by another family.")).toBeVisible();
  await page.getByRole("button", { name: "Join the waiting list" }).click();
  await expect(page.getByText(/You're on the waiting list/)).toBeVisible();
  await expect(page.getByText(/You're first in line/)).toBeVisible();
  await expect(page.getByText(/You're first in line/)).toBeFocused();
  await checkA11y(page, "the book page, on the waiting list");

  // Home lists it under "Waiting for".
  await page.goto("/e2e-owls/");
  await expect(page.getByRole("heading", { name: "Waiting for" })).toBeVisible();
  await expect(page.getByText("You're first in line")).toBeVisible();

  // The Lee family can't keep it longer while someone waits.
  await leePage.goto("/e2e-owls/c/BK4A");
  await expect(leePage.getByText(/Another family is waiting for this book/)).toBeVisible();
  await expect(leePage.getByRole("button", { name: "Keep it longer" })).toHaveCount(0);

  await page.getByRole("button", { name: /Leave/ }).click();
  await expect(page.getByRole("heading", { name: "Waiting for" })).toHaveCount(0);
  await expect(page.getByText("You've left the waiting list for")).toBeVisible();

  // The Lee family returns it, so the test can run again (in another browser).
  await leePage.goto("/e2e-owls/c/BK4A");
  await leePage.getByRole("button", { name: /^Return/ }).click();
  await expect(leePage.getByRole("heading", { name: "Thanks for bringing it back" })).toBeVisible();
  await lee.close();
  await okafor.close();
});
