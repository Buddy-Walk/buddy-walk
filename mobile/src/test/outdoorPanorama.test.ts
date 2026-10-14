import assert from "node:assert/strict";
import test from "node:test";
import axios from "axios";
import sharp from "sharp";
import { outdoorPanoramaRejection } from "../../server/utils/outdoorPanorama";
import { LAST_MILE_HEADINGS } from "../../server/utils/lastMileNavigation";
import { buildPanoramaDebugImage, createPanoramaOverlaySvg, processPanoramaTiles, classifyPanoramaScene } from "../../server/services/openAI";
import { parseSceneVerdict, selectOutdoorPanorama } from "../../server/services/outdoorPanoramaSelection";
import LastMileTestLog from "../../server/database/models/lastMileTestLog";

const metadata = {
  status: "OK", pano_id: "outdoor-test-pano", copyright: "Google",
  location: { lat: 40.7, lng: -74 },
};

test("outdoor metadata rejects absent, contributor, and malformed panoramas", () => {
  assert.equal(outdoorPanoramaRejection(metadata), null);
  assert.equal(outdoorPanoramaRejection({ ...metadata, status: "ZERO_RESULTS" }), "ZERO_RESULTS");
  assert.equal(outdoorPanoramaRejection({ ...metadata, copyright: "Business owner" }), "NON_GOOGLE_PANORAMA");
  assert.equal(outdoorPanoramaRejection({ ...metadata, pano_id: "" }), "INVALID_METADATA");
  assert.equal(outdoorPanoramaRejection({ ...metadata, location: { lat: NaN, lng: 0 } }), "INVALID_METADATA");
});

test("all sixteen requests use outdoor metadata and the same panorama ID", async (t) => {
  const original = process.env.GOOGLE_MAPS_API_KEY;
  process.env.GOOGLE_MAPS_API_KEY = "unit-test-key";
  t.after(() => {
    if (original === undefined) delete process.env.GOOGLE_MAPS_API_KEY;
    else process.env.GOOGLE_MAPS_API_KEY = original;
  });
  const requests: URL[] = [];
  const preview = await sharp({ create: { width: 640, height: 640, channels: 3, background: "#246843" } }).jpeg().toBuffer();
  let previewCount = 0;
  const get = t.mock.method(axios, "get", async (url: string, options: any) => {
    if (url.endsWith("/metadata")) {
      assert.equal(options.params.source, "outdoor");
      return { data: metadata };
    }
    if (options.params?.fov === 90) {
      previewCount++;
      assert.equal(options.params.source, "outdoor");
      assert.equal(options.params.pano, metadata.pano_id);
      return { status: 200, data: preview };
    }
    requests.push(new URL(url));
    return { status: 200, data: Buffer.alloc(10_001) };
  });
  const result = await processPanoramaTiles(40.7, -74, async images => {
    assert.equal(images.length, 4);
    return "outdoor";
  });
  assert.equal(previewCount, 4);
  assert.equal(result.attempts[0].status, "accepted");
  assert.deepEqual(result.tiles.map(tile => tile.heading), [...LAST_MILE_HEADINGS]);
  assert.equal(requests.length, 16);
  for (const url of requests) {
    assert.equal(url.searchParams.get("source"), "outdoor");
    assert.equal(url.searchParams.get("pano"), metadata.pano_id);
    assert.equal(url.searchParams.get("fov"), "22.5");
    assert.equal(url.searchParams.has("location"), false);
  }
  get.mock.restore();
  let calls = 0;
  t.mock.method(axios, "get", async (url: string, options: any) => {
    calls++;
    assert.ok(url.endsWith("/metadata"));
    assert.equal(options.params.source, "outdoor");
    return { data: { status: "ZERO_RESULTS" } };
  });
  await assert.rejects(processPanoramaTiles(40.7, -74, async () => { throw new Error("Should not classify missing imagery"); }), { code: "STREET_VIEW_NO_VALIDATED_OUTDOOR_PANORAMA" });
  assert.equal(calls, 5);
});

test("a pinned panorama downloads its views without looking up its metadata again", async (t) => {
  const original = process.env.GOOGLE_MAPS_API_KEY;
  process.env.GOOGLE_MAPS_API_KEY = "unit-test-key";
  t.after(() => {
    if (original === undefined) delete process.env.GOOGLE_MAPS_API_KEY;
    else process.env.GOOGLE_MAPS_API_KEY = original;
  });
  const requests: string[] = [];
  t.mock.method(axios, "get", async (url: string) => {
    requests.push(url);
    return { status: 200, data: Buffer.alloc(10_001) };
  });
  const result = await processPanoramaTiles(
    40.7, -74, async () => { throw new Error("A pinned panorama is not reclassified"); },
    undefined, undefined, metadata,
  );
  assert.equal(result.metadata, metadata);
  assert.equal(result.attempts[0].status, "pinned");
  assert.equal(requests.length, 16);
  assert.ok(requests.every(url => !url.includes("/metadata")));
});

test("visual verdict parsing fails closed", () => {
  assert.equal(parseSceneVerdict("OUTDOOR"), "outdoor");
  assert.equal(parseSceneVerdict(" INDOOR "), "indoor");
  for (const response of ["", "OUTDOOR or INDOOR", "probably outdoor", "UNCERTAIN", '{"verdict":"outdoor"}']) {
    assert.equal(parseSceneVerdict(response), "uncertain");
  }
});

