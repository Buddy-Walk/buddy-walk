import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import axios from "axios";
import express from "express";
import sharp from "sharp";
import { mountLastMeters } from "../../server/routes/lastMeters";
import { lastMetersTestLogService } from "../../server/services/lastMetersTestLog";

// These mount Last Meters on a real Express app, the way the entry point
// does, and call it over HTTP. Google and the upstream host are stand-ins,
// so no test makes a paid or network call.

const KEY_NAMES = ["OPENAI_API_KEY", "GOOGLE_MAPS_API_KEY", "GOOGLE_API_KEY", "ZERO_CONFIG", "UPSTREAM_API_ROOT"];

/**
 * Runs one test with only these routing variables set, and restores them
 * when it ends. Every test file shares one process, so this is per test
 * rather than a file-wide hook.
 */
function onlyEnv(t: TestContext, values: Record<string, string>) {
  const saved = KEY_NAMES.map((name) => [name, process.env[name]] as const);
  KEY_NAMES.forEach((name) => delete process.env[name]);
  Object.assign(process.env, values);
  t.after(() => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}

/** A real photo, so storing it does not log a compression failure. */
const photo = sharp({ create: { width: 1, height: 1, channels: 3, background: "gray" } })
  .jpeg()
  .toBuffer()
  .then((jpeg) => `data:image/jpeg;base64,${jpeg.toString("base64")}`);

/** Starts an app on a free port and closes it when the test ends. */
async function listen(t: TestContext, app: express.Application): Promise<string> {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** An app with Last Meters mounted for the current environment. */
async function lastMetersApp(t: TestContext): Promise<string> {
  const app = express();
  app.use(express.json({ limit: "16mb" }));
  mountLastMeters(app);
  return listen(t, app);
}

async function post(root: string, path: string) {
  const res = await fetch(`${root}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ destination: "CVS", lat: 40.7128, lng: -74.006, deviceHeading: 92.5, image: await photo }),
  });
  const { testLogId, ...rest } = (await res.json()) as { testLogId?: string; [field: string]: unknown };
  return { status: res.status, body: rest, testLogId };
}

async function requestPathOf(testLogId: string | undefined) {
  assert.ok(testLogId, "the response names its test log record");
  return (await lastMetersTestLogService.getById(testLogId))?.requestPath;
}

test("both Last Meters paths answer the same and record which one was called, when run locally", async (t) => {
  onlyEnv(t, { OPENAI_API_KEY: "test-openai-key", GOOGLE_MAPS_API_KEY: "test-maps-key" });
  // Google finds no such place, so the run ends before any OpenAI call.
  t.mock.method(axios, "get", async () => ({ data: { status: "ZERO_RESULTS", results: [] } }));
  const root = await lastMetersApp(t);

  const current = await post(root, "/api/last-meters");
  const old = await post(root, "/api/last-mile");

  assert.equal(current.status, 200);
  assert.equal(current.body.warning, "destination_not_verified");
  assert.deepEqual(old, { ...current, testLogId: old.testLogId });
  assert.equal(await requestPathOf(current.testLogId), "/api/last-meters");
  assert.equal(await requestPathOf(old.testLogId), "/api/last-mile");
});

test("both Last Meters paths answer the same and record which one was called, when proxied", async (t) => {
  // buddywalk.app answers Last Meters as a Question with the photo attached.
  const upstream = express();
  upstream.use(express.json({ limit: "16mb" }));
  upstream.post("/api/text", (_req, res) => {
    res.json({ output: "The entrance is ahead on your right." });
  });
  onlyEnv(t, { UPSTREAM_API_ROOT: await listen(t, upstream) });
  const root = await lastMetersApp(t);

  const current = await post(root, "/api/last-meters");
  const old = await post(root, "/api/last-mile");

  assert.equal(current.status, 200);
  assert.equal(current.body.output, "The entrance is ahead on your right.");
  assert.deepEqual(old, { ...current, testLogId: old.testLogId });
  assert.equal(await requestPathOf(current.testLogId), "/api/last-meters");
  assert.equal(await requestPathOf(old.testLogId), "/api/last-mile");
});

test("a proxied request that cannot reach buddywalk.app still records which path was called", async (t) => {
  // Nothing listens on the discard port, so the upstream refuses the connection.
  onlyEnv(t, { UPSTREAM_API_ROOT: "http://127.0.0.1:9" });
  const root = await lastMetersApp(t);

  const current = await post(root, "/api/last-meters");
  const old = await post(root, "/api/last-mile");

  assert.equal(current.status, 502);
  assert.deepEqual(old, { ...current, testLogId: old.testLogId });
  assert.equal(await requestPathOf(current.testLogId), "/api/last-meters");
  assert.equal(await requestPathOf(old.testLogId), "/api/last-mile");
});
