import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import type { Request, Response } from "express";
import { LastMileTestLogController } from "../../server/controllers/lastMileTestLog";
import type { lastMileTestLogInterface } from "../../server/database/models/lastMileTestLog";
import { memoryLastMileTests, pushMemoryLastMileTest } from "../../server/database/usageStore";
import {
  LastMileRetryError,
  RetryLimiter,
  retryLastMileTest,
  type RetryDependencies,
} from "../../server/services/lastMileRetry";
import type { LastMetersRunOptions } from "../../server/services/openAI";
import { buildReplayInput, replayRequest } from "../../server/utils/lastMileReplay";
import type { LastMileSensors } from "../../src/utils/lastMileSafety";

// These run against the in-memory log store with stand-ins for OpenAI and
// Street View, so no test makes a paid or network call.

const PHOTO = "data:image/jpeg;base64,BBBBBB";
const KEY_NAMES = ["OPENAI_API_KEY", "GOOGLE_MAPS_API_KEY", "GOOGLE_API_KEY", "ADMIN_TOKEN"];
let savedEnv: Record<string, string | undefined> = {};

const RECEIVED_AT = 1_800_000_000_000;
const sensors = { photoCapturedAt: RECEIVED_AT } as LastMileSensors;
const request = { destination: "CVS", lat: 40.7128, lng: -74.006, deviceHeading: 92.5, sensors };
const snapshot = buildReplayInput(request, PHOTO, RECEIVED_AT);

function seed(id: string, fields: Partial<lastMileTestLogInterface> = {}) {
  pushMemoryLastMileTest({
    _id: id,
    destination: request.destination,
    lat: request.lat,
    lng: request.lng,
    deviceHeading: request.deviceHeading,
    replayInput: snapshot,
    userPhoto: PHOTO,
    panoId: "pano-original",
    panoramaHeadings: [],
    steps: [],
    success: false,
    latencyMs: 1000,
    serverTs: new Date(),
    ...fields,
  } as lastMileTestLogInterface);
}

interface PipelineCall {
  input: unknown;
  image: string;
  options: LastMetersRunOptions;
}

/** Records every call and saves a retry log the way the real pipeline does. */
function fakeDependencies(overrides: Partial<RetryDependencies> = {}, perMinute = 100) {
  const pipelineCalls: PipelineCall[] = [];
  const panoramaChecks: string[] = [];
  const dependencies: RetryDependencies = {
    runLastMeters: async (input, image, options = {}) => {
      pipelineCalls.push({ input, image, options });
      const testLogId = `retry-${pipelineCalls.length}`;
      seed(testLogId, {
        userPhoto: undefined,
        panoId: undefined,
        retryOf: options.retry?.retryOf,
        retryPanoramaMode: options.retry?.panoramaMode,
      });
      // Approach trials attach their panorama after answering.
      const reviewPanorama = new Promise<void>((resolve) =>
        setTimeout(() => {
          const row = memoryLastMileTests.find((r) => (r as { _id?: string })._id === testLogId);
          if (row) row.panoId = options.pinnedPanoId ?? "pano-fresh";
          resolve();
        }, 5)
      );
      return { kind: "response", status: 200, body: {}, testLogId, reviewPanorama };
    },
    fetchPanoramaById: async (panoId) => {
      panoramaChecks.push(panoId);
      return { status: "OK", pano_id: panoId } as Awaited<
        ReturnType<RetryDependencies["fetchPanoramaById"]>
      >;
    },
    limiter: new RetryLimiter(perMinute),
    ...overrides,
  };
  return { dependencies, pipelineCalls, panoramaChecks };
}

async function retryError(run: Promise<unknown>): Promise<LastMileRetryError> {
  try {
    await run;
  } catch (error) {
    assert.ok(error instanceof LastMileRetryError, `expected a LastMileRetryError, got ${error}`);
    return error;
  }
  assert.fail("expected the retry to be refused");
}

beforeEach(() => {
  savedEnv = Object.fromEntries(KEY_NAMES.map((name) => [name, process.env[name]]));
  KEY_NAMES.forEach((name) => delete process.env[name]);
  process.env.OPENAI_API_KEY = "test-openai-key";
  process.env.GOOGLE_MAPS_API_KEY = "test-maps-key";
  process.env.ADMIN_TOKEN = "secret";
  memoryLastMileTests.length = 0;
});

afterEach(() => {
  KEY_NAMES.forEach((name) => {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  });
  memoryLastMileTests.length = 0;
});

