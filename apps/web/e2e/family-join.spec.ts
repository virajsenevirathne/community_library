import { expect, test } from "@playwright/test";
import { ADMIN, checkA11y, emailTo, linkIn, logLength, signIn } from "./helpers.ts";

// Changes the shared test data for good, so a retry would only fail on what
// the first attempt left behind: report the first failure instead.
test.describe.configure({ retries: 0 });

test("a family joins with the sign-up link, borrows, and adds a second parent", async ({
  browser,
}) => {
  // Staff make the library's sign-up link.
  const staff = await (await browser.newContext({ storageState: ADMIN })).newPage();
  await staff.goto("/e2e-owls/admin/families");
  await staff.getByRole("button", { name: "Create a sign-up link" }).click();
  const link = staff.getByRole("textbox", { name: "Sign-up link" });
  await expect(link).toHaveValue(/\/join\//);
  const joinPath = new URL(await link.inputValue()).pathname;
  await checkA11y(staff, "Families, with the sign-up link");

  // A parent opens it on their phone and signs in.
  const mia = await (await browser.newContext()).newPage();
  await mia.goto(joinPath);
  await expect(mia.getByRole("heading", { name: "Join E2E Owls" })).toBeVisible();
  await checkA11y(mia, "the sign-up page");
  await mia.getByRole("button", { name: "Continue with my email" }).click();
  await expect(mia).toHaveURL(/\/signin/);
  await signIn(mia, "mia@e2e.test", joinPath);

  // Step 2: their names. Both are needed.
  await expect(mia.getByText("Step 2 of 2:", { exact: false })).toBeVisible();
  await mia.getByRole("button", { name: "Join the library" }).click();
  await expect(mia.getByText("Type your first name.")).toBeVisible();
  await expect(mia.getByText("Type your family name, for example your surname.")).toBeVisible();
  await checkA11y(mia, "the sign-up form with its errors");
  await mia.getByLabel("Your first name").fill("Mia");
  await mia.getByLabel("Family name").fill("Nguyen");
  await mia.getByRole("button", { name: "Join the library" }).click();
  await expect(mia.getByText("Welcome to E2E Owls! You can borrow straight away.")).toBeVisible();

  // They can borrow at once.
  await mia.goto("/c/BK5A");
  await mia.getByRole("button", { name: "Borrow this book" }).click();
  await expect(mia.getByRole("heading", { name: "Enjoy the book!" })).toBeVisible();

  // They invite their partner from Account.
  await mia.goto("/e2e-owls/account");
  await mia.getByLabel("Add another adult to your family").fill("tom@e2e.test");
  const since = logLength();
  await mia.getByRole("button", { name: "Send invitation" }).click();
  await expect(mia.getByText("Invitation sent to tom@e2e.test.", { exact: false })).toBeVisible();
  await expect(mia.getByText("tom@e2e.test · invited")).toBeVisible();
  await checkA11y(mia, "Account, with an invitation sent");

  // The partner accepts from the email, and shares the family's books.
  const invite = await emailTo("tom@e2e.test", since, /You're invited to E2E Owls/);
  const tom = await (await browser.newContext()).newPage();
  await tom.goto(linkIn(invite, "/invite/"));
  await expect(tom.getByText("You're invited to borrow books as the Nguyen family.")).toBeVisible();
  await tom.getByRole("button", { name: "Continue" }).click();
  await signIn(tom, "tom@e2e.test", new URL(tom.url()).searchParams.get("next") ?? "/");
  await tom.getByLabel("Your first name").fill("Tom");
  await tom.getByRole("button", { name: "Accept the invitation" }).click();
  await expect(tom).toHaveURL(/\/e2e-owls\/\?joined=1/);
  await expect(tom.getByText("Possum Magic")).toBeVisible();

  // Both adults are in the family; the invitation is gone.
  await mia.reload();
  await expect(mia.getByText("tom@e2e.test · invited")).toHaveCount(0);
  await expect(mia.getByText(/Tom\s*· tom@e2e\.test/)).toBeVisible();

  // Return the book, for the tests after this one.
  await tom.goto("/c/BK5A");
  await tom.getByRole("button", { name: /^Return/ }).click();
  await expect(tom.getByRole("heading", { name: "Thanks for bringing it back" })).toBeVisible();
});
