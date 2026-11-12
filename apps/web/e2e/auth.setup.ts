import { test as setup } from "@playwright/test";
import { ADMIN, PARENT, signIn } from "./helpers.ts";

/*
 * Signs each test person in once and saves the session, so the tests don't
 * each ask for a code (sign-in codes are rate limited per network).
 */

setup("sign in the parent", async ({ page }) => {
  await signIn(page, "parent@e2e.test");
  await page.context().storageState({ path: PARENT });
});

setup("sign in the admin", async ({ page }) => {
  await signIn(page, "admin@e2e.test", "/e2e-owls/admin");
  await page.context().storageState({ path: ADMIN });
});
