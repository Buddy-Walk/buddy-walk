import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import type { Request, Response } from "express";
import mongoose from "mongoose";
import { v4, v7 } from "uuid";
import { LastMileTestLogController } from "../../server/controllers/lastMileTestLog";
import type { lastMileTestLogInterface } from "../../server/database/models/lastMileTestLog";
import type { RetryPanoramaMode } from "../../server/database/models/lastMileTestLog";
import {
  memoryLastMileTests,
  memoryRetryRuns,
  pushMemoryLastMileTest,
} from "../../server/database/usageStore";
import {
  findOriginal,
  LastMileRetryError,
  RETRY_MAX_RUN_MS,
  RetryLimiter,
  retryLastMileTest,
  type RetryDependencies,
  type RetryRequest,
} from "../../server/services/lastMileRetry";
import {
  lastMileRetryRunService,
  RETRY_LEASE_MS,
  withRenewedLease,
} from "../../server/services/lastMileRetryRuns";
import { proxiedRequestFields } from "../../server/middleware/upstreamProxy";
import { asyncRoute } from "../../server/utils/asyncRoute";
import { parseIdempotencyKey } from "../../server/utils/idempotencyKey";
import { lastMileTestLogService } from "../../server/services/lastMileTestLog";
import { getOpenAIClient } from "../../server/services/openAIClient";
import type { LastMetersRunOptions } from "../../server/services/lastMetersService";
import {
  LAST_MILE_PIPELINE_VERSION,
  UPSTREAM_PIPELINE_VERSION,
  buildReplayInput,
  parseLastMetersRequest,
  replayRequest,
} from "../../server/utils/lastMileReplay";
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

/** A request with a new UUIDv7 key, as the dashboard sends one per click. */
function retryRequest(id: string, panoramaMode: RetryPanoramaMode, idempotencyKey = v7()): RetryRequest {
  return { id, panoramaMode, idempotencyKey };
}

/** Holds pipeline runs until release() is called; later runs pass straight through. */
function gate() {
  const waiting: Array<() => void> = [];
  let open = false;
  return {
    wait: () => (open ? Promise.resolve() : new Promise<void>((resolve) => waiting.push(resolve))),
    release: () => {
      open = true;
      waiting.splice(0).forEach((resolve) => resolve());
    },
    get waiting() {
      return waiting.length;
    },
  };
}

/** Lets pending promise callbacks run, so held retries reach the pipeline. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

/** Holds the fake pipeline at a gate, so tests can act while retries run. */
function holdPipeline(fake: ReturnType<typeof fakeDependencies>) {
  const held = gate();
  const runLastMeters = fake.dependencies.runLastMeters;
  fake.dependencies.runLastMeters = async (...args) => {
    await held.wait();
    return runLastMeters(...args);
  };
  return held;
}

interface PipelineCall {
  input: unknown;
  image: string;
  options: LastMetersRunOptions;
}

/** Records every call and saves a retry log the way the real pipeline does. */
function fakeDependencies(overrides: Partial<RetryDependencies> = {}, maxConcurrent = 3) {
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
          if (row) row.panoId = options.pinnedPanorama?.pano_id ?? "pano-fresh";
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
    limiter: new RetryLimiter(maxConcurrent),
    runs: lastMileRetryRunService,
    maxRunMs: RETRY_MAX_RUN_MS,
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
  memoryRetryRuns.clear();
});

afterEach(() => {
  KEY_NAMES.forEach((name) => {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  });
  memoryLastMileTests.length = 0;
  memoryRetryRuns.clear();
});

test("a fresh retry runs the stored inputs with the normal panorama fetch", async () => {
  seed("orig");
  const fake = fakeDependencies();
  const result = await retryLastMileTest(retryRequest("orig", "fresh"), fake.dependencies);

  assert.equal(fake.pipelineCalls.length, 1);
  const [call] = fake.pipelineCalls;
  assert.deepEqual(call.input, replayRequest(snapshot));
  assert.equal(call.image, PHOTO);
  assert.equal(call.options.pinnedPanorama, undefined);
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
  // It is read without images, but still reports the original's photo.
  assert.equal(result.log?.imageStats.userPhoto.stored, true);
  assert.equal("userPhoto" in (result.log ?? {}), false);
});

