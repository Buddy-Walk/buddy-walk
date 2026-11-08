import { text } from "node:stream/consumers";

import type { Browser, Page } from "@playwright/test";

import { SEEDED } from "../scripts/seed-trials.ts";
import { expect, rowOf, stackEnv, test, viewLink } from "./fixtures.ts";

const quickSelect = (page: Page, trialId: string) =>
  rowOf(page, trialId).getByRole("combobox", { name: "Outcome" });

/** The old page, in its own tab since its errors aren't the console's. */
async function openOldPage(browser: Browser, destination: string) {
  const { apiBase, token } = stackEnv();
  const page = await browser.newPage();
  await page.goto(`${apiBase}/last-meters-tests?token=${token}`);
  return { page, row: page.locator(".trial-row", { hasText: destination }) };
}

/** A Trial as mobile/server has it saved. */
async function savedTrial(trialId: string) {
  const { apiBase, token } = stackEnv();
  const response = await fetch(`${apiBase}/api/last-meters-tests/${trialId}`, {
    headers: { "x-admin-token": token },
  });
  return ((await response.json()) as { data: Record<string, unknown> }).data;
}

test("a quick score saves, moves the summary, and shows in the old page", async ({
  page,
  browser,
}) => {
  await page.goto("/trials?q=Kohl");
  await expect(page.getByText("0 of 1 Trials scored.")).toBeVisible();

  await quickSelect(page, SEEDED.quickScored).selectOption("needed_retake");
  await expect(page.getByText("1 of 1 Trials scored.")).toBeVisible();

  await page.reload();
  await expect(quickSelect(page, SEEDED.quickScored)).toHaveValue("needed_retake");

  const saved = await savedTrial(SEEDED.quickScored);
  expect(saved).toMatchObject({
    reviewOutcome: "needed_retake",
    reviewerStatus: "partial",
    reviewerNotes: "Door is on the side",
    turnCorrectness: "wrong",
  });

  const old = await openOldPage(browser, "Kohl's");
  await expect(old.row.locator(".quick-outcome")).toHaveValue("needed_retake");
  await old.page.close();
});

test("a review saved in the detail shows on reload and in the old page", async ({
  page,
  browser,
}) => {
  await page.goto(`/trials/${SEEDED.detailReviewed}`);
  const review = page.getByRole("form", { name: "Review" });
  await expect(review.getByLabel("Outcome (required)")).toHaveValue("");

  await review.getByLabel("Outcome (required)").selectOption("got_there");
  await review.getByLabel("Turn").selectOption("correct");
  await review.getByLabel("Entrance").selectOption("not_identified");
  await review.getByLabel("Tester Notes").fill("Found it from the corner");
  await review.getByRole("button", { name: "Save Review" }).click();
  await expect(review.getByRole("button", { name: "Saved!" })).toBeVisible();

  await page.reload();
  await expect(review.getByLabel("Outcome (required)")).toHaveValue("got_there");
  await expect(review.getByLabel("Turn")).toHaveValue("correct");
  await expect(review.getByLabel("Entrance")).toHaveValue("not_identified");
  await expect(review.getByLabel("Tester Notes")).toHaveValue("Found it from the corner");

  const old = await openOldPage(browser, "Old Navy");
  await expect(old.row.locator(".quick-outcome")).toHaveValue("got_there");
  await old.row.locator(".view-btn").click();
  await expect(old.page.locator(".review-notes")).toHaveValue("Found it from the corner");
  await old.page.close();
});