test("a fresh retry runs the stored inputs with the normal panorama fetch", async () => {
  seed("orig");
  const fake = fakeDependencies();
  const result = await retryLastMileTest("orig", "fresh", fake.dependencies);

  assert.equal(fake.pipelineCalls.length, 1);
  const [call] = fake.pipelineCalls;
  assert.deepEqual(call.input, replayRequest(snapshot));
  assert.equal(call.image, PHOTO);
  assert.equal(call.options.pinnedPanoId, undefined);
  // The original's snapshot travels with the retry, so the safety gate judges
  // sensor freshness as of the original request.
  assert.deepEqual(call.options.retry, {
    retryOf: "orig",
    panoramaMode: "fresh",
    defaultsApplied: [],
    replayInput: snapshot,
  });
  assert.deepEqual(fake.panoramaChecks, []);

  assert.equal(result.testLogId, "retry-1");
  // The saved log is read after its review panorama is attached.
  assert.equal(result.log?.panoId, "pano-fresh");
});

test("an original-panorama retry checks and pins the original's panorama", async () => {
  seed("orig");
  const fake = fakeDependencies();
  await retryLastMileTest("orig", "original", fake.dependencies);

  assert.deepEqual(fake.panoramaChecks, ["pano-original"]);
  assert.equal(fake.pipelineCalls[0].options.pinnedPanoId, "pano-original");
  assert.equal(fake.pipelineCalls[0].options.retry?.panoramaMode, "original");
});

test("a retry of a retry replays the original and links to it", async () => {
  seed("orig");
  seed("first-retry", {
    retryOf: "orig",
    userPhoto: undefined,
    destination: "Somewhere else",
    replayInput: undefined,
  });
  const fake = fakeDependencies();
  await retryLastMileTest("first-retry", "fresh", fake.dependencies);

  const [call] = fake.pipelineCalls;
  assert.equal(call.options.retry?.retryOf, "orig");
  assert.equal(call.image, PHOTO);
  assert.deepEqual(call.input, replayRequest(snapshot));
});

test("a retry is refused when ADMIN_TOKEN is not set, since it makes paid calls", async () => {
  seed("orig");
  delete process.env.ADMIN_TOKEN;
  const fake = fakeDependencies();
  const error = await retryError(retryLastMileTest("orig", "fresh", fake.dependencies));
  assert.equal(error.status, 503);
  assert.match(error.message, /ADMIN_TOKEN/);
  assert.equal(fake.pipelineCalls.length, 0);
});

test("a retry is refused without the OpenAI and Google keys", async () => {
  seed("orig");
  delete process.env.OPENAI_API_KEY;
  const fake = fakeDependencies();
  const error = await retryError(retryLastMileTest("orig", "fresh", fake.dependencies));
  assert.equal(error.status, 503);
  assert.match(error.message, /OPENAI_API_KEY/);
  assert.equal(fake.pipelineCalls.length, 0);
});

test("unknown tests and retries whose original is gone are 404s", async () => {
  const fake = fakeDependencies();
  assert.equal((await retryError(retryLastMileTest("missing", "fresh", fake.dependencies))).status, 404);

  seed("orphan", { retryOf: "deleted-original", userPhoto: undefined });
  const orphan = await retryError(retryLastMileTest("orphan", "fresh", fake.dependencies));
  assert.equal(orphan.status, 404);
  assert.match(orphan.message, /original/);
  assert.equal(fake.pipelineCalls.length, 0);
});

test("a test that cannot be replayed never reaches the pipeline", async () => {
  seed("no-photo", { userPhoto: "data:," });
  seed("question", { testScenario: "question_routed" });
  seed("legacy", { replayInput: undefined });
  const fake = fakeDependencies();

  const legacy = await retryError(retryLastMileTest("legacy", "fresh", fake.dependencies));
  assert.equal(legacy.status, 409);
  assert.match(legacy.message, /capture timestamps/);

  const noPhoto = await retryError(retryLastMileTest("no-photo", "fresh", fake.dependencies));
  assert.equal(noPhoto.status, 409);
  assert.match(noPhoto.message, /photo/);

  const question = await retryError(retryLastMileTest("question", "fresh", fake.dependencies));
  assert.equal(question.status, 409);
  assert.match(question.message, /question/);

  assert.equal(fake.pipelineCalls.length, 0);
});

test("original mode is refused when the original has no stored panorama", async () => {
  seed("no-pano", { panoId: undefined });
  const fake = fakeDependencies();
  const error = await retryError(retryLastMileTest("no-pano", "original", fake.dependencies));
  assert.equal(error.status, 409);
  assert.deepEqual(fake.panoramaChecks, []);
  assert.equal(fake.pipelineCalls.length, 0);
});

test("a retired original panorama is reported, never swapped for a fresh one", async () => {
  seed("orig");
  const fake = fakeDependencies({
    fetchPanoramaById: async (panoId) => {
      throw Object.assign(new Error(`Street View panorama ${panoId} is no longer available.`), {
        code: "STREET_VIEW_PANO_ZERO_RESULTS",
      });
    },
  });
  const error = await retryError(retryLastMileTest("orig", "original", fake.dependencies));
  assert.equal(error.status, 409);
  assert.match(error.message, /no longer available.*fresh panorama/);
  assert.equal(fake.pipelineCalls.length, 0);
});

