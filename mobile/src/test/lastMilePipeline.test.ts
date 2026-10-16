import assert from "node:assert/strict";
import test from "node:test";
import axios from "axios";
import sharp from "sharp";
import { OpenAIService } from "../../server/services/openAI";
import { lastMileTestLogService } from "../../server/services/lastMileTestLog";

for (const scenario of ["conflict", "stale", "second-panorama", "parallel-fallback", "verified-turn", "detour", "low-confidence", "ambiguous"] as const) {
  test(`Last Meters integration: ${scenario}`, async t => {
    // Regression test: Last Meters integration: ${scenario}.
    const oldKey = process.env.GOOGLE_MAPS_API_KEY;
    process.env.GOOGLE_MAPS_API_KEY = "unit-test";
    t.after(() => {
      // Restore the Maps credential after the scenario so later tests do not inherit fixture
      // configuration.
      if (oldKey === undefined) delete process.env.GOOGLE_MAPS_API_KEY;
      else process.env.GOOGLE_MAPS_API_KEY = oldKey;
    });
    const pixels = Buffer.alloc(640 * 640 * 3);
    for (let i = 0; i < pixels.length; i++) pixels[i] = (i * 13 + Math.floor(i / 19)) % 256;
    const jpeg = await sharp(pixels, { raw: { width: 640, height: 640, channels: 3 } }).jpeg().toBuffer();
    assert.ok(jpeg.length > 10000);
    let lookups = 0;
    t.mock.method(axios, "get", async (url: string, options: any) => {
      // Provide scenario-specific Places, building, walking-route, and panorama responses
      // without contacting external providers.
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
    const service = new OpenAIService();
    (service as any)._client = { chat: { completions: { create: async (request: any) => {
      // Return deterministic model stage results and assert the intended orientation/target and
      // sign/reference concurrency.
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
    } } } };
    let logged: any;
    t.mock.method(lastMileTestLogService, "record", async (row: any) => { /* Capture the pipeline trial evidence and return a stable fixture record ID. */  logged = row; return "trial-test"; });
    let answer: any;
    const res = { status: /* Keep the HTTP response stub chainable for status().json(). */ () => res, json: (body: any) => { /* Capture the final response for scenario-specific guidance and safety assertions. */  answer = body; } };
    const now = Date.now();
    await service.lastMileRequest({ res } as any, 40.7, -74, `data:image/jpeg;base64,${jpeg.toString("base64")}`, "Citi", 90, 14, 3, {
      photoCapturedAt: now, positionTimestamp: now, headingTimestamp: now, headingReference: "true",
      latestPosition: { lat: 40.7, lng: -74, accuracy: 14, timestamp: now },
      latestHeading: 90, latestHeadingTimestamp: now, latestHeadingReference: "true",
    });
    assert.equal(answer.testLogId, "trial-test");
    assert.equal(logged.runKind, "field");
    assert.equal(logged.replayInput.sensors?.photoCapturedAt, now);
    if (["verified-turn", "detour", "low-confidence", "ambiguous"].includes(scenario)) {
      if (scenario === "verified-turn") {
        assert.equal(guidanceCalls, 1);
        assert.match(logged.turnInstruction, /90 degrees.*LEFT/i);
        assert.equal(logged.targetHeading, 0);
        assert.equal(logged.panoramaTargetHeading, 0);
        assert.equal(answer.guidanceKind, "orientation");
      } else {
        assert.equal(guidanceCalls, 0);
        assert.equal(logged.turnInstruction, undefined);
        assert.equal(answer.guidanceKind, "withheld");
        assert.ok(logged.safetyReasons.length);
        if (scenario === "ambiguous") assert.equal(lookups, 0);
      }
      return;
    }
    assert.equal(referenceCalls, scenario === "parallel-fallback" ? 1 : 0, "Only recent imagery should call Step 2B");
    if (scenario === "conflict") {
      assert.equal(answer.warning, "heading_sources_disagree");
      assert.equal(answer.guidanceKind, "withheld");
      assert.equal(logged.turnInstruction, undefined);
      assert.equal(signCalls, 0);
    } else if (scenario === "parallel-fallback") {
      assert.equal(signCalls, 1);
      assert.equal(logged.destinationReferenceUsed, true);
      assert.equal(logged.turnInstruction, undefined);
      assert.ok(logged.safetyReasons.includes("entrance_not_listed"));
    } else {
      assert.ok(signCalls > 0, "Stale imagery must still get Step 2C");
      assert.ok(logged.steps.some(/* Find the stage that explicitly skipped an over-age destination reference. */ (s: any) => s.response === "SKIPPED: stale_imagery"));
      if (scenario === "second-panorama") {
        assert.equal(logged.panoId, "second");
        assert.deepEqual(logged.steps.filter(/* Select target-matching stages so distinct panorama attempts can be checked. */ (s: any) => s.name === "target_store_match").map(/* Read the panorama ID associated with each target-matching attempt. */ (s: any) => s.panoId), ["first", "second"]);
        assert.ok(logged.panoramaValidation.some(/* Confirm that the rejected first panorama retained a destination-not-visible audit entry. */ (a: any) => a.status === "destination_not_visible"));
      }
    }
  });
}
