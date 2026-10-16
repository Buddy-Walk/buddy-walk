import assert from "node:assert/strict";
import test from "node:test";
import axios from "axios";
import sharp from "sharp";
import { OpenAIService } from "../../server/services/openAI";
import { lastMileTestLogService } from "../../server/services/lastMileTestLog";
import type { LastMileSensors } from "../utils/lastMileSafety";

const blockedCaptures = [
  { name: "missing metadata", reason: "capture_metadata_missing", message: /update Buddy Walk/i },
  { name: "stale photo", reason: "photo_stale", message: /too old/i },
  { name: "poor GPS", reason: "gps_uncertain", message: /precise location/i },
  { name: "missing heading", reason: "current_heading_unavailable", message: /compass/i },
  { name: "rotated phone", reason: "turned_since_capture", message: /moved or turned/i },
  { name: "missing imagery", reason: "capture_metadata_missing", message: /update Buddy Walk/i },
  { name: "indoor imagery", reason: "capture_metadata_missing", message: /update Buddy Walk/i },
] as const;

for (const scenario of blockedCaptures) {
  test(`blocked mobile capture saves review imagery: ${scenario.name}`, { timeout: 5000 }, async t => {
    const oldKey = process.env.GOOGLE_MAPS_API_KEY;
    process.env.GOOGLE_MAPS_API_KEY = "unit-test";
    t.after(() => {
      if (oldKey === undefined) delete process.env.GOOGLE_MAPS_API_KEY;
      else process.env.GOOGLE_MAPS_API_KEY = oldKey;
    });
    const pixels = Buffer.alloc(640 * 640 * 3);
    for (let i = 0; i < pixels.length; i++) pixels[i] = (i * 13 + Math.floor(i / 19)) % 256;
    const jpeg = await sharp(pixels, { raw: { width: 640, height: 640, channels: 3 } }).jpeg().toBuffer();
    const image = `data:image/jpeg;base64,${jpeg.toString("base64")}`;
    let allowDownload!: () => void;
    const downloadGate = new Promise<void>(resolve => { allowDownload = resolve; });
    t.after(() => allowDownload());
    let finishAttachment!: (update: any) => void;
    const attached = new Promise<any>(resolve => { finishAttachment = resolve; });
    let answer: any;
    let logged: any;
    let lookups = 0;
    let tileRequests = 0;
    t.mock.method(axios, "get", async (url: string) => {
      assert.ok(answer, "The recovery answer must be sent before review imagery is fetched");
      if (url.endsWith("/metadata")) {
        lookups++;
        await downloadGate;
        return { data: scenario.name === "missing imagery" ? { status: "ZERO_RESULTS" } : {
          status: "OK", pano_id: "review-pano", copyright: "Google", date: "2025-01",
          location: { lat: 40.7, lng: -74 },
        } };
      }
      assert.match(url, /streetview/);
      tileRequests++;
      return { status: 200, data: jpeg };
    });
    const service = new OpenAIService();
    let classificationCalls = 0;
    (service as any)._client = { chat: { completions: { create: async (request: any) => {
      assert.match(request.messages[0].content, /^Classify the CAMERA/,
        "A sensor-blocked capture may validate review imagery, never calculate a turn");
      classificationCalls++;
      return { choices: [{ message: { content: scenario.name === "indoor imagery" ? "INDOOR" : "OUTDOOR" } }] };
    } } } };
    t.mock.method(lastMileTestLogService, "record", async (row: any) => { logged = row; return "blocked-trial"; });
    t.mock.method(lastMileTestLogService, "attachPanorama", async (id: string, update: any) => {
      assert.equal(id, "blocked-trial");
      finishAttachment(update);
    });
    const now = Date.now();
    const sensors: LastMileSensors = {
      photoCapturedAt: now, positionTimestamp: now, headingTimestamp: now, headingReference: "true",
      latestPosition: { lat: 40.7, lng: -74, accuracy: 14, timestamp: now },
      latestHeading: 90, latestHeadingTimestamp: now, latestHeadingReference: "true",
    };
    if (scenario.name === "stale photo") sensors.photoCapturedAt -= 61_000;
    if (scenario.name === "rotated phone") sensors.latestHeading = 120;
    const heading = scenario.name === "missing heading" ? undefined : 90;
    const accuracy = scenario.name === "poor GPS" ? 35 : 14;
    const captureSensors = scenario.reason === "capture_metadata_missing" ? undefined : sensors;
    const originalSensors = JSON.stringify(captureSensors);
    const res = { status: () => res, json: (body: any) => { answer = body; } };
    await service.lastMileRequest({ res } as any, 40.7, -74, image, "Citi", heading, accuracy, 3, captureSensors);
    assert.equal(answer.guidanceKind, "withheld");
    assert.equal(answer.targetHeading, null);
    assert.ok(answer.safetyReasons.includes(scenario.reason));
    assert.match(answer.output, scenario.message);
    assert.equal(logged.turnInstruction, undefined);
    assert.equal(logged.panoramaSource, "background");
    assert.deepEqual(logged.dataSources, [], "Review imagery must not be counted as evidence used for guidance");
    assert.equal(JSON.stringify(logged.replayInput.sensors), originalSensors, "Never invent capture metadata for an older client");
    assert.match(logged.userPhoto, /^data:image\/jpeg;base64,/);

    allowDownload();
    const update = await attached;
    assert.ok(lookups > 0);
    if (scenario.name === "missing imagery" || scenario.name === "indoor imagery") {
      assert.equal(update.panoramaPhoto, undefined);
      assert.notEqual(update.panoramaStatus, "OK");
      assert.ok(update.panoramaValidation.length, "Record why review imagery could not be saved");
      if (scenario.name === "missing imagery") assert.equal(classificationCalls, 0);
    } else {
      assert.equal(classificationCalls, 1);
      assert.ok(tileRequests >= 16);
      assert.match(update.panoramaPhoto, /^data:image\/jpeg;base64,/);
      assert.equal(update.panoId, "review-pano");
      assert.equal(update.panoramaHeadings.length, 16);
    }
    assert.equal(logged.turnInstruction, undefined);
  });
}

test("older mobile questions route to Q&A without requiring turn sensors", async t => {
  const service = new OpenAIService();
  let forwarded: any;
  t.mock.method(service, "textRequest", async (_ctx: any, content: any) => { forwarded = content; });
  t.mock.method(lastMileTestLogService, "record", async () => "question-trial");
  t.mock.method(axios, "get", async () => { assert.fail("Questions must not fetch a panorama"); });
  const photo = await sharp({ create: { width: 32, height: 32, channels: 3, background: "gray" } }).jpeg().toBuffer();
  await service.lastMileRequest({} as any, 40.7, -74, `data:image/jpeg;base64,${photo.toString("base64")}`, "When is the 2 train arriving?");
  assert.equal(forwarded.analytics.feature, "mta");
  assert.equal(forwarded.image, undefined);
});
