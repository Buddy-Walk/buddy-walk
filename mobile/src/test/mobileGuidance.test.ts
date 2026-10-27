import assert from "node:assert/strict";
import test from "node:test";
import axios from "axios";
import OpenAI from "openai";
import sharp from "sharp";
import { MobileLastMetersService, mobileReviewPanoramaStatus } from "../../server/services/mobileLastMeters";
import { lastMetersTestLogService } from "../../server/services/lastMetersTestLog";
import { buildReplayInput, type LastMetersRequestInput } from "../../server/utils/lastMetersReplay";
import { mobileResponseSensorReasons } from "../utils/mobileLastMetersGuidance";
import { setTestEnv } from "./testEnv";

/** Produce a valid request without assuming Google's optional entrance listing exists. */
function capture(now: number): LastMetersRequestInput {
  return {
    lat: 40.7, lng: -74, destination: "McDonald's", deviceHeading: 90,
    gpsAccuracyMeters: 14, compassAccuracyLevel: 2,
    sensors: {
      photoCapturedAt: now, positionTimestamp: now, headingTimestamp: now, headingReference: "true",
      latestPosition: { lat: 40.7, lng: -74, accuracy: 14, timestamp: now },
      latestHeading: 90, latestHeadingTimestamp: now, latestHeadingReference: "true",
    },
  };
}