test("an original-panorama retry checks and pins the original's panorama", async () => {
  seed("orig");
  const fake = fakeDependencies();
  await retryLastMileTest(retryRequest("orig", "original"), fake.dependencies);

  // Looked up once, before the pipeline, which then runs on that same metadata.
  assert.deepEqual(fake.panoramaChecks, ["pano-original"]);
  assert.deepEqual(fake.pipelineCalls[0].options.pinnedPanorama, { status: "OK", pano_id: "pano-original" });
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
  await retryLastMileTest(retryRequest("first-retry", "fresh"), fake.dependencies);

  const [call] = fake.pipelineCalls;
  assert.equal(call.options.retry?.retryOf, "orig");
  assert.equal(call.image, PHOTO);
  assert.deepEqual(call.input, replayRequest(snapshot));
});

test("a retry is refused when ADMIN_TOKEN is not set, since it makes paid calls", async () => {
  seed("orig");
  delete process.env.ADMIN_TOKEN;
  const fake = fakeDependencies();
  const error = await retryError(retryLastMileTest(retryRequest("orig", "fresh"), fake.dependencies));
  assert.equal(error.status, 503);
  assert.match(error.message, /ADMIN_TOKEN/);
  assert.equal(fake.pipelineCalls.length, 0);
});

test("a retry is refused without the OpenAI and Google keys", async () => {
  seed("orig");
  delete process.env.OPENAI_API_KEY;
  const fake = fakeDependencies();
  const error = await retryError(retryLastMileTest(retryRequest("orig", "fresh"), fake.dependencies));
  assert.equal(error.status, 503);
  assert.match(error.message, /OPENAI_API_KEY/);
  assert.equal(fake.pipelineCalls.length, 0);
});

test("unknown tests and retries whose original is gone are 404s", async () => {
  const fake = fakeDependencies();
  assert.equal((await retryError(retryLastMileTest(retryRequest("missing", "fresh"), fake.dependencies))).status, 404);

  seed("orphan", { retryOf: "deleted-original", userPhoto: undefined });
  const orphan = await retryError(retryLastMileTest(retryRequest("orphan", "fresh"), fake.dependencies));
  assert.equal(orphan.status, 404);
  assert.match(orphan.message, /original/);
  assert.equal(fake.pipelineCalls.length, 0);
});

test("a test that cannot be replayed never reaches the pipeline", async () => {
  seed("no-photo", { userPhoto: "data:," });
  seed("question", { testScenario: "question_routed" });
  seed("legacy", { replayInput: undefined });
  const fake = fakeDependencies();

  const legacy = await retryError(retryLastMileTest(retryRequest("legacy", "fresh"), fake.dependencies));
  assert.equal(legacy.status, 409);
  assert.match(legacy.message, /capture timestamps/);

  const noPhoto = await retryError(retryLastMileTest(retryRequest("no-photo", "fresh"), fake.dependencies));
  assert.equal(noPhoto.status, 409);
  assert.match(noPhoto.message, /photo/);

  const question = await retryError(retryLastMileTest(retryRequest("question", "fresh"), fake.dependencies));
  assert.equal(question.status, 409);
  assert.match(question.message, /question/);

  assert.equal(fake.pipelineCalls.length, 0);
});

test("original mode is refused when the original has no stored panorama", async () => {
  seed("no-pano", { panoId: undefined });
  const fake = fakeDependencies();
  const error = await retryError(retryLastMileTest(retryRequest("no-pano", "original"), fake.dependencies));
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
  const error = await retryError(retryLastMileTest(retryRequest("orig", "original"), fake.dependencies));
  assert.equal(error.status, 409);
  assert.equal(error.code, "original_panorama_retired");
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
  const error = await retryError(retryLastMileTest(retryRequest("orig", "original"), fake.dependencies));
  assert.equal(error.status, 502);
  assert.equal(error.code, undefined);
  assert.match(error.message, /Could not check the original panorama.*socket hang up/);
  assert.equal(fake.pipelineCalls.length, 0);
});

