import assert from "node:assert/strict";
import test from "node:test";
import axios from "axios";
import sharp from "sharp";
import { withinEntranceBudget } from "../../server/services/lastMetersPanoramaBudget";
import { countPanoramaRequest, selectOutdoorPanorama, type PanoramaSearchBudget } from "../../server/services/outdoorPanoramaSelection";
import { processPanoramaTiles } from "../../server/services/streetViewPanorama";
import { setTestEnv } from "./testEnv";

test("request accounting includes started failures and leaves absent budgets untouched", () => {
  const budget: PanoramaSearchBudget = { seen: new Set(), deadline: Date.now() + 1000 };
  countPanoramaRequest(budget); countPanoramaRequest(budget); countPanoramaRequest();
  assert.equal(budget.apiRequests, 2);
});

test("expired entrance deadline starts no work", async () => {
  let started = false;
  await assert.rejects(withinEntranceBudget(Date.now() - 1, async () => { started = true; }), /entrance_timeout/);
  assert.equal(started, false);
});

test("entrance operations cap individual timeouts and release their AbortSignal after completion", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: 1000 });
  let signal!: AbortSignal;
  const value = await withinEntranceBudget(46_000, async (s, timeout) => {
    signal = s; assert.equal(timeout, 8000); assert.equal(s.aborted, false); return 123;
  });
  assert.equal(value, 123); assert.equal(signal.aborted, true);
});

test("a failing operation also releases its AbortSignal", async () => {
  let signal!: AbortSignal;
  await assert.rejects(withinEntranceBudget(Date.now() + 1000, async s => { signal = s; throw new Error("failed"); }), /failed/);
  assert.equal(signal.aborted, true);
});

test("remaining shared time bounds stalled work and prevents a late result from winning", { timeout: 1000 }, async t => {
  t.mock.timers.enable({ apis: ["Date"], now: 1000 });
  let finish!: (value: string) => void, signal!: AbortSignal;
  await assert.rejects(withinEntranceBudget(1020, async (s, timeout) => {
    signal = s; assert.equal(timeout, 20); return new Promise(resolve => { finish = resolve; });
  }), /entrance_timeout/);
  assert.equal(signal.aborted, true); finish("late");
});

test("outdoor request accounting includes metadata, previews, and scene classification", async t => {
  const budget: PanoramaSearchBudget = { seen: new Set(), deadline: Date.now() + 45_000, apiRequests: 0 };
  const pixels = Buffer.alloc(640 * 640 * 3);
  for (let i = 0; i < pixels.length; i++) pixels[i] = (i * 13 + Math.floor(i / 19)) % 256;
  const jpeg = await sharp(pixels, { raw: { width: 640, height: 640, channels: 3 } }).jpeg().toBuffer();
  t.mock.method(axios, "get", async (url: string) => url.endsWith("/metadata")
    ? { data: { status: "OK", pano_id: "outdoor", copyright: "© Google", location: { lat: 40.7, lng: -74 } } }
    : { status: 200, data: jpeg });
  await selectOutdoorPanorama(40.7, -74, "test", async () => "outdoor", undefined, budget);
  assert.equal(budget.apiRequests, 6);
});

test("experimental pinned tiles do not start after their shared deadline", async t => {
  setTestEnv(t, { GOOGLE_MAPS_API_KEY: "test" });
  let calls = 0;
  t.mock.method(axios, "get", async () => { calls++; return { status: 200, data: Buffer.alloc(10_001) }; });
  await assert.rejects(processPanoramaTiles(40.7, -74, async () => "outdoor", undefined,
    { seen: new Set(), deadline: Date.now() - 1, enforceDeadline: true },
    { status: "OK", pano_id: "pinned", copyright: "© Google", location: { lat: 40.7, lng: -74 } }), /budget exhausted/);
  assert.equal(calls, 0);
});

test("experimental tiles use remaining time while legacy tiles retain their timeout", async t => {
  setTestEnv(t, { GOOGLE_MAPS_API_KEY: "test" });
  t.mock.timers.enable({ apis: ["Date"], now: 1000 });
  const timeouts: number[] = [];
  t.mock.method(axios, "get", async (_url: string, options: any) => {
    timeouts.push(options.timeout); return { status: 200, data: Buffer.alloc(10_001) };
  });
  const metadata = { status: "OK", pano_id: "pinned", copyright: "© Google", location: { lat: 40.7, lng: -74 } };
  const experimental = { seen: new Set<string>(), deadline: 2000, enforceDeadline: true, apiRequests: 0 };
  await processPanoramaTiles(40.7, -74, async () => "outdoor", undefined, experimental, metadata);
  assert.equal(experimental.apiRequests, 16); assert.ok(timeouts.every(value => value === 1000));
  timeouts.length = 0;
  await processPanoramaTiles(40.7, -74, async () => "outdoor", undefined, { seen: new Set(), deadline: 999 }, metadata);
  assert.ok(timeouts.every(value => value === 20_000));
});
