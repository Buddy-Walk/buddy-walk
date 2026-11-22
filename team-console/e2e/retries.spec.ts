import { execFileSync } from "node:child_process";

import { SEEDED } from "../scripts/seed-trials.ts";
import { expect, rowOf, stackEnv, test } from "./fixtures.ts";

// A real retry can't run on the stack, so the test writes the run another tab would have started.
const RUN_KEY = "0192f0c0-0000-7000-8000-000000000001";

/** Writes a retry run the way another tab's retry would have left it on the server. */
function saveRetryRun(status: "running" | "succeeded") {
  const now = Date.now();
  execFileSync(
    "mongoimport",
    [
      "--quiet",
      `--uri=${stackEnv().mongoUri}`,
      "--collection=last_mile_retry_run",
      "--mode=upsert",
    ],
    {
      input: JSON.stringify({
        _id: RUN_KEY,
        requestedId: SEEDED.retriedElsewhere,
        originalId: SEEDED.retriedElsewhere,
        panoramaMode: "fresh",
        status,
        startedAt: { $date: new Date(now - 30_000).toISOString() },
        leaseExpiresAt: { $date: new Date(now + 10 * 60_000).toISOString() },
      }),
    },
  );
}

test("retries being off explains why and disables Retry", async ({ page }) => {
  await page.goto("/trials?q=Petco");
  await expect(page.getByText("Retries are off.")).toBeVisible();
  await expect(page.getByText("Set OPENAI_API_KEY")).toBeVisible();

  const row = rowOf(page, SEEDED.savedWhileLoading);
  await expect(row.getByRole("button", { name: "Retry" })).toBeDisabled();
  await expect(row.getByText("Retries are off on this server.")).toBeVisible();
});

test("a retry started elsewhere shows as running until it finishes", async ({ page }) => {
  const row = rowOf(page, SEEDED.retriedElsewhere);
  await page.goto("/trials?q=Target");
  await expect(row.getByRole("button", { name: "Retry" })).toBeDisabled();

  saveRetryRun("running");
  await page.reload();
  const running = row.getByRole("button", { name: /^Running \d+s$/ });
  await expect(running).toBeVisible();
  // The elapsed time counts up from when the run started, not from the page load.
  await expect(running).toHaveText(/^Running (2\d|[3-9]\d)s$/);
  await expect(row.getByText("Can't retry")).toBeHidden();

  // A reload mid-run still shows it, from what the server reports.
  await page.reload();
  await expect(running).toBeVisible();

  await row.getByRole("link", { name: "View" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("region", { name: "Retry runs" })).toContainText(
    "Waiting for the pipeline.",
  );
  await expect(dialog.getByRole("button", { name: /^Running \d+s$/ })).toBeVisible();
  await page.getByRole("button", { name: "Close" }).click();

  saveRetryRun("succeeded");
  // The list polls every 15 seconds while a retry runs.
  await expect(row.getByRole("button", { name: "Retry" })).toBeVisible({ timeout: 20_000 });
  await expect(running).toBeHidden();
});