test("up to three retries of different tests run at once, and a fourth waits its turn", async () => {
  ["a", "b", "c", "d"].forEach((id) => seed(id));
  const fake = fakeDependencies();
  const held = holdPipeline(fake);

  const running = ["a", "b", "c"].map((id) => retryLastMileTest(retryRequest(id, "fresh"), fake.dependencies));
  await settle();
  assert.equal(held.waiting, 3);

  const fourth = await retryError(retryLastMileTest(retryRequest("d", "fresh"), fake.dependencies));
  assert.equal(fourth.status, 429);
  assert.equal(fourth.code, "retry_capacity");
  assert.match(fourth.message, /3 retries are already running/);

  held.release();
  await Promise.all(running);
  await retryLastMileTest(retryRequest("d", "fresh"), fake.dependencies);
  assert.equal(fake.pipelineCalls.length, 4);
});

test("a capacity refusal does not use up the key", async () => {
  seed("a");
  seed("b");
  const fake = fakeDependencies({}, 1);
  const held = holdPipeline(fake);

  const first = retryLastMileTest(retryRequest("a", "fresh"), fake.dependencies);
  await settle();
  const request = retryRequest("b", "fresh");
  assert.equal((await retryError(retryLastMileTest(request, fake.dependencies))).status, 429);
  held.release();
  await first;

  const result = await retryLastMileTest(request, fake.dependencies);
  assert.equal(result.replayed, false);
  assert.equal(fake.pipelineCalls.length, 2);
});

test("a releaser called twice frees only its own slot", () => {
  const limiter = new RetryLimiter(2);
  const release = limiter.acquire();
  limiter.acquire();
  release();
  release();
  limiter.acquire();
  assert.throws(() => limiter.acquire(), /2 retries are already running/);
});

test("only one retry of the same original runs at a time, including through its retries", async () => {
  seed("orig");
  seed("first-retry", { retryOf: "orig", userPhoto: undefined, replayInput: undefined });
  const fake = fakeDependencies();
  const held = holdPipeline(fake);

  const first = retryLastMileTest(retryRequest("orig", "fresh"), fake.dependencies);
  await settle();

  const again = await retryError(retryLastMileTest(retryRequest("orig", "original"), fake.dependencies));
  assert.equal(again.status, 409);
  assert.equal(again.code, "original_retry_running");
  const viaRetry = await retryError(retryLastMileTest(retryRequest("first-retry", "fresh"), fake.dependencies));
  assert.equal(viaRetry.code, "original_retry_running");

  held.release();
  await first;
  await retryLastMileTest(retryRequest("orig", "fresh"), fake.dependencies);
  assert.equal(fake.pipelineCalls.length, 2);
});

test("re-sending a running key reports it in progress without a second run", async () => {
  seed("orig");
  const fake = fakeDependencies();
  const held = holdPipeline(fake);

  const request = retryRequest("orig", "fresh");
  const first = retryLastMileTest(request, fake.dependencies);
  await settle();
  const resent = await retryError(retryLastMileTest(request, fake.dependencies));
  assert.equal(resent.status, 409);
  assert.equal(resent.code, "retry_in_progress");

  held.release();
  await first;
  assert.equal(fake.pipelineCalls.length, 1);
});

test("re-sending a finished key returns the same result without running again", async () => {
  seed("orig");
  const fake = fakeDependencies();
  const request = retryRequest("orig", "fresh");

  const first = await retryLastMileTest(request, fake.dependencies);
  const second = await retryLastMileTest(request, fake.dependencies);

  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.equal(second.testLogId, first.testLogId);
  assert.deepEqual(second.defaultsApplied, first.defaultsApplied);
  assert.equal(second.log?.panoId, "pano-fresh");
  assert.equal(fake.pipelineCalls.length, 1);
});

test("re-sending a key whose run failed returns the same failure without running again", async () => {
  seed("orig");
  let checks = 0;
  const fake = fakeDependencies({
    fetchPanoramaById: async () => {
      checks += 1;
      throw new Error("socket hang up");
    },
  });
  const request = retryRequest("orig", "original");

  const first = await retryError(retryLastMileTest(request, fake.dependencies));
  const second = await retryError(retryLastMileTest(request, fake.dependencies));
  assert.equal(first.status, 502);
  assert.equal(second.status, 502);
  assert.equal(second.message, first.message);
  assert.equal(checks, 1);
});

