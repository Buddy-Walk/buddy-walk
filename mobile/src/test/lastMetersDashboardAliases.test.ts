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

for (const [oldPath, consolePath] of [
  ["/last-mile-tests", "/trials"],
  ["/last-meters-tests", "/trials"],
  ["/usage", "/usage"],
]) {
  test(`GET ${oldPath} redirects to the Team console's ${consolePath} and drops the token`, async (t) => {
    const app = express();
    mountLastMetersDashboardAliases(app);
    const root = await listen(t, app);

    const res = await fetch(`${root}${oldPath}?token=abc%2B1`, { redirect: "manual" });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), `https://buddy-walk-team-console.buddywalk.workers.dev${consolePath}`);
  });
}

test("GET /api/last-mile/review-status redirects to the Last Meters deploy check", async (t) => {
  const app = express();
  mountLastMetersDashboardAliases(app);
  const root = await listen(t, app);

  const res = await fetch(`${root}/api/last-mile/review-status`, { redirect: "manual" });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "/api/last-meters/review-status");
});
