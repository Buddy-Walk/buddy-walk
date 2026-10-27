import assert from "node:assert/strict";
import test from "node:test";
import axios from "axios";
import OpenAI from "openai";
import sharp from "sharp";
import { LastMetersService } from "../../server/services/lastMetersService";
import { lastMetersTestLogService } from "../../server/services/lastMetersTestLog";
import { setTestEnv } from "./testEnv";

for (const scenario of ["conflict", "stale", "second-panorama", "parallel-fallback", "verified-turn", "detour", "low-confidence", "ambiguous", "missing-sensors"] as const) {
  test(`Last Meters integration: ${scenario}`, async t => {
    setTestEnv(t, { GOOGLE_MAPS_API_KEY: "unit-test", OPENAI_API_KEY: "unit-test" });
    const pixels = Buffer.alloc(640 * 640 * 3);
    for (let i = 0; i < pixels.length; i++) pixels[i] = (i * 13 + Math.floor(i / 19)) % 256;
    const jpeg = await sharp(pixels, { raw: { width: 640, height: 640, channels: 3 } }).jpeg().toBuffer();
    assert.ok(jpeg.length > 10000);
    let lookups = 0;
    t.mock.method(axios, "get", async (url: string, options: any) => {
      if (url.includes("nearbysearch")) {
        const place = { place_id: "citi", name: "Citi", vicinity: "Test Street", geometry: { location: { lat: 40.70045, lng: -74 } }, types: ["bank"] };
        return { data: { status: "OK", results: scenario === "ambiguous" ? [place, { ...place, place_id: "citi-two", vicinity: "Other Street" }] : [place] } };
      }
      if (url.includes("geocode")) return ["verified-turn", "detour", "low-confidence"].includes(scenario)
        ? { data: { status: "OK", results: [{ buildings: [{ place_id: "citi" }], entrances: [{ location: { lat: 40.70045, lng: -74 }, building_place_id: "citi" }] }] } }
        : { data: { status: "ZERO_RESULTS" } };
      if (url.includes("directions")) return { data: { status: "OK", routes: [{ legs: [{
        start_location: { lat: 40.7, lng: -74 }, end_location: { lat: 40.70045, lng: -74 },
        distance: { value: scenario === "detour" ? 300 : 50 }, steps: [{ travel_mode: "WALKING", start_location: { lat: 40.7, lng: -74 }, end_location: { lat: 40.70045, lng: -74 } }],
      }] }] } };
      if (url.endsWith("/metadata")) {
        lookups++;
        return { data: { status: "OK", pano_id: scenario === "second-panorama" && lookups >= 3 ? "second" : "first", copyright: "Google", date: ["parallel-fallback", "verified-turn", "detour", "low-confidence"].includes(scenario) ? "2025-01" : "2016-01", location: { lat: 40.7, lng: -74 } } };
      }
      if (url.includes("streetview")) return { status: 200, data: jpeg };
      throw new Error(`Unexpected request: ${url}`);
    });
    let targetCalls = 0;
    let currentCalls = 0;
    let referenceCalls = 0;
    let signCalls = 0;
    let guidanceCalls = 0;
    const service = new LastMetersService();
    t.mock.method(OpenAI.Chat.Completions.prototype, "create", async (request: any) => {
      const prompt = request.messages[0].content as string;
      let text = "NOT_VISIBLE";
      if (prompt.startsWith("Classify the CAMERA")) text = "OUTDOOR";
      else if (prompt.includes("Find the storefront, sign, or entrance")) {
        targetCalls++;
        text = (scenario === "second-panorama" && targetCalls === 2) || ["verified-turn", "detour", "low-confidence"].includes(scenario) ? "0" : "NOT_VISIBLE";
      } else if (prompt.includes("center of the user's photo")) {
        currentCalls++;
        assert.equal(targetCalls, currentCalls, "Step 2 must start before awaiting Step 1");
        text = scenario === "conflict" ? "270" : scenario === "low-confidence" ? "NOT_VISIBLE" : "90";
      } else if (prompt.includes("destination-focused Street View image for")) {
        referenceCalls++;
        assert.equal(signCalls, 1, "Sign close-up work should already be running");
        text = "VISIBLE";
      }
      else if (prompt.includes("Transcribe the business names")) { signCalls++; text = "NO_TEXT"; }
      else if (prompt.includes("orientation assistant for a blind pedestrian")) { guidanceCalls++; text = "NO_RELIABLE_LANDMARKS"; }
      else assert.fail(`Unexpected prompt: ${prompt}`);
      return { choices: [{ message: { content: text } }], usage: { total_tokens: 10 } };
    });
    let logged: any;
    t.mock.method(lastMetersTestLogService, "record", async (row: any) => { logged = row; return "trial-test"; });
    let answer: any;
    const res = { status: () => res, json: (body: any) => { answer = body; } };
    const now = Date.now();
    await service.lastMetersRequest({ res } as any, { lat: 40.7, lng: -74, destination: "Citi", deviceHeading: 90,
      gpsAccuracyMeters: 14, compassAccuracyLevel: 3, sensors: scenario === "missing-sensors" ? undefined : {
      photoCapturedAt: now, positionTimestamp: now, headingTimestamp: now, headingReference: "true",
      latestPosition: { lat: 40.7, lng: -74, accuracy: 14, timestamp: now },
      latestHeading: 90, latestHeadingTimestamp: now, latestHeadingReference: "true",
    } }, `data:image/jpeg;base64,${jpeg.toString("base64")}`);
    assert.equal(answer.testLogId, "trial-test");
    assert.equal(logged.runKind, "field");
    assert.equal(logged.replayInput.sensors?.photoCapturedAt, scenario === "missing-sensors" ? undefined : now);
    if (["verified-turn", "detour", "low-confidence", "ambiguous", "missing-sensors"].includes(scenario)) {
      if (scenario === "verified-turn") {
        assert.equal(guidanceCalls, 1);
        assert.match(logged.turnInstruction, /90 degrees.*LEFT/i);
        assert.equal(logged.targetHeading, 0);
        assert.equal(logged.panoramaTargetHeading, 0);
      } else {
        assert.equal(guidanceCalls, 0);
        assert.equal(logged.turnInstruction, undefined);
        assert.equal(answer.guidanceKind, "withheld");
        assert.ok(logged.safetyReasons.length);
        if (scenario === "ambiguous" || scenario === "missing-sensors") assert.equal(lookups, 0);
      }
      return;
    }
    assert.equal(referenceCalls, scenario === "parallel-fallback" ? 1 : 0, "Only recent imagery should call Step 2B");
    if (scenario === "conflict") {
      assert.equal(answer.warning, "heading_sources_disagree");
      assert.equal(logged.turnInstruction, undefined);
      assert.equal(signCalls, 0);
    } else if (scenario === "parallel-fallback") {
      assert.equal(signCalls, 1);
      assert.equal(logged.destinationReferenceUsed, true);
      assert.equal(logged.turnInstruction, undefined);
      assert.ok(logged.safetyReasons.includes("entrance_not_listed"));
    } else {
      assert.ok(signCalls > 0, "Stale imagery must still get Step 2C");
      assert.ok(logged.steps.some((s: any) => s.response === "SKIPPED: stale_imagery"));
      if (scenario === "second-panorama") {
        assert.equal(logged.panoId, "second");
        assert.deepEqual(logged.steps.filter((s: any) => s.name === "target_store_match").map((s: any) => s.panoId), ["first", "second"]);
        assert.ok(logged.panoramaValidation.some((a: any) => a.status === "destination_not_visible"));
      }
    }
  });
}