test("an unexpected pipeline error is saved for the key as a generic 500", async () => {
  seed("orig");
  const fake = fakeDependencies({
    runLastMeters: async () => {
      throw new Error("OpenAI exploded");
    },
  });
  const request = retryRequest("orig", "fresh");
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    const first = await retryError(retryLastMileTest(request, fake.dependencies));
    assert.equal(first.status, 500);
    assert.doesNotMatch(first.message, /exploded/);
    assert.equal((await retryError(retryLastMileTest(request, fake.dependencies))).status, 500);
  } finally {
    console.error = originalConsoleError;
  }
  assert.equal(memoryRetryRuns.get(request.idempotencyKey)?.status, "failed");
});

test("a key reused for a different test or mode is refused", async () => {
  seed("orig");
  seed("other");
  const fake = fakeDependencies();
  const request = retryRequest("orig", "fresh");
  await retryLastMileTest(request, fake.dependencies);

  const otherMode = await retryError(retryLastMileTest({ ...request, panoramaMode: "original" }, fake.dependencies));
  assert.equal(otherMode.status, 422);
  assert.equal(otherMode.code, "idempotency_key_reused");
  const otherTest = await retryError(retryLastMileTest({ ...request, id: "other" }, fake.dependencies));
  assert.equal(otherTest.status, 422);
  assert.equal(fake.pipelineCalls.length, 1);
});

test("a refusal before the run starts does not use up the key", async () => {
  seed("orig");
  delete process.env.OPENAI_API_KEY;
  const fake = fakeDependencies();
  const request = retryRequest("orig", "fresh");
  assert.equal((await retryError(retryLastMileTest(request, fake.dependencies))).status, 503);

  process.env.OPENAI_API_KEY = "test-openai-key";
  assert.equal((await retryLastMileTest(request, fake.dependencies)).replayed, false);
});

test("a run cut off by a restart frees its original once the lease runs out", async () => {
  seed("orig");
  const staleKey = v7();
  const longAgo = Date.now() - RETRY_LEASE_MS - 1000;
  memoryRetryRuns.set(staleKey, {
    _id: staleKey,
    requestedId: "orig",
    originalId: "orig",
    panoramaMode: "fresh",
    status: "running",
    startedAt: new Date(longAgo),
    leaseExpiresAt: new Date(longAgo + RETRY_LEASE_MS),
  });
  const fake = fakeDependencies();

  await retryLastMileTest(retryRequest("orig", "fresh"), fake.dependencies);
  assert.equal(fake.pipelineCalls.length, 1);

  const stale = await retryError(retryLastMileTest(retryRequest("orig", "fresh", staleKey), fake.dependencies));
  assert.equal(stale.status, 500);
  assert.equal(stale.code, "retry_interrupted");
  assert.equal(fake.pipelineCalls.length, 1);
});

test("running retries are reported by original while their lease holds", async () => {
  const now = Date.now();
  await lastMileRetryRunService.claim({ _id: v7(), requestedId: "r", originalId: "orig", panoramaMode: "original" }, now);
  const running = await lastMileRetryRunService.running(["orig", "other"], now);
  assert.deepEqual([...running.keys()], ["orig"]);
  assert.equal(running.get("orig")?.panoramaMode, "original");
  assert.equal((await lastMileRetryRunService.running(["orig"], now + RETRY_LEASE_MS)).size, 0);
});

test("a renewed lease keeps a slow run live past its first lease", async () => {
  const key = v7();
  const now = Date.now();
  await lastMileRetryRunService.claim({ _id: key, requestedId: "orig", originalId: "orig", panoramaMode: "fresh" }, now);
  assert.equal(await lastMileRetryRunService.renew(key, now + RETRY_LEASE_MS - 1000), true);

  const later = now + RETRY_LEASE_MS + 1000;
  assert.equal((await lastMileRetryRunService.find(key, later))?.status, "running");
  assert.equal((await lastMileRetryRunService.running(["orig"], later)).size, 1);
});

test("a run marked interrupted keeps that status when it finishes later", async () => {
  const key = v7();
  const now = Date.now();
  await lastMileRetryRunService.claim({ _id: key, requestedId: "orig", originalId: "orig", panoramaMode: "fresh" }, now);
  const later = now + RETRY_LEASE_MS + 1000;
  assert.equal((await lastMileRetryRunService.find(key, later))?.errorCode, "retry_interrupted");

  assert.equal(await lastMileRetryRunService.renew(key, later), false);
  assert.equal(
    await lastMileRetryRunService.finish(key, { status: "succeeded", testLogId: "retry-1", defaultsApplied: [] }, later),
    false
  );
  const run = await lastMileRetryRunService.find(key, later);
  assert.equal(run?.status, "failed");
  assert.equal(run?.errorCode, "retry_interrupted");
  assert.equal(run?.testLogId, undefined);
});

