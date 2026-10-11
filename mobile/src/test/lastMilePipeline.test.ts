import assert from "node:assert/strict";
import test from "node:test";
import axios from "axios";
import sharp from "sharp";
import { OpenAIService } from "../../server/services/openAI";
import { lastMileTestLogService } from "../../server/services/lastMileTestLog";

for (const scenario of ["conflict", "stale", "second-panorama", "parallel-fallback"] as const) {
  test(`Last Meters integration: ${scenario}`, async t => {
    const oldKey = process.env.GOOGLE_MAPS_API_KEY;
    process.env.GOOGLE_MAPS_API_KEY = "unit-test";
    t.after(() => {
      if (oldKey === undefined) delete process.env.GOOGLE_MAPS_API_KEY;
      else process.env.GOOGLE_MAPS_API_KEY = oldKey;
    });
    const pixels = Buffer.alloc(640 * 640 * 3);
    for (let i = 0; i < pixels.length; i++) pixels[i] = (i * 13 + Math.floor(i / 19)) % 256;
    const jpeg = await sharp(pixels, { raw: { width: 640, height: 640, channels: 3 } }).jpeg().toBuffer();
    assert.ok(jpeg.length > 10000);
    let lookups = 0;
    t.mock.method(axios, "get", async (url: string, options: any) => {
      if (url.includes("nearbysearch")) return { data: { status: "OK", results: [{ place_id: "citi", name: "Citi", vicinity: "Test Street", geometry: { location: { lat: 40.70045, lng: -74 } }, types: ["bank"] }] } };
      if (url.includes("geocode")) return { data: { status: "ZERO_RESULTS" } };
      if (url.endsWith("/metadata")) {
        lookups++;
        return { data: { status: "OK", pano_id: scenario === "second-panorama" && lookups >= 3 ? "second" : "first", copyright: "Google", date: scenario === "parallel-fallback" ? "2025-01" : "2016-01", location: { lat: 40.7, lng: -74 } } };
      }
      if (url.includes("streetview")) return { status: 200, data: jpeg };
      throw new Error(`Unexpected request: ${url}`);
    });
    let targetCalls = 0;
    let currentCalls = 0;
    let referenceCalls = 0;
    let signCalls = 0;
    const service = new OpenAIService();
    (service as any)._client = { chat: { completions: { create: async (request: any) => {
      const prompt = request.messages[0].content as string;
      let text = "NOT_VISIBLE";
      if (prompt.startsWith("Classify the CAMERA")) text = "OUTDOOR";
      else if (prompt.includes("Find the storefront, sign, or entrance")) {
        targetCalls++;
        text = scenario === "second-panorama" && targetCalls === 2 ? "0" : "NOT_VISIBLE";
      } else if (prompt.includes("center of the user's photo")) {
        currentCalls++;
        assert.equal(targetCalls, currentCalls, "Step 2 must start before awaiting Step 1");
        text = scenario === "conflict" ? "270" : "90";
      } else if (prompt.includes("destination-focused Street View image for")) {
        referenceCalls++;
        assert.equal(signCalls, 1, "Sign close-up work should already be running");
        text = "VISIBLE";
      }
      else if (prompt.includes("Transcribe the business names")) { signCalls++; text = "NO_TEXT"; }
      else if (prompt.includes("orientation assistant for a blind pedestrian")) text = "NO_RELIABLE_LANDMARKS";
      else assert.fail(`Unexpected prompt: ${prompt}`);
      return { choices: [{ message: { content: text } }], usage: { total_tokens: 10 } };
    } } } };
    let logged: any;
    t.mock.method(lastMileTestLogService, "record", async (row: any) => { logged = row; return "trial-test"; });
    let answer: any;
    const res = { status: () => res, json: (body: any) => { answer = body; } };
    await service.lastMileRequest({ res } as any, 40.7, -74, `data:image/jpeg;base64,${jpeg.toString("base64")}`, "Citi", 90, 14, 3);
    assert.equal(answer.testLogId, "trial-test");
    assert.equal(referenceCalls, scenario === "parallel-fallback" ? 1 : 0, "Only recent imagery should call Step 2B");
    if (scenario === "conflict") {
      assert.equal(answer.warning, "heading_sources_disagree");
      assert.equal(logged.turnInstruction, undefined);
      assert.equal(signCalls, 0);
    } else if (scenario === "parallel-fallback") {
      assert.equal(signCalls, 1);
      assert.equal(logged.destinationReferenceUsed, true);
      assert.ok(logged.turnInstruction);
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