for (const scenario of [
  "ordinary storefront", "processing delay", "GPS jitter", "turned since capture", "moved since capture", "poor GPS",
  "missing sensors", "missing compass", "no panorama", "indoor panorama", "no visual match", "unmatched photo", "conflicting heading",
  "retry", "pinned panorama",
] as const) {
  test(`mobile guidance runs the real pipeline: ${scenario}`, async t => {
    // Exercise real place selection, panorama validation, image matching, logging, and HTTP delivery.
    // Restored afterwards for the remaining shared/retry tests.
    setTestEnv(t, { GOOGLE_MAPS_API_KEY: "test-maps", OPENAI_API_KEY: "test-openai" });
    let clock = Date.now();
    const submittedAt = clock;
    t.mock.method(Date, "now", () => clock);
    const request = capture(clock);
    if (["missing sensors", "retry", "pinned panorama"].includes(scenario)) request.sensors = undefined;
    if (scenario === "missing compass") request.deviceHeading = undefined;
    if (scenario === "turned since capture") request.sensors!.latestHeading = 180;
    if (scenario === "moved since capture") request.sensors!.latestPosition.lat += 0.001;
    if (scenario === "GPS jitter") request.sensors!.latestPosition.lat += 0.00007;
    if (scenario === "poor GPS") {
      request.gpsAccuracyMeters = 45;
      request.sensors!.latestPosition.accuracy = 45;
    }
    const originalRequest = structuredClone(request);
    const pixels = Buffer.alloc(640 * 640 * 3);
    for (let i = 0; i < pixels.length; i++) pixels[i] = (i * 13 + Math.floor(i / 19)) % 256;
    const jpeg = await sharp(pixels, { raw: { width: 640, height: 640, channels: 3 } }).jpeg().toBuffer();
    const photo = `data:image/jpeg;base64,${jpeg.toString("base64")}`;
    let providerCalls = 0;
    let panoramaCalls = 0;
    let guidanceCalls = 0;
    t.mock.method(axios, "get", async (url: string) => {
      // Replace all external providers, while keeping the production pipeline's decisions intact.
      providerCalls++;
      if (url.includes("nearbysearch")) return { data: { status: "OK", results: [{
        place_id: "mcdonalds", name: "McDonald's", vicinity: "10 Test Street",
        geometry: { location: { lat: 40.70045, lng: -74 } }, types: ["restaurant"],
      }] } };
      if (url.includes("geocode")) return { data: { status: "ZERO_RESULTS" } };
      if (url.includes("directions")) return { data: { status: "REQUEST_DENIED" } };
      if (url.endsWith("/metadata")) {
        panoramaCalls++;
        return { data: scenario === "no panorama" ? { status: "ZERO_RESULTS" } : {
          status: "OK", pano_id: "outdoor-fixture", copyright: "Google", date: "2025-01",
          location: { lat: 40.7, lng: -74 },
        } };
      }
      if (url.includes("streetview")) return { status: 200, data: jpeg };
      assert.fail(`Unexpected provider call: ${url}`);
    });
    const service = new MobileLastMetersService();
    t.mock.method(OpenAI.Chat.Completions.prototype, "create", async (input: any) => {
      // Supply controlled visual evidence, never a model-authored turn angle.
      const prompt = input.messages[0].content as string;
      let text: string;
      if (prompt.startsWith("Classify the CAMERA")) text = scenario === "indoor panorama" ? "INDOOR" : "OUTDOOR";
      else if (prompt.includes("Find the storefront, sign, or entrance")) text = scenario === "no visual match" ? "NOT_VISIBLE" : "0";
      else if (prompt.includes("center of the user's photo")) text = scenario === "unmatched photo"
        ? "NOT_VISIBLE" : scenario === "conflicting heading" ? "270" : "90";
      else if (prompt.includes("destination-focused Street View image for")) text = "NOT_VISIBLE";
      else if (prompt.includes("Transcribe the business names")) text = "NO_TEXT";
      else if (prompt.includes("orientation assistant for a blind pedestrian")) {
        assert.match(prompt, /phone may have turned after this photo/);
        assert.match(prompt, /Do not give left\/right or clock-face directions/);
        guidanceCalls++;
        if (scenario === "processing delay") clock += 70_000;
        text = "A recessed doorway is on the brick wall in your photo.";
      } else assert.fail(`Unexpected visual prompt: ${prompt}`);
      return { choices: [{ message: { content: text! } }], usage: { total_tokens: 10 } };
    });
    let logged: any;
    t.mock.method(lastMetersTestLogService, "record", async (row: any) => {
      // Observe the actual recorded inputs and outcome without creating a production trial.
      logged = row;
      return "mobile-guidance-trial";
    });
    let attachment: any;
    t.mock.method(lastMetersTestLogService, "attachPanorama", async (_id: string, value: any) => {
      // Observe the inherited background saver without using real storage.
      attachment = value;
    });
    let answer: any;
    if (scenario === "retry" || scenario === "pinned panorama") {
      const result = await service.runLastMeters(request, photo, scenario === "retry" ? {
        retry: { retryOf: "original", panoramaMode: "fresh", defaultsApplied: [],
          replayInput: buildReplayInput(request, photo, clock) },
      } : { pinnedPanorama: { status: "OK", pano_id: "original-pano" } });
      assert.equal(result.kind, "response");
      if (result.kind !== "response") return;
      answer = result.body;
      assert.equal(providerCalls, 0, "Retries and pinned runs keep the original initial gate");
      assert.deepEqual(answer.safetyReasons, ["capture_metadata_missing"]);
      assert.equal(answer.guidanceKind, "withheld");
      return;
    }
    const res = {
      /** Preserve Express response chaining. */
      status: () => res,
      /** Capture what the native client actually receives. */
      json: (body: any) => { answer = body; },
    };
    await service.lastMetersRequest({ res } as any, request, photo, "/api/last-meters");
    assert.ok(panoramaCalls > 0, "Sensor imperfections must not prevent the panorama search");
    assert.equal(answer.testLogId, "mobile-guidance-trial");
    assert.equal(logged.runKind, "field");
    assert.deepEqual(request, originalRequest, "Do not invent or replace capture evidence");
    assert.deepEqual(logged.replayInput.sensors, originalRequest.sensors);
    const success = ["ordinary storefront", "processing delay", "GPS jitter", "turned since capture"].includes(scenario);
    if (success) {
      assert.equal(logged.success, true);
      assert.equal(guidanceCalls, 1, "The final guidance stage must actually run");
      assert.match(answer.output, scenario === "turned since capture" ? /Turn around 180 degrees/i : /90 degrees to your left/i);
      assert.match(answer.output, /recessed doorway/i);
      assert.match(answer.output, /Turn in place only/);
      assert.equal(answer.targetHeading, 0);
      assert.equal(logged.entranceSource, "places_pin");
      assert.equal(logged.walkingEvidence.verified, false);
      assert.equal(logged.compassAccuracyLevel, 2);
      assert.equal(logged.deviceHeading, 90, "The capture-time compass evidence is preserved");
      assert.equal(answer.currentHeading, scenario === "turned since capture" ? 180 : 90);
      if (scenario === "processing delay") {
        const live = structuredClone(request.sensors!);
        live.latestPosition.timestamp = clock;
        live.latestHeadingTimestamp = clock;
        assert.deepEqual(mobileResponseSensorReasons(answer, live, request, request.deviceHeading,
          request.gpsAccuracyMeters, submittedAt, clock), []);
      }
    } else {
      assert.equal(guidanceCalls, 0);
      assert.equal(answer.guidanceKind, "withheld");
      assert.equal(answer.targetHeading, null);
      assert.match(answer.output, /McDonald's/);
      assert.doesNotMatch(answer.output, /Turn \d+ degrees/i);
      if (["moved since capture", "poor GPS", "missing sensors", "missing compass"].includes(scenario)) {
        assert.match(logged.panoramaPhoto, /^data:image\/jpeg;base64,/);
        assert.match(answer.output, /10 Test Street/);
        assert.match(answer.output, /150 feet/);
        assert.doesNotMatch(answer.output, /^I cannot verify your current position/);
      }
      if (scenario === "no panorama" || scenario === "indoor panorama") assert.equal(logged.panoramaPhoto, undefined);
    }
  });
}

test("mobile speech checks preserve factual answers and detect actual movement before precise turns", () => {
  // Separate capture validity at submission from current orientation at speech, using realistic GPS jitter.
  const submittedAt = 1_800_000_000_000;
  const request = capture(submittedAt);
  const now = submittedAt + 70_000;
  const sensors = structuredClone(request.sensors!);
  sensors.latestPosition.timestamp = now;
  sensors.latestHeadingTimestamp = now;
  const check = (answer: { targetHeading?: number | null; currentHeading?: number; guidanceKind?: string }) =>
    mobileResponseSensorReasons(answer, sensors, request, request.deviceHeading, request.gpsAccuracyMeters, submittedAt, now);
  assert.deepEqual(check({ targetHeading: 0 }), [], "Time spent processing cannot invalidate a steady capture");
  sensors.latestHeading = 180;
  assert.ok(check({ targetHeading: 0 }).includes("turned_since_capture"));
  assert.deepEqual(check({ targetHeading: 0, currentHeading: 180 }), [], "Use the current heading the server actually used for the turn");
  sensors.latestHeading = 270;
  assert.ok(check({ targetHeading: 0, currentHeading: 180 }).includes("turned_since_capture"));
  assert.deepEqual(check({ targetHeading: null, guidanceKind: "withheld" }), []);
  assert.deepEqual(check({}), [], "Approach and descriptive answers have no precise turn to suppress");
  sensors.latestHeading = 90;
  sensors.latestPosition.lat += 0.00007;
  assert.deepEqual(check({ targetHeading: 0 }), [], "GPS jitter within reported accuracy is not proven movement");
  sensors.latestPosition.lat += 0.001;
  assert.ok(check({ targetHeading: 0 }).includes("moved_since_capture"));
});

test("mobile status identifies the new field policy and configured provider capability", t => {
  // Check deployment identity without accessing provider accounts or creating a trial.
  const keys = ["OPENAI_API_KEY", "GOOGLE_MAPS_API_KEY", "GOOGLE_API_KEY", "RENDER_GIT_COMMIT"];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  t.after(() => {
    // Restore all fixture environment values.
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  });
  process.env.OPENAI_API_KEY = "fixture-openai";
  process.env.GOOGLE_MAPS_API_KEY = "fixture-maps";
  process.env.RENDER_GIT_COMMIT = "mobile-guidance-fixture";
  assert.deepEqual(mobileReviewPanoramaStatus(), {
    version: "2.0.0", deployedCommit: "mobile-guidance-fixture", enabled: true,
  });
  delete process.env.GOOGLE_MAPS_API_KEY;
  delete process.env.GOOGLE_API_KEY;
  assert.equal(mobileReviewPanoramaStatus().enabled, false);
});