test("a run's lease is renewed while its work runs and no longer after", async () => {
  const renewed: string[] = [];
  const runs = {
    renew: async (key: string) => {
      renewed.push(key);
      return true;
    },
  };
  const result = await withRenewedLease(
    runs,
    "key",
    () => new Promise<string>((resolve) => setTimeout(() => resolve("done"), 40)),
    5
  );
  assert.equal(result, "done");
  assert.ok(renewed.length >= 2, `expected the lease to be renewed, got ${renewed.length} renewals`);

  const afterWork = renewed.length;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(renewed.length, afterWork);
});

test("a run's lease is no longer renewed once its work fails", async () => {
  let renewals = 0;
  const runs = {
    renew: async () => {
      renewals += 1;
      return true;
    },
  };
  await assert.rejects(
    withRenewedLease(runs, "key", () => new Promise((_, reject) => setTimeout(() => reject(new Error("boom")), 20)), 5),
    /boom/
  );
  const afterWork = renewals;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(renewals, afterWork);
});

test("idempotency keys must be UUIDv7", () => {
  const key = v7();
  assert.equal(parseIdempotencyKey(` ${key.toUpperCase()} `), key);
  assert.equal(parseIdempotencyKey(v4()), undefined);
  assert.equal(parseIdempotencyKey("not-a-key"), undefined);
  assert.equal(parseIdempotencyKey([key]), undefined);
  assert.equal(parseIdempotencyKey(undefined), undefined);
});

test("a retry leaves the original trial unchanged", async () => {
  seed("orig");
  const before = JSON.stringify(memoryLastMileTests.find((row) => (row as { _id?: string })._id === "orig"));
  await retryLastMileTest(retryRequest("orig", "original"), fakeDependencies().dependencies);
  const after = JSON.stringify(memoryLastMileTests.find((row) => (row as { _id?: string })._id === "orig"));
  assert.equal(after, before);
});

test("a retry whose result was not saved is a 500", async () => {
  seed("orig");
  const fake = fakeDependencies({
    runLastMeters: async () => ({ kind: "response", status: 200, body: {} }),
  });
  const error = await retryError(retryLastMileTest(retryRequest("orig", "fresh"), fake.dependencies));
  assert.equal(error.status, 500);
});

/** Waits long enough for the fake pipeline to attach its panorama. */
const pipelineFinishes = () => new Promise((resolve) => setTimeout(resolve, 20));

test("a retry past its deadline is given up and frees its original for a new retry", async () => {
  seed("orig");
  const fake = fakeDependencies({ maxRunMs: 30 });
  const held = holdPipeline(fake);
  const key = v7();

  const timedOut = await retryError(retryLastMileTest(retryRequest("orig", "fresh", key), fake.dependencies));
  assert.equal(timedOut.status, 504);
  assert.equal(timedOut.code, "retry_timed_out");

  const next = retryLastMileTest(retryRequest("orig", "fresh"), fake.dependencies);
  await settle();
  held.release();
  await next;
  await pipelineFinishes();

  // The given-up run finished late, but its key keeps the saved failure.
  const resent = await retryError(retryLastMileTest(retryRequest("orig", "fresh", key), fake.dependencies));
  assert.equal(resent.code, "retry_timed_out");
  assert.equal(fake.pipelineCalls.length, 2);
});

test("a given-up retry keeps its capacity slot until its calls end", async () => {
  seed("orig");
  seed("other");
  const fake = fakeDependencies({ maxRunMs: 30 }, 1);
  const held = holdPipeline(fake);

  await retryError(retryLastMileTest(retryRequest("orig", "fresh"), fake.dependencies));
  const full = await retryError(retryLastMileTest(retryRequest("other", "fresh"), fake.dependencies));
  assert.equal(full.code, "retry_capacity");

  held.release();
  await pipelineFinishes();
  await retryLastMileTest(retryRequest("other", "fresh"), fake.dependencies);
});

