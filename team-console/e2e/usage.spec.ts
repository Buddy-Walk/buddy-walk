import type { Page } from "@playwright/test";

import { expect, stackEnv, test } from "./fixtures.ts";

const card = (page: Page, label: string) =>
  page.locator('[data-slot="card"]').filter({ hasText: label });

const section = (page: Page, name: string) => page.getByRole("region", { name });

const SINCE = "2026-11-01";

test("shows the summary, tables and feedback from mobile/server", async ({ page }) => {
  await page.goto("/usage");

  for (const [label, value] of [
    ["Telemetry events", "5"],
    ["Unique installs", "3"],
    ["Avg answer latency (ms)", "1500"],
    ["AI requests logged", "4"],
    ["AI success rate", "75%"],
    ["Data source", "mongo"],
  ] as const) {
    await expect(card(page, label)).toContainText(value);
  }

  const events = section(page, "Events by name");
  await expect(events.getByRole("row", { name: "question_asked 2" })).toBeVisible();
  await expect(events.getByRole("row", { name: "app_open 1" })).toBeVisible();

  const features = section(page, "Feature usage (Q&A)");
  await expect(features.getByRole("row", { name: "directions 2" })).toBeVisible();
  await expect(features.getByRole("row", { name: "42 1" })).toBeVisible();

  const ai = section(page, "AI requests (server-side)");
  await expect(ai.getByRole("row", { name: "question 3 2000" })).toBeVisible();
  await expect(ai.getByRole("row", { name: "last_meters 1 500" })).toBeVisible();

  const feedback = section(page, "Recent feedback");
  await expect(feedback.getByRole("row").filter({ hasText: "Very helpful" })).toContainText("👍");
  await expect(feedback.getByRole("row").filter({ hasText: "Wrong turn" })).toContainText("👎");
  await expect(feedback.getByRole("row").filter({ hasText: "left, then right" })).toContainText(
    "4★",
  );
});

test("filters the summary by date, while recent feedback stays unfiltered", async ({ page }) => {
  await page.goto("/usage");
  await expect(card(page, "Telemetry events")).toContainText("5");

  await page.getByLabel("Since").fill(SINCE);
  await expect(page).toHaveURL("/usage");
  await page.getByRole("button", { name: "Apply filters" }).click();

  await expect(page).toHaveURL(`/usage?since=${SINCE}`);
  await expect(card(page, "Telemetry events")).toContainText("2");
  await expect(card(page, "AI requests logged")).toContainText("1");
  await expect(page.getByRole("link", { name: "Events CSV" })).toHaveAttribute(
    "href",
    `/api/usage/events.csv?since=${SINCE}`,
  );
  await expect(
    section(page, "Recent feedback").getByRole("row").filter({ hasText: "Crash on launch" }),
  ).toBeVisible();
});

test.describe("CSV exports match mobile/server's", () => {
  for (const [label, path, filename] of [
    ["Events CSV", "/api/telemetry/events.csv", "telemetry_events.csv"],
    ["AI Requests CSV", "/api/telemetry/ai-requests.csv", "ai_requests.csv"],
    ["Feedback CSV", "/api/feedback/export.csv", "feedback.csv"],
    ["Chat Logs CSV", "/api/db/chatlogs.csv", "chat_logs.csv"],
  ] as const) {
    for (const query of ["", `?since=${SINCE}`]) {
      test(`${label} ${query || "unfiltered"}`, async ({ page, request }) => {
        const { apiBase, token } = stackEnv();
        await page.goto(`/usage${query}`);
        const link = page.getByRole("link", { name: label });
        const href = await link.getAttribute("href");
        expect(href).not.toContain("token");

        const ours = await request.get(href!);
        expect(ours.status()).toBe(200);
        expect(ours.headers()["content-disposition"]).toBe(`attachment; filename="${filename}"`);

        const theirs = await fetch(`${apiBase}${path}${query}`, {
          headers: { "x-admin-token": token! },
        });
        const text = await ours.text();
        expect(text.split("\r\n").length).toBeGreaterThan(1);
        expect(text).toBe(await theirs.text());
      });
    }
  }
});

test("a CSV link downloads a file under mobile/server's name", async ({ page }) => {
  await page.goto("/usage");
  const download = page.waitForEvent("download");
  await page.getByRole("link", { name: "Chat Logs CSV" }).click();
  expect((await download).suggestedFilename()).toBe("chat_logs.csv");
});

test("the export route refuses an unknown file or a bad date", async ({ request }) => {
  expect((await request.get("/api/usage/users.csv")).status()).toBe(404);
  expect((await request.get("/api/usage/events.csv?since=soon")).status()).toBe(400);
});

test("the nav moves between Trials and Usage", async ({ page }) => {
  await page.goto("/trials");
  const nav = page.getByRole("navigation", { name: "Team console" });

  await nav.getByRole("link", { name: "Usage" }).click();
  await expect(page).toHaveURL("/usage");
  await expect(page.getByRole("heading", { name: "Usage", exact: true })).toBeVisible();

  await nav.getByRole("link", { name: "Trials" }).click();
  await expect(page).toHaveURL("/trials");
  await expect(page.getByRole("heading", { name: "Last Meters Trials" })).toBeVisible();
});
