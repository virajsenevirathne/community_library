import { expect, test } from "@playwright/test";
import { ADMIN, checkA11y } from "./helpers.ts";

test.use({ storageState: ADMIN });

test("staff share the sign-up link from the dashboard: download its QR code, print a poster", async ({
  page,
}) => {
  // The link is made once, on the Families page.
  await page.goto("/e2e-owls/admin/families");
  const card = page.getByRole("region", { name: "Sign-up link" });
  await expect(card.getByRole("heading")).toBeVisible();
  const create = card.getByRole("button", { name: "Create a sign-up link" });
  if (await create.isVisible()) await create.click();
  await expect(page.getByRole("textbox", { name: "Sign-up link" })).toBeVisible();

  await page.goto("/e2e-owls/admin");
  const invite = page.getByRole("region", { name: "Invite families" });
  await expect(invite.getByRole("button", { name: "Share the link" })).toBeVisible();
  await checkA11y(page, "the dashboard's Invite families");

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    invite.getByRole("button", { name: "Download QR code" }).click(),
  ]);
  expect(download.suggestedFilename()).toBe("e2e-owls-sign-up-qr.png");

  // Printing shows only the poster: the library's name and its QR code.
  await page.evaluate(() => {
    window.print = () => undefined;
  });
  await invite.getByRole("button", { name: "Print a poster" }).click();
  await page.emulateMedia({ media: "print" });
  await expect(page.locator(".poster-print")).toBeVisible();
  await expect(page.locator(".poster-print")).toContainText("E2E Owls");
  await expect(page.locator(".poster-print svg")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Library dashboard" })).toBeHidden();

  // Once printing is over, the page prints normally again.
  await page.evaluate(() => window.dispatchEvent(new Event("afterprint")));
  await expect(page.locator("body")).not.toHaveClass(/print-poster/, { timeout: 5000 });
  await expect(page.locator(".poster-print")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Invite families" })).toBeVisible();
});