test("a detail still loading when a review saves doesn't undo it", async ({ page }) => {
  await page.goto("/trials?q=Petco");
  await expect(page.locator(viewLink(SEEDED.savedWhileLoading))).toBeVisible();

  // The first load reads the Trial from before the save, and answers after it.
  let answerLoad = () => {};
  const saved = new Promise<void>((resolve) => (answerLoad = resolve));
  let held = false;
  await page.route("**/_serverFn/**", async (route) => {
    if (route.request().method() !== "GET" || held) return route.continue();
    held = true;
    const response = await route.fetch();
    await saved;
    await route.fulfill({ response }).catch(() => {});
  });

  await page.locator(viewLink(SEEDED.savedWhileLoading)).click();
  const review = page.getByRole("form", { name: "Review" });
  await review.getByLabel("Outcome (required)").selectOption("got_there");
  await review.getByLabel("Tester Notes").fill("Saved first");
  await review.getByRole("button", { name: "Save Review" }).click();
  await expect(review.getByRole("button", { name: "Saved!" })).toBeVisible();

  answerLoad();
  await page.waitForLoadState("networkidle");
  await expect(review.getByLabel("Outcome (required)")).toHaveValue("got_there");
  await expect(review.getByLabel("Tester Notes")).toHaveValue("Saved first");
});

test("saving a review with no outcome asks for one", async ({ page }) => {
  await page.goto(`/trials/${SEEDED.failedSave}`);
  const review = page.getByRole("form", { name: "Review" });
  await review.getByRole("button", { name: "Save Review" }).click();
  await expect(review.getByRole("alert")).toContainText("Choose an outcome before saving");
  expect((await savedTrial(SEEDED.failedSave)).reviewOutcome).toBeUndefined();
});

test.describe("when a save fails", () => {
  test.use({ allowedErrors: [/ERR_FAILED/] });

  // Only saves are POSTs; the Trials still load.
  test.beforeEach(async ({ page }) => {
    await page.route("**/_serverFn/**", (route) =>
      route.request().method() === "POST" ? route.abort() : route.continue(),
    );
  });

  test("the quick score says so and goes back to what is saved", async ({ page }) => {
    await page.goto("/trials?q=Staples");
    const select = quickSelect(page, SEEDED.failedSave);
    await select.selectOption("got_there");
    await expect(rowOf(page, SEEDED.failedSave).getByRole("alert")).toContainText(
      "Could not save outcome",
    );
    await expect(select).toHaveValue("");
    await expect(select).toBeEnabled();
  });

  test("the detail says so and keeps what was entered", async ({ page }) => {
    await page.goto(`/trials/${SEEDED.failedSave}`);
    const review = page.getByRole("form", { name: "Review" });
    await review.getByLabel("Outcome (required)").selectOption("got_there");
    await review.getByLabel("Tester Notes").fill("Keep me");
    await review.getByRole("button", { name: "Save Review" }).click();
    await expect(review.getByRole("alert")).toContainText("Could not save review");
    await expect(review.getByLabel("Outcome (required)")).toHaveValue("got_there");
    await expect(review.getByLabel("Tester Notes")).toHaveValue("Keep me");
  });
});

// Both views stop short of the seeded older-shape Trial: mobile/server's export
// answers 500 on its placesSearches, and the old page's export fails the same way.
for (const [name, search, params] of [
  ["a view", "?limit=40", "limit=40"],
  ["a view with retries", "?limit=5&includeRetries=true", "limit=5&includeRetries=true"],
] as const) {
  test(`the CSV matches the old export for ${name}`, async ({ page }) => {
    const { apiBase, token } = stackEnv();
    await page.goto(`/trials${search}`);

    const link = page.getByRole("link", { name: "Export CSV" });
    await expect(link).toHaveAttribute("href", `/api/trials/export.csv?${params}`);

    const [download] = await Promise.all([page.waitForEvent("download"), link.click()]);
    expect(download.suggestedFilename()).toBe("last_meters_tests.csv");
    expect(download.url()).not.toContain(token);

    // The URL the old page's own link points at.
    const old = await fetch(`${apiBase}/api/last-meters-tests/export.csv?token=${token}&${params}`);
    expect(await text(await download.createReadStream())).toBe(await old.text());
  });
}

test("an export with a bad limit is refused", async ({ request }) => {
  const response = await request.get("/api/trials/export.csv?limit=0");
  expect(response.status()).toBe(400);
});