test("classifier uses a bounded request with retries disabled and rejects malformed output", async () => {
  const client = { chat: { completions: { create: async (request: any, options: any) => {
    assert.equal(options.timeout, 1234);
    assert.equal(options.maxRetries, 0);
    assert.equal(request.messages[1].content.length, 4);
    assert.match(request.messages[0].content, /subway stations/);
    return { choices: [{ message: { content: "probably outdoor" } }] };
  } } } };
  assert.equal(await classifyPanoramaScene(client as any, ["a", "b", "c", "d"], 1234), "uncertain");
});

test("validation audit survives Mongo model serialization", () => {
  const attempts = [{ panoId: "inside", status: "scene_rejected", reason: "Visual check: indoor.", distanceMeters: 12 }];
  const doc = new LastMileTestLog({ panoramaValidation: attempts });
  assert.deepEqual(doc.toObject().panoramaValidation, attempts);
});

test("selection deadline withholds a late outdoor verdict", async (t) => {
  const preview = await sharp({ create: { width: 640, height: 640, channels: 3, background: "#123456" } }).jpeg().toBuffer();
  let now = 0;
  t.mock.method(Date, "now", () => now);
  t.mock.method(axios, "get", async (url: string) => url.endsWith("/metadata") ? { data: metadata } : { data: preview });
  await assert.rejects(selectOutdoorPanorama(40.7, -74, "unit-test", async () => {
    now = 45_001;
    return "outdoor";
  }), (error: any) => {
    assert.equal(error.attempts.at(-1).status, "timeout");
    assert.ok(!error.attempts.some((a: any) => a.status === "accepted"));
    return true;
  });
});

test("indoor and uncertain panoramas are rejected, duplicates skipped, then an outdoor camera is selected", async (t) => {
  const preview = await sharp({ create: { width: 640, height: 640, channels: 3, background: "#123456" } }).jpeg().toBuffer();
  const ids = ["indoor", "indoor", "uncertain", "outdoor"];
  let lookups = 0;
  let images = 0;
  let classifications = 0;
  t.mock.method(axios, "get", async (url: string) => {
    if (url.endsWith("/metadata")) return { data: { ...metadata, pano_id: ids[lookups++] } };
    images++;
    return { data: preview };
  });
  const verdicts = ["indoor", "uncertain", "outdoor"] as const;
  const result = await selectOutdoorPanorama(40.7, -74, "unit-test", async () => verdicts[classifications++]);
  assert.equal(result.metadata.pano_id, "outdoor");
  assert.equal(lookups, 4);
  assert.equal(images, 12);
  assert.equal(classifications, 3);
  assert.deepEqual(result.attempts.map(a => a.status), ["scene_rejected", "duplicate", "scene_rejected", "accepted"]);
});

test("three rejected unique candidates terminate without allowing a panorama through", async (t) => {
  const preview = await sharp({ create: { width: 640, height: 640, channels: 3, background: "#123456" } }).jpeg().toBuffer();
  let lookups = 0;
  let classifications = 0;
  t.mock.method(axios, "get", async (url: string) => url.endsWith("/metadata")
    ? { data: { ...metadata, pano_id: `candidate-${++lookups}` } } : { data: preview });
  await assert.rejects(selectOutdoorPanorama(40.7, -74, "unit-test", async () => {
    classifications++;
    if (classifications === 1) throw new Error("Provider failure with secret URL");
    return "indoor";
  }), (error: any) => {
    assert.equal(error.code, "STREET_VIEW_NO_VALIDATED_OUTDOOR_PANORAMA");
    assert.equal(error.attempts.length, 3);
    assert.equal(error.attempts[0].status, "validation_error");
    assert.ok(!JSON.stringify(error.attempts).includes("secret"));
    return true;
  });
  assert.equal(lookups, 3);
  assert.equal(classifications, 3);
});

test("distant cameras and repeated IDs cannot consume unbounded visual calls", async (t) => {
  let calls = 0;
  t.mock.method(axios, "get", async (url: string) => {
    calls++;
    assert.ok(url.endsWith("/metadata"));
    return { data: { ...metadata, location: { lat: 40.8, lng: -74 } } };
  });
  await assert.rejects(selectOutdoorPanorama(40.7, -74, "unit-test", async () => {
    assert.fail("Must not classify a camera outside the allowed distance");
  }), (error: any) => {
    assert.deepEqual(error.attempts.map((a: any) => a.status), ["too_far", "duplicate", "duplicate", "duplicate", "duplicate"]);
    return true;
  });
  assert.equal(calls, 5);
});

test("panorama grid includes all sixteen tiles and decimal labels render", async () => {
  const buffer = await sharp({ create: { width: 640, height: 640, channels: 3, background: "#246843" } }).jpeg().toBuffer();
  const grid = await buildPanoramaDebugImage(LAST_MILE_HEADINGS.map(heading => ({ heading, base64: `data:image/jpeg;base64,${buffer.toString("base64")}` })));
  const gridBuffer = Buffer.from(grid.split(",")[1], "base64");
  const dimensions = await sharp(gridBuffer).metadata();
  assert.equal(dimensions.width, 2560);
  assert.equal(dimensions.height, 2560);
  const lastTile = await sharp(gridBuffer).extract({ left: 2000, top: 2100, width: 1, height: 1 }).raw().toBuffer();
  assert.ok(lastTile[1] > 80, "last row must contain imagery, not a blank canvas");
  // Dot in VIEW 16 | 337.5 DEG: zero-based character 13.
  const label = await sharp(createPanoramaOverlaySvg(337.5, 16)).ensureAlpha().raw().toBuffer();
  const dotOffset = (46 * 640 + 425) * 4;
  assert.equal(label[dotOffset], 255);
});
