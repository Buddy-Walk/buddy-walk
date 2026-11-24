import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { describe, test, type TestContext } from "node:test";
import axios from "axios";
import express from "express";
import sharp from "sharp";
import { isMongoConnected, memoryEvents } from "../../server/database/usageStore";
import { mountLastMeters } from "../../server/routes/lastMeters";
import questionRoute from "../../server/routes/question";
import telemetryRoute from "../../server/routes/telemetry";

/**
 * HTTP contract and upstream failure-path coverage for #140.
 * Isolated fixtures only — no production credentials, Mongo, or paid APIs.
 * Serial suite: routing reads process.env, so concurrent tests would race.
 */

const KEY_NAMES = [
  "OPENAI_API_KEY",
  "GOOGLE_MAPS_API_KEY",
  "GOOGLE_API_KEY",
  "ZERO_CONFIG",
  "UPSTREAM_API_ROOT",
];

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

const photo = sharp({ create: { width: 1, height: 1, channels: 3, background: "gray" } })
  .jpeg()
  .toBuffer()
  .then((jpeg) => `data:image/jpeg;base64,${jpeg.toString("base64")}`);

async function listen(t: TestContext, app: express.Application): Promise<string> {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function lastMetersApp(t: TestContext): Promise<string> {
  const app = express();
  app.use(express.json({ limit: "16mb" }));
  mountLastMeters(app);
  return listen(t, app);
}

async function questionApp(t: TestContext): Promise<string> {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use("/api", questionRoute);
  return listen(t, app);
}

async function telemetryApp(t: TestContext): Promise<string> {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use("/api/telemetry", telemetryRoute);
  return listen(t, app);
}

describe("httpFailurePaths (#140)", { concurrency: false }, () => {
  test("Last Meters rejects a malformed body with a stable 400 contract", async (t) => {
    onlyEnv(t, { OPENAI_API_KEY: "test-openai-key", GOOGLE_MAPS_API_KEY: "test-maps-key" });
    const root = await lastMetersApp(t);

    const res = await fetch(`${root}/api/last-meters`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ destination: "CVS", lat: "not-a-number", lng: -74.006 }),
    });
    const body = (await res.json()) as { error?: string };

    assert.equal(res.status, 400);
    assert.equal(body.error, "Missing or invalid required fields");
  });

  test("Last Meters rejects a missing image with a stable 400 contract", async (t) => {
    onlyEnv(t, { OPENAI_API_KEY: "test-openai-key", GOOGLE_MAPS_API_KEY: "test-maps-key" });
    const root = await lastMetersApp(t);

    const res = await fetch(`${root}/api/last-meters`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ destination: "CVS", lat: 40.71, lng: -74.0 }),
    });
    const body = (await res.json()) as { error?: string };

    assert.equal(res.status, 400);
    assert.equal(body.error, "Missing or invalid required fields");
  });

  test("Last Meters returns 503 when forced local without keys", async (t) => {
    // ZERO_CONFIG=false mounts local handlers even without credentials.
    onlyEnv(t, { ZERO_CONFIG: "false" });
    const root = await lastMetersApp(t);

    const res = await fetch(`${root}/api/last-meters`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        destination: "CVS",
        lat: 40.71,
        lng: -74.0,
        image: await photo,
      }),
    });
    const body = (await res.json()) as { error?: string };

    assert.equal(res.status, 503);
    assert.match(String(body.error), /OPENAI_API_KEY/);
  });

  test("proxied Last Meters returns 502 when the upstream is unreachable", async (t) => {
    // Discard port — nothing listens, so the transport fails before a response.
    // Timeout and DNS failures share this same catch → 502 contract.
    onlyEnv(t, { UPSTREAM_API_ROOT: "http://127.0.0.1:9" });
    const root = await lastMetersApp(t);

    const res = await fetch(`${root}/api/last-meters`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        destination: "CVS",
        lat: 40.71,
        lng: -74.0,
        image: await photo,
      }),
    });
    const body = (await res.json()) as { error?: string };

    assert.equal(res.status, 502);
    assert.equal(body.error, "Upstream API unavailable");
  });

  test("a failed Last Meters request does not poison the next request", async (t) => {
    onlyEnv(t, { OPENAI_API_KEY: "test-openai-key", GOOGLE_MAPS_API_KEY: "test-maps-key" });
    t.mock.method(axios, "get", async () => ({ data: { status: "ZERO_RESULTS", results: [] } }));
    const root = await lastMetersApp(t);

    const bad = await fetch(`${root}/api/last-meters`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ destination: "CVS", lat: 40.71, lng: -74.0 }),
    });
    assert.equal(bad.status, 400);

    const good = await fetch(`${root}/api/last-meters`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        destination: "CVS",
        lat: 40.7128,
        lng: -74.006,
        image: await photo,
      }),
    });
    const goodBody = (await good.json()) as { warning?: string };
    assert.equal(good.status, 200);
    assert.equal(goodBody.warning, "destination_not_verified");
  });

  test("parseRequest rejects missing text and non-numeric coords with stable 400s", async (t) => {
    const root = await questionApp(t);

    const missingText = await fetch(`${root}/api/parseRequest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "  ", lat: 40.7, lng: -74.0 }),
    });
    assert.equal(missingText.status, 400);
    assert.deepEqual(await missingText.json(), {
      error: "text is required and must be a non-empty string",
    });

    const badCoords = await fetch(`${root}/api/parseRequest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "nearest pharmacy", lat: "40.7", lng: -74.0 }),
    });
    assert.equal(badCoords.status, 400);
    assert.deepEqual(await badCoords.json(), { error: "lat and lng must be numbers" });
  });

  test("telemetry accepts events into memory when Mongo is unavailable", async (t) => {
    assert.equal(isMongoConnected(), false, "suite must not attach production Mongo");
    const before = memoryEvents.length;
    const root = await telemetryApp(t);

    const res = await fetch(`${root}/api/telemetry/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        installId: "test-install-140",
        sessionId: "test-session-140",
        platform: "test",
        events: [{ name: "http_failure_coverage", ts: Date.now() }],
      }),
    });
    const body = (await res.json()) as { accepted?: number };

    assert.equal(res.status, 200);
    assert.equal(body.accepted, 1);
    assert.ok(memoryEvents.length >= before + 1);
    const last = memoryEvents[memoryEvents.length - 1];
    assert.equal(last.installId, "test-install-140");
    assert.equal(last.name, "http_failure_coverage");
  });

  test("telemetry rejects a malformed body with a stable 400 contract", async (t) => {
    const root = await telemetryApp(t);
    const res = await fetch(`${root}/api/telemetry/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ events: [] }),
    });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "installId and sessionId are required" });
  });
});
