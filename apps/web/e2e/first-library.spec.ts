import { expect, test } from "@playwright/test";
import { checkA11y, emailTo, linkIn, logLength, signIn } from "./helpers.ts";

// Changes the shared test data for good, so a retry would only fail on what
// the first attempt left behind: report the first failure instead.
test.describe.configure({ retries: 0 });

/*
 * A new library, from the site owner creating it to its first admin on the
 * dashboard. (Becoming the site's owner with the setup code is covered by the
 * unit tests: this site's owner already exists in the test data.)
 */
test("the owner creates a library, and its first admin sets it up", async ({ browser }) => {
  // The owner creates the library and invites its admin.
  const owner = await (await browser.newContext()).newPage();
  await signIn(owner, "owner@e2e.test", "/owner");
  await owner.getByLabel("Library name").fill("Wombat Reads");
  await expect(owner.getByText("The library will be at /wombat-reads.")).toBeVisible();
  await owner.getByLabel("Email of its first admin").fill("wombat-admin@e2e.test");
  const since = logLength();
  await owner.getByRole("button", { name: "Create and send the invite" }).click();
  await expect(
    owner.getByText(
      "Created Wombat Reads. We've emailed wombat-admin@e2e.test the steps to set it up.",
    ),
  ).toBeVisible();
  await expect(owner.getByRole("heading", { name: "Wombat Reads" })).toBeVisible();
  await checkA11y(owner, "the owner's page");

  // The admin, new to the site, opens the invite on their own device.
  const invite = await emailTo("wombat-admin@e2e.test", since, /You're invited to Wombat Reads/);
  expect(invite).toContain("Wombat Reads is new.");
  const admin = await (await browser.newContext()).newPage();
  await admin.goto(linkIn(invite, "/invite/"));
  await expect(admin.getByRole("heading", { name: "Join Wombat Reads" })).toBeVisible();
  await expect(
    admin.getByText("You're invited to help run the library as an admin."),
  ).toBeVisible();
  await checkA11y(admin, "an invitation");

  // Continue signs them in, then brings them back to the invitation.
  await admin.getByRole("button", { name: "Continue" }).click();
  await expect(admin.getByLabel("Email")).toHaveValue("wombat-admin@e2e.test");
  await signIn(
    admin,
    "wombat-admin@e2e.test",
    new URL(admin.url()).searchParams.get("next") ?? "/",
  );
  await expect(admin.getByRole("heading", { name: "Join Wombat Reads" })).toBeVisible();
  await admin.getByLabel("Your first name").fill("Wren");
  await admin.getByRole("button", { name: "Accept the invitation" }).click();

  // Two choices, then the dashboard.
  await expect(admin.getByRole("heading", { name: "Welcome to Wombat Reads" })).toBeVisible();
  await checkA11y(admin, "the new library's welcome page");
  await admin.getByRole("button", { name: "Finish setting up" }).click();
  await expect(admin.getByText("Choose how returns work.")).toBeVisible();
  await admin.getByLabel(/Staff check it in from the returns basket/).check();
  await admin.getByRole("button", { name: "Finish setting up" }).click();
  await expect(
    admin.getByText("Please accept the terms and privacy policy to continue."),
  ).toBeVisible();
  await admin.getByLabel(/I accept the terms/).check();
  await admin.getByRole("button", { name: "Finish setting up" }).click();
  await expect(admin).toHaveURL(/\/wombat-reads\/admin$/);
  await expect(admin.getByRole("heading", { name: "Library dashboard" })).toBeVisible();
  await checkA11y(admin, "a new library's dashboard");

  // The choice stuck.
  await admin.goto("/wombat-reads/admin/settings");
  await expect(admin.getByLabel("Staff check returned books in")).toBeChecked();
});