test("Last Meters hands a question to the Question service it was given", async t => {
  t.mock.method(axios, "get", async (url: string) => { throw new Error(`Unexpected request: ${url}`); });
  t.mock.method(lastMetersTestLogService, "record", async () => "trial-question");
  const asked: any[] = [];
  const questionService = { textRequest: async (ctx: any, content: any) => {
    asked.push(content);
    ctx.res.status(200).json({ output: "answered" });
  } };
  const service = new LastMetersService(questionService);
  let answer: any;
  const res = { status: () => res, json: (body: any) => { answer = body; } };
  const now = Date.now();
  await service.lastMetersRequest({ res } as any, { lat: 40.7, lng: -74, destination: "When is the next A train?", deviceHeading: 90,
    gpsAccuracyMeters: 14, compassAccuracyLevel: 3, sensors: {
    photoCapturedAt: now, positionTimestamp: now, headingTimestamp: now, headingReference: "true",
    latestPosition: { lat: 40.7, lng: -74, accuracy: 14, timestamp: now },
    latestHeading: 90, latestHeadingTimestamp: now, latestHeadingReference: "true",
  } }, "data:image/jpeg;base64,photo");
  assert.deepEqual(answer, { output: "answered" });
  assert.deepEqual(asked, [{
    text: "When is the next A train?",
    image: undefined,
    coords: { latitude: 40.7, longitude: -74, accuracy: 14, heading: 90 },
    analytics: { feature: "mta" },
  }]);
});
