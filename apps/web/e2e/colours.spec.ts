import { expect, test } from "@playwright/test";
import { ADMIN, checkA11y } from "./helpers.ts";

test.use({ storageState: ADMIN });

// Every library colour stays readable, in light and dark. (Runs before the
// kiosk test, which signs this admin out.)
test("each library colour passes the accessibility checks", async ({ page }) => {
  for (const theme of ["blue", "purple", "teal", "coral", "gold", "green"]) {
    const res = await page.request.patch("/api/admin/settings", {
      headers: { "X-Library": "e2e-owls" },
      data: { theme },
    });
    expect(res.ok(), `saving ${theme}`).toBe(true);
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto("/e2e-owls/admin/settings");
      await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
      if (theme !== "green")
        await expect(page.locator("html")).toHaveAttribute("data-accent", theme);
      await checkA11y(page, `settings in ${theme}, ${scheme}`);
    }
  }
});
