import type { Page } from "@playwright/test";

import { SEEDED } from "../scripts/seed-trials.ts";
import { expect, rowOf, test, viewLink } from "./fixtures.ts";

/** The list is back at this URL, with no Trial open over it. */
async function expectList(page: Page, url: string) {
  await expect(page).toHaveURL(url);
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page.locator(viewLink(SEEDED.original))).toBeVisible();
}

test("closing a Trial opened from the list returns to the same filters", async ({ page }) => {
  await page.goto("/trials?mode=exact");
  await page.locator(viewLink(SEEDED.original)).click();
  await expect(page).toHaveURL(`/trials/${SEEDED.original}?mode=exact`);
  await expect(page.getByRole("dialog")).toContainText("CVS Pharmacy");

  await page.getByRole("button", { name: "Close" }).click();
  await expectList(page, "/trials?mode=exact");
});

test("browser back closes the Trial", async ({ page }) => {
  await page.goto("/trials");
  await page.locator(viewLink(SEEDED.original)).click();
  await expect(page.getByRole("dialog")).toBeVisible();

  await page.goBack();
  await expectList(page, "/trials");
});

test("closing a shared link replaces it with the list", async ({ page }) => {
  await page.goto(`/trials/${SEEDED.original}?mode=exact`);
  await expect(page.getByRole("dialog")).toContainText("CVS Pharmacy");
  const historyLength = await page.evaluate(() => history.length);

  await page.getByRole("button", { name: "Close" }).click();
  await expectList(page, "/trials?mode=exact");
  expect(await page.evaluate(() => history.length)).toBe(historyLength);
});

test("a run opened from the retry history closes back to the list", async ({ page }) => {
  await page.goto("/trials");
  await page.locator(viewLink(SEEDED.original)).click();
  await page
    .getByRole("region", { name: "Retry runs" })
    .locator(`a[href^="/trials/${SEEDED.freshRetry}"]`)
    .click();
  await expect(page).toHaveURL(`/trials/${SEEDED.freshRetry}`);

  await page.getByRole("button", { name: "Close" }).click();
  await expectList(page, "/trials");
});

test("a Trial reviewed before outcome scoring counts by its status", async ({ page }) => {
  await page.goto("/trials?q=Duane");
  await expect(
    rowOf(page, SEEDED.reviewedBeforeOutcomes).getByRole("combobox", { name: "Outcome" }),
  ).toHaveValue("got_there");
});

test("a Trial saved in an older shape still shows", async ({ page }) => {
  await page.goto("/trials?q=Best Buy Express");
  await page.locator(viewLink(SEEDED.olderShape)).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Best Buy Express");
  await expect(dialog.getByRole("alert")).toBeHidden();
});

test("a Trial's saved Street View images show, with their headings and downloads", async ({
  page,
}) => {
  await page.goto(`/trials/${SEEDED.original}`);
  const dialog = page.getByRole("dialog");
  for (const [title, file] of [
    ["Saved panorama", "panoramaPhoto.jpg"],
    ["Destination Street View reference", "destinationPhoto.jpg"],
  ]) {
    await expect(dialog.getByRole("img", { name: title })).toHaveAttribute("src", /^data:image\//);
    await expect(dialog.locator(`a[download="${file}"]`)).toHaveAttribute("href", /^data:image\//);
  }
  await expect(dialog).toContainText("Tile center headings (in stored order): 0°, 22.5°, 90°");
});

test("a Trial with no saved panorama says why", async ({ page }) => {
  await page.goto("/trials?q=Macy");
  await page
    .getByRole("row")
    .filter({ hasText: "151 W 34th St" })
    .locator('a:text-is("View")')
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText(
    "No usable outdoor panorama was obtained (no_validated_outdoor_panorama).",
  );
  await expect(dialog).toContainText("No separate destination reference saved.");
  await expect(dialog.getByRole("img", { name: "Saved panorama" })).toHaveCount(0);
});

test("a Trial that doesn't exist says so", async ({ page }) => {
  await page.goto("/trials/000000000000000000000000");
  await expect(page.getByRole("dialog")).toContainText("Could not load this Trial (HTTP 404).");
});

test("the bare URL opens the Trials list", async ({ page }) => {
  await page.goto("/");
  await expectList(page, "/trials");
});
