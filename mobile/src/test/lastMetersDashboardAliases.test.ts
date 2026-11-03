import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import express from "express";
import { mountLastMetersDashboardAliases } from "../../server/config/lastMetersDashboardAliases";

async function listen(t: TestContext, app: express.Application): Promise<string> {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

test("GET /last-mile-tests redirects to the Trials dashboard and keeps the token", async (t) => {
  const app = express();
  mountLastMetersDashboardAliases(app);
  const root = await listen(t, app);

  const res = await fetch(`${root}/last-mile-tests?token=abc%2B1`, { redirect: "manual" });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "/last-meters-tests?token=abc%2B1");
});

test("GET /api/last-mile/review-status redirects to the Last Meters deploy check", async (t) => {
  const app = express();
  mountLastMetersDashboardAliases(app);
  const root = await listen(t, app);

  const res = await fetch(`${root}/api/last-mile/review-status`, { redirect: "manual" });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "/api/last-meters/review-status");
});
