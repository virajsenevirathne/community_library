import { readFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { checkA11y, signIn } from "./helpers.ts";

// Changes the shared test data for good, so a retry would only fail on what
// the first attempt left behind: report the first failure instead.
test.describe.configure({ retries: 0 });

/*
 * Settings › Your library's data, Logo, and Connect your own system. In the E2E
 * Wrens library (see seed.sql), so its webhook never fires for other tests.
 * Runs before extend-and-check-in.spec.ts (files run in name order), which
 * returns the Ryan family's book: the loans file expects it still out.
 */

/** Presses a download button and returns the file's name and text. */
async function download(page: Page, button: string) {
  const [file] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: button }).click(),
  ]);
  const path = await file.path();
  return { name: file.suggestedFilename(), text: readFileSync(path, "utf8") };
}

test("an admin downloads the library's data, adds a logo, and sets up a webhook", async ({
  page,
}) => {
  await signIn(page, "wren-admin@e2e.test", "/e2e-wrens/admin/settings");
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await checkA11y(page, "a library's settings");

  // Spreadsheet files of the catalog, families and loans.
  const catalog = await download(page, "Download catalog");
  expect(catalog.name).toMatch(/^e2e-wrens-catalog-.*\.csv$/);
  // Every field is quoted, after a byte-order mark so Excel reads accents right.
  expect(catalog.text).toMatch(/^\uFEFF"Title","Authors","ISBN","Copy code"/);
  expect(catalog.text).toContain("Diary of a Wombat");
  expect(catalog.text).toContain("BK6A");
  // Only this library's data: none from E2E Owls on the same site.
  expect(catalog.text).not.toContain("Owl Babies");
  await expect(page.getByText("Your catalog file is ready.", { exact: false })).toBeVisible();

  const families = await download(page, "Download families");
  expect(families.text).toContain("Ryan");
  expect(families.text).toContain("kai@e2e.test");
  expect(families.text).not.toContain("parent@e2e.test");

  const loans = await download(page, "Download loans");
  expect(loans.text).toContain('"Book","Copy code","Family"');
  expect(loans.text).toContain('"Diary of a Wombat","BK6A","Ryan"');

  // A logo: chosen, previewed, saved; it then shows in the header for this library.
  const logo = page.getByRole("region", { name: "Logo" });
  const header = page.locator(".site-header .brand__logo");
  await expect(header).toHaveCount(0);
  const svg = (fill: string) => ({
    name: "wrens.svg",
    mimeType: "image/svg+xml",
    buffer: Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="${fill}"/><circle cx="10" cy="10" r="7" fill="#fff"/></svg>`,
    ),
  });
  // Chosen, then cancelled: nothing changes.
  await logo.getByLabel("Choose a picture").setInputFiles(svg("#2e86c1"));
  await expect(logo.getByText("Picture ready.", { exact: false })).toBeVisible();
  await logo.getByRole("button", { name: "Cancel" }).click();
  await expect(logo.getByLabel("Choose a picture")).toBeFocused();
  await expect(header).toHaveCount(0);

  // Chosen, previewed on light and dark, and saved.
  await logo.getByLabel("Choose a picture").setInputFiles(svg("#c0392b"));
  await expect(
    logo.getByRole("img", { name: "Your new logo, not saved yet, on a light screen" }),
  ).toBeVisible();
  await expect(logo.getByRole("img", { name: "The same, on a dark screen" })).toBeVisible();
  await expect(logo.getByRole("button", { name: "Save this logo" })).toBeFocused();
  await checkA11y(page, "a logo chosen, before saving");
  await logo.getByRole("button", { name: "Save this logo" }).click();
  await expect(logo.getByText("Logo saved.", { exact: false })).toBeVisible();
  await expect(header).toHaveAttribute("src", /^\/api\/logo\/e2e-wrens\?v=\d+$/);
  // It loaded: a drawing as small as 40×20 is drawn at full size, 256 pixels wide.
  await expect.poll(() => header.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(256);
  await page.reload();
  await expect(header).toBeVisible();

  // Removing asks first.
  await logo.getByRole("button", { name: "Remove the logo" }).click();
  await expect(
    logo.getByText("Remove the logo? The joey comes back", { exact: false }),
  ).toBeFocused();
  await checkA11y(page, "removing the logo, confirm");
  await logo.getByRole("button", { name: "Keep it" }).click();
  await expect(logo.getByRole("button", { name: "Remove the logo" })).toBeFocused();
  await logo.getByRole("button", { name: "Remove the logo" }).click();
  await logo.getByRole("button", { name: "Remove it" }).click();
  await expect(logo.getByText("Logo removed:", { exact: false })).toBeVisible();
  await expect(header).toHaveCount(0);
  await expect(page.locator(".site-header .brand__mark")).toBeVisible();

  // A webhook: the secret is shown once, a test is sent, then it's removed.
  // (The settings page has its own Save button, so look only in this section.)
  const hooks = page.getByRole("region", { name: "Connect your own system" });
  await hooks.getByRole("button", { name: "Set up a connection" }).click();
  await hooks.getByLabel("Address to send to").fill("http://example.org/hook");
  await hooks.getByRole("button", { name: "Save" }).click();
  await expect(
    hooks.getByText("Use an https address on the internet", { exact: false }),
  ).toBeVisible();
  await hooks.getByLabel("Address to send to").fill("https://example.org/reading-joey-e2e");
  await hooks.getByRole("button", { name: "Save" }).click();
  await expect(
    hooks.getByText("Copy the secret code into your system now", { exact: false }),
  ).toBeVisible();
  const secret = hooks.getByLabel("Secret code");
  await expect(secret).toBeFocused();
  const first = await secret.inputValue();
  expect(first.length).toBeGreaterThan(20);
  await checkA11y(page, "webhook settings, with a new secret");

  // The test goes to the internet, so any of its three answers will do.
  await hooks.getByRole("button", { name: "Send a test" }).click();
  await expect(
    hooks.getByText(
      /Test sent\. Your system replied that all is well\.|Test sent, but your system didn't reply|We couldn't reach that address\./,
    ),
  ).toBeVisible({ timeout: 20_000 });
  await hooks.getByText("Latest messages").click();
  await expect(hooks.getByText(/Test message ·/)).toBeVisible();

  // A new secret replaces the old one.
  await hooks.getByRole("button", { name: "New secret code" }).click();
  await hooks.getByRole("button", { name: "Make a new code" }).click();
  await expect(hooks.getByLabel("Secret code")).not.toHaveValue(first);

  await hooks.getByRole("button", { name: "Stop sending" }).click();
  await hooks.getByRole("button", { name: "Stop sending" }).click();
  await expect(hooks.getByText("Removed. Nothing more will be sent.")).toBeVisible();
  await expect(hooks.getByRole("button", { name: "Set up a connection" })).toBeFocused();
});