test("OpenAI calls give up after 90 seconds per attempt and two retries instead of the library's half hour", () => {
  const client = getOpenAIClient();
  assert.equal(client.timeout, 90_000);
  assert.equal(client.maxRetries, 2);
});

test("a retry links to the stored id, however the request spelled it", async () => {
  // Mongo finds an ObjectId in either letter case, so the request's spelling
  // must not reach the per-original lock or the retryOf link.
  const _id = new mongoose.Types.ObjectId();
  const { originalId } = await findOriginal({ _id } as unknown as lastMileTestLogInterface);
  assert.equal(originalId, _id.toHexString());
});

// The endpoint itself. Only refusals are exercised here, since an accepted
// retry would run the real pipeline.

function fakeExchange(id: string, body: unknown, headers: Record<string, string> = {}) {
  headers = { "idempotency-key": v7(), ...headers };
  const req = { params: { id }, body, headers, query: {} } as unknown as Request;
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    setHeader(name: string, value: string) {
      this.headers[name] = value;
    },
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

test("a dashboard request whose handler fails is answered with a 500, not left to crash the server", async () => {
  const { req, res } = fakeExchange("orig", {});
  const logged = console.error;
  console.error = () => {};
  try {
    asyncRoute(async () => {
      throw new Error("database unreachable");
    })(req, res as unknown as Response);
    await settle();
  } finally {
    console.error = logged;
  }
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, { error: "The request failed. Check the server logs." });
});

test("a handler that fails after answering is not answered twice", async () => {
  const { req, res } = fakeExchange("orig", {});
  const sent = Object.assign(res, { headersSent: true });
  const logged = console.error;
  console.error = () => {};
  try {
    asyncRoute(async () => {
      throw new Error("failed after answering");
    })(req, sent as unknown as Response);
    await settle();
  } finally {
    console.error = logged;
  }
  assert.equal(res.statusCode, 0);
});

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

test("the retry endpoint requires a UUIDv7 idempotency key", async () => {
  seed("orig");
  for (const key of ["", v4()]) {
    const { req, res } = fakeExchange("orig", { panoramaMode: "fresh" }, { "x-admin-token": "secret", "idempotency-key": key });
    await controller.retry(req, res as unknown as Response);
    assert.equal(res.statusCode, 400);
    assert.equal((res.body as { code?: string }).code, "idempotency_key_required");
  }
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
  // Names the key the server reads first, not only the fallback.
  assert.match(String((unavailable.res.body as { error?: string }).error), /GOOGLE_MAPS_API_KEY/);
});

test("every read reports a retry with the photo of the original it ran on", async () => {
  seed("orig");
  seed("retry-a", { userPhoto: undefined, retryOf: "orig", retryPanoramaMode: "fresh" });

  // A single-trial read doesn't copy the photo; the detail fills it from the
  // original it loads for the history anyway.
  assert.equal((await lastMileTestLogService.getById("retry-a"))?.userPhoto, undefined);
  const detail = fakeExchange("retry-a", undefined, { "x-admin-token": "secret" });
  (detail.req as unknown as { query: Record<string, string> }).query = { includeImages: "true" };
  await controller.getOne(detail.req, detail.res as unknown as Response);
  assert.equal((detail.res.body as { data: { userPhoto: string } }).data.userPhoto, PHOTO);
  const lean = fakeExchange("retry-a", undefined, { "x-admin-token": "secret" });
  await controller.getOne(lean.req, lean.res as unknown as Response);
  assert.equal((lean.res.body as { data: { hasUserPhoto: boolean } }).data.hasUserPhoto, true);
  const full = (await lastMileTestLogService.getData(10, undefined, true)).data;
  assert.equal(full.find((row) => (row as { _id?: string })._id === "retry-a")?.userPhoto, PHOTO);
  const summary = (await lastMileTestLogService.getSummaries(10, undefined, true)).data.find(
    (row) => (row as { _id?: string })._id === "retry-a"
  );
  assert.equal(summary?.imageStats.userPhoto.stored, true);
  assert.equal(summary?.userPhotoReplayable, true);

  const list = fakeExchange("", undefined, { "x-admin-token": "secret" });
  (list.req as unknown as { query: Record<string, string> }).query = { includeRetries: "true" };
  await controller.list(list.req, list.res as unknown as Response);
  const rows = (list.res.body as { data: { _id: string; hasUserPhoto: boolean; userPhoto: string }[] }).data;
  const listed = rows.find((row) => row._id === "retry-a");
  assert.equal(listed?.hasUserPhoto, true);
  assert.equal(listed?.userPhoto, `[base64 image ${PHOTO.length} chars]`);

  // The photo is read from the original, never copied onto the retry's log.
  const stored = memoryLastMileTests.find((row) => (row as { _id?: string })._id === "retry-a");
  assert.equal(stored?.userPhoto, undefined);
});

