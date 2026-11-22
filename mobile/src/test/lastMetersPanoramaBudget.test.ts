import assert from "node:assert/strict";
import test from "node:test";
import axios from "axios";
import sharp from "sharp";
import { PanoramaDeadlineError, startPanoramaRequest, withinEntranceBudget, type PanoramaSearchBudget } from "../../server/services/lastMetersPanoramaBudget";
import { selectOutdoorPanorama } from "../../server/services/outdoorPanoramaSelection";
import { processPanoramaTiles } from "../../server/services/streetViewPanorama";
import { setTestEnv } from "./testEnv";

const NOW = Date.parse("2026-10-27T12:00:00Z");
const makeBudget = (deadline: number): PanoramaSearchBudget => ({ seen: new Set(), apiRequests: 0, deadline });

test("request accounting counts a started rejection and skips work that threw before starting", async () => {
  const budget = makeBudget(Date.now() + 1000);
  await assert.rejects(startPanoramaRequest(budget, () => Promise.reject(new Error("upstream"))), /upstream/);
  assert.throws(() => startPanoramaRequest(budget, () => { throw new Error("setup"); }), /setup/);
  assert.equal(await startPanoramaRequest(undefined, () => Promise.resolve(2)), 2);
  assert.equal(budget.apiRequests, 1);
});

test("expired entrance deadline starts no work", async () => {
  let started = false;
  await assert.rejects(withinEntranceBudget(makeBudget(Date.now() - 1), async () => { started = true; }), PanoramaDeadlineError);
  assert.equal(started, false);
});

test("entrance operations cap individual timeouts and release their AbortSignal after completion", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: 1000 });
  let signal!: AbortSignal;
  const value = await withinEntranceBudget(makeBudget(46_000), async (s, timeout) => {
    signal = s; assert.equal(timeout, 8000); assert.equal(s.aborted, false); return 123;
  });
  assert.equal(value, 123); assert.equal(signal.aborted, true);
});

test("a failing operation also releases its AbortSignal", async () => {
  let signal!: AbortSignal;
  await assert.rejects(withinEntranceBudget(makeBudget(Date.now() + 1000), async s => { signal = s; throw new Error("failed"); }), /failed/);
  assert.equal(signal.aborted, true);
});

test("deadline aborts an in-flight request and ignores a late reply", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: NOW });
  const budget = { seen: new Set<string>(), apiRequests: 0, deadline: NOW + 100 };
  let captured!: AbortSignal;
  let finish!: () => void;
  const pending = withinEntranceBudget(budget, (signal, timeout) => {
    captured = signal;
    assert.equal(timeout, 100);
    return new Promise<void>(resolve => { finish = resolve; });
  });
  t.mock.timers.tick(100);
  await assert.rejects(pending, PanoramaDeadlineError);
  assert.equal(captured.aborted, true);
  finish();
  await assert.rejects(withinEntranceBudget(budget, () => assert.fail("Expired request was started")), PanoramaDeadlineError);
});

test("an individual vision timeout aborts before the shared deadline", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: NOW });
  const budget = { seen: new Set<string>(), apiRequests: 0, deadline: NOW + 45_000 };
  let captured!: AbortSignal;
  const pending = withinEntranceBudget(budget, (signal, timeout) => {
    captured = signal;
    assert.equal(timeout, 8000);
    return new Promise<void>(() => {});
  });
  t.mock.timers.tick(8000);
  await assert.rejects(pending, { code: "PANORAMA_REQUEST_TIMEOUT" });
  assert.equal(captured.aborted, true);
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
    { seen: new Set(), deadline: Date.now() - 1, apiRequests: 0, enforceDeadline: true },
    { status: "OK", pano_id: "pinned", copyright: "© Google", location: { lat: 40.7, lng: -74 } }), PanoramaDeadlineError);
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
  await processPanoramaTiles(40.7, -74, async () => "outdoor", undefined, makeBudget(999), metadata);
  assert.ok(timeouts.every(value => value === 20_000));
});