test("Street View being unreachable is a 502, not a retired panorama", async () => {
  seed("orig");
  const fake = fakeDependencies({
    fetchPanoramaById: async () => {
      throw new Error("socket hang up");
    },
  });
  const error = await retryError(retryLastMileTest("orig", "original", fake.dependencies));
  assert.equal(error.status, 502);
  assert.match(error.message, /Could not reach Google Street View.*socket hang up/);
  assert.equal(fake.pipelineCalls.length, 0);
});

test("one retry runs at a time, and at most a few start per minute", async () => {
  seed("orig");
  let finish!: () => void;
  const fake = fakeDependencies({}, 2);
  const runLastMeters = fake.dependencies.runLastMeters;
  fake.dependencies.runLastMeters = async (...args) => {
    await new Promise<void>((resolve) => (finish = resolve));
    return runLastMeters(...args);
  };

  const first = retryLastMileTest("orig", "fresh", fake.dependencies);
  const busy = await retryError(retryLastMileTest("orig", "fresh", fake.dependencies));
  assert.equal(busy.status, 429);
  assert.match(busy.message, /still running/);
  finish();
  await first;

  fake.dependencies.runLastMeters = runLastMeters;
  await retryLastMileTest("orig", "fresh", fake.dependencies);
  const limited = await retryError(retryLastMileTest("orig", "fresh", fake.dependencies));
  assert.equal(limited.status, 429);
  assert.match(limited.message, /per minute/);
  assert.equal(fake.pipelineCalls.length, 2);
});

test("the per-minute limit frees up as the minute passes, and refusals are not counted", () => {
  let now = 0;
  const limiter = new RetryLimiter(1, () => now);
  limiter.acquire()();
  now = 30_000;
  assert.throws(() => limiter.acquire(), /per minute/);
  now = 60_000;
  limiter.acquire()();
});

test("a retry leaves the original trial unchanged", async () => {
  seed("orig");
  const before = JSON.stringify(memoryLastMileTests.find((row) => (row as { _id?: string })._id === "orig"));
  await retryLastMileTest("orig", "original", fakeDependencies().dependencies);
  const after = JSON.stringify(memoryLastMileTests.find((row) => (row as { _id?: string })._id === "orig"));
  assert.equal(after, before);
});

test("a retry whose result was not saved is a 500", async () => {
  seed("orig");
  const fake = fakeDependencies({
    runLastMeters: async () => ({ kind: "response", status: 200, body: {} }),
  });
  const error = await retryError(retryLastMileTest("orig", "fresh", fake.dependencies));
  assert.equal(error.status, 500);
});

// The endpoint itself. Only refusals are exercised here, since an accepted
// retry would run the real pipeline.

function fakeExchange(id: string, body: unknown, headers: Record<string, string> = {}) {
  const req = { params: { id }, body, headers, query: {} } as unknown as Request;
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return { req, res };
}

const controller = new LastMileTestLogController();

test("the retry endpoint requires the admin token", async () => {
  seed("orig");
  const denied = fakeExchange("orig", { panoramaMode: "fresh" });
  await controller.retry(denied.req, denied.res as unknown as Response);
  assert.equal(denied.res.statusCode, 401);

  // A correct token gets past auth; this test then stops at the replay check.
  seed("no-photo", { userPhoto: "data:," });
  const allowed = fakeExchange("no-photo", { panoramaMode: "fresh" }, { "x-admin-token": "secret" });
  await controller.retry(allowed.req, allowed.res as unknown as Response);
  assert.equal(allowed.res.statusCode, 409);
});

test("the retry endpoint rejects an unknown panorama mode", async () => {
  seed("orig");
  const { req, res } = fakeExchange("orig", { panoramaMode: "sideways" }, { "x-admin-token": "secret" });
  await controller.retry(req, res as unknown as Response);
  assert.equal(res.statusCode, 400);
  assert.match(String((res.body as { error?: string }).error), /fresh or original/);
});

test("the retry endpoint answers refusals with their status and reason", async () => {
  seed("no-pano", { panoId: undefined });
  const conflict = fakeExchange("no-pano", { panoramaMode: "original" }, { "x-admin-token": "secret" });
  await controller.retry(conflict.req, conflict.res as unknown as Response);
  assert.equal(conflict.res.statusCode, 409);
  assert.match(String((conflict.res.body as { error?: string }).error), /pano/i);

  delete process.env.GOOGLE_MAPS_API_KEY;
  const unavailable = fakeExchange("no-pano", { panoramaMode: "fresh" }, { "x-admin-token": "secret" });
  await controller.retry(unavailable.req, unavailable.res as unknown as Response);
  assert.equal(unavailable.res.statusCode, 503);
});