test("the CSV export includes a retry's photo", async () => {
  seed("orig");
  seed("retry-a", { userPhoto: undefined, retryOf: "orig", retryPanoramaMode: "fresh" });
  const { req, res } = fakeExchange("", undefined, { "x-admin-token": "secret" });
  (req as unknown as { query: Record<string, string> }).query = { includeRetries: "true" };
  let csv = "";
  const csvRes = Object.assign(res, {
    send(payload: string) {
      csv = payload;
      return this;
    },
  });
  await controller.exportCsv(req, csvRes as unknown as Response);
  // One photo placeholder for the original and one for its retry.
  const placeholder = `[base64 image ${PHOTO.length} chars]`;
  assert.equal(csv.split(placeholder).length - 1, 2);
});

test("a proxied log's fields and its replay input come from the same parsed request", () => {
  const parsed = parseLastMetersRequest({ destination: "  CVS  ", lat: 40.7128, lng: -74.006, heading: 92.5, gpsAccuracyMeters: 6 });
  assert.ok(parsed);
  const fields = proxiedRequestFields(parsed, PHOTO, RECEIVED_AT);
  assert.equal(fields.destination, "CVS");
  assert.equal(fields.replayInput.destination, fields.destination);
  assert.equal(fields.replayInput.lat, fields.lat);
  assert.equal(fields.replayInput.lng, fields.lng);
  assert.equal(fields.replayInput.heading, fields.deviceHeading);
  assert.equal(fields.replayInput.gpsAccuracyMeters, fields.gpsAccuracyMeters);
});

test("a proxied run is labeled upstream, not with this server's version and commit", async () => {
  const savedCommits = { RENDER_GIT_COMMIT: process.env.RENDER_GIT_COMMIT, GIT_COMMIT: process.env.GIT_COMMIT };
  delete process.env.RENDER_GIT_COMMIT;
  process.env.GIT_COMMIT = "this-server-commit";
  const log = {
    destination: request.destination,
    lat: request.lat,
    lng: request.lng,
    userPhoto: "stored-photo",
    panoramaHeadings: [],
    steps: [],
    success: true,
    latencyMs: 1000,
  };
  try {
    const localId = await lastMileTestLogService.record(log);
    const proxiedId = await lastMileTestLogService.recordProxied(log);
    const stored = (id: string | undefined) =>
      memoryLastMileTests.find((row) => (row as { _id?: string })._id === id);

    assert.equal(stored(localId)?.pipelineVersion, LAST_MILE_PIPELINE_VERSION);
    assert.equal(stored(localId)?.deployedCommit, "this-server-commit");
    assert.equal(stored(proxiedId)?.pipelineVersion, UPSTREAM_PIPELINE_VERSION);
    assert.equal(stored(proxiedId)?.deployedCommit, undefined);
  } finally {
    for (const [name, value] of Object.entries(savedCommits)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("the evaluation scores up to the limit in field tests however many retries ran", async () => {
  seed("field-old");
  seed("field-new");
  for (const id of ["retry-1", "retry-2", "retry-3"]) {
    seed(id, { userPhoto: undefined, retryOf: "field-new", runKind: "replay" });
  }
  const { req, res } = fakeExchange("", undefined, { "x-admin-token": "secret" });
  (req as unknown as { query: Record<string, string> }).query = { limit: "2" };
  await controller.evaluation(req, res as unknown as Response);

  const body = res.body as { replayCount: number; sampledTrials: number; groups: { trials: number }[] };
  assert.equal(body.sampledTrials, 2);
  assert.equal(body.groups.reduce((sum, group) => sum + group.trials, 0), 2);
  assert.equal(body.replayCount, 3);
});
