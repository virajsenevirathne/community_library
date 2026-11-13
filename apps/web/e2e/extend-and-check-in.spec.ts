import { expect, test } from "@playwright/test";
import { checkA11y, emailTo, linkIn, logLength, signIn } from "./helpers.ts";

// Changes the shared test data for good, so a retry would only fail on what
// the first attempt left behind: report the first failure instead.
test.describe.configure({ retries: 0 });

/*
 * In the E2E Wrens library (see seed.sql), staff check returns in, and the
 * Ryan family has "Diary of a Wombat" (BK6A) due back soon.
 */
test("a parent keeps a book longer from the reminder email, then staff check it in", async ({
  browser,
  request,
}) => {
  // The hourly job sends the "due back soon" email, with a "keep it longer" link.
  const since = logLength();
  const run = await request.get("/cdn-cgi/handler/scheduled");
  expect(run.ok()).toBe(true);
  const reminder = await emailTo("kai@e2e.test", since, /A library book is due back soon/);
  expect(reminder).toContain('Keep "Diary of a Wombat" longer:');
  const extendPath = linkIn(reminder, "/extend");

  // The link works without signing in; opening it changes nothing until the button.
  const phone = await (await browser.newContext()).newPage();
  await phone.goto(extendPath);
  await expect(phone.getByRole("heading", { name: "Keep the book longer?" })).toBeVisible();
  await expect(phone.getByText(/Keep Diary of a Wombat for another loan period\?/)).toBeVisible();
  await checkA11y(phone, "keep a book longer");
  await phone.getByRole("button", { name: "Keep it longer" }).click();
  await expect(phone.getByRole("heading", { name: "Kept longer" })).toBeVisible();
  await expect(phone.getByText(/Diary of a Wombat is now due back/)).toBeVisible();
  await checkA11y(phone, "a book kept longer");

  // The same link can't extend it twice.
  await phone.goto(extendPath);
  await expect(phone.getByRole("heading", { name: "This link can't be used" })).toBeVisible();
  await checkA11y(phone, "a used keep-it-longer link");

  // Kai returns it: with check-in on, it's handed back, not yet returned.
  await signIn(phone, "kai@e2e.test", "/c/BK6A");
  await phone.getByRole("button", { name: /^Return/ }).click();
  await expect(
    phone.getByText(
      "Handed back. Please put it in the returns basket. It stays on your list until staff check it in.",
    ),
  ).toBeVisible();
  await phone.goto("/e2e-wrens/");
  await expect(phone.getByText("Diary of a Wombat")).toBeVisible();

  // Staff check it in from the basket.
  const desk = await (await browser.newContext()).newPage();
  await signIn(desk, "wren-admin@e2e.test", "/e2e-wrens/admin/returns");
  await expect(desk.getByRole("heading", { name: "Check in returns" })).toBeVisible();
  await checkA11y(desk, "Check in returns");
  await desk.getByLabel("Scan or type a book code").fill("BK6A");
  await desk.getByRole("button", { name: "Check in", exact: true }).click();
  await expect(desk.getByRole("heading", { name: "1 checked in so far" })).toBeVisible();
  await expect(desk.getByText("From Ryan", { exact: false })).toBeVisible();
  await checkA11y(desk, "Check in returns, after a check-in");

  // Now it's off the family's list, which is empty again.
  await phone.goto("/e2e-wrens/");
  await expect(phone.getByText("Nothing borrowed yet")).toBeVisible();
  await expect(phone.getByText("Diary of a Wombat")).toHaveCount(0);
});
