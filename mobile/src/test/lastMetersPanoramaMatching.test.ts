import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import axios from "axios";
import OpenAI from "openai";
import sharp from "sharp";
import { matchPanoramaHeadings, type PanoramaMatchingInput } from "../../server/services/lastMetersPanoramaMatching";
import { LastMetersTrial } from "../../server/services/lastMetersTrial";
import { lastMetersTestLogService } from "../../server/services/lastMetersTestLog";
import { LAST_METERS_HEADINGS } from "../../server/utils/lastMetersNavigation";
import { strictLastMetersGuidancePolicy } from "../../server/utils/lastMetersGuidancePolicy";
import type { VerifiedNearbyDestination } from "../../server/services/verifiedDestination";
import type { LastMetersRequestInput } from "../../server/utils/lastMetersReplay";
import { setTestEnv } from "./testEnv";

const NOW = Date.parse("2026-10-27T12:00:00Z");
const USER = { lat: 40.7, lng: -74 };
/** Facing east; the destination is straight north. */
const REQUEST: LastMetersRequestInput = { ...USER, destination: "McDonald's", deviceHeading: 90, gpsAccuracyMeters: 14 };
/** About 50 meters north of the user, close enough for the reference photo and sign text backups. */
const NEAR = { lat: 40.70045, lng: -74 };
/** About 111 meters north of the user, too far for the backups. */
const MID = { lat: 40.701, lng: -74 };

const DESTINATION: VerifiedNearbyDestination = {
  placeId: "mcdonalds",
  placeName: "McDonald's",
  placeAddress: "10 Test Street",
  types: ["restaurant"],
  location: NEAR,
  distanceMeters: 50,
  candidateSummary: "McDonald's, 50 meters",
  placeCandidates: [],
  placesSearches: ["nearby"],
  openNow: true,
  businessStatus: "OPERATIONAL",
};

type Vision = "currentView" | "destination" | "reference" | "signText";

function visionFor(prompt: string): Vision {
  if (prompt.includes("center of the user's photo")) return "currentView";
  if (prompt.includes("Find the storefront, sign, or entrance")) return "destination";
  if (prompt.includes("destination-focused Street View image for")) return "reference";
  if (prompt.includes("Transcribe the business names")) return "signText";
  return assert.fail(`Unexpected prompt: ${prompt}`);
}

const photoJpeg = (() => {
  // Noise so the JPEG passes the 10 KB usable-tile check.
  const pixels = Buffer.alloc(640 * 640 * 3);
  for (let i = 0; i < pixels.length; i++) pixels[i] = (i * 13 + Math.floor(i / 19)) % 256;
  return sharp(pixels, { raw: { width: 640, height: 640, channels: 3 } }).jpeg().toBuffer();
})();

/** What Google and OpenAI answer while panoramas are matched, panorama by panorama. */
interface World {
  /** Capture dates of the panoramas at the user's position; the first is already downloaded. */
  panoramaDates: (string | undefined)[];
  /** One answer per panorama; the last repeats. */
  vision: Record<Vision, string[]>;
  /** Fails the first panorama's download. */
  noPanorama?: boolean;
  deviceHeading?: number;
  /** Panoramas the search had already looked at before matching; defaults to the first. */
  seen?: string[];
  /** A dashboard retry pinned to the first panorama. */
  pinned?: boolean;
  /** Where the entrance is, and whether the user stands beside its building. */
  entrance?: { location: typeof NEAR; distanceMeters: number; besideBuilding?: boolean };
}

function world(changes: Partial<World> = {}): World {
  return {
    panoramaDates: ["2025-01"],
    vision: { currentView: ["90"], destination: ["0"], reference: ["NOT_VISIBLE"], signText: ["NO_TEXT"] },
    ...changes,
  };
}

/** Fake Google and OpenAI, record what the Trial saves, and match panoramas for REQUEST. */
async function match(t: TestContext, given: World) {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  setTestEnv(t, { GOOGLE_MAPS_API_KEY: "test-maps", OPENAI_API_KEY: "test-openai" });
  const jpeg = await photoJpeg;
  const panoramas = given.panoramaDates.map((date, index) => ({
    status: "OK", pano_id: `pano-${index + 1}`, copyright: "Google", date, location: USER,
  }));
  let searched = 1;
  t.mock.method(axios, "get", async (url: string, options?: { params?: { location?: string } }) => {
    if (url.includes("/streetview/metadata") && options?.params?.location === `${NEAR.lat},${NEAR.lng}`) {
      // The reference photo's panorama, about 28 meters south of the destination.
      return { data: { status: "OK", pano_id: "destination-pano", copyright: "Google", date: "2025-06", location: { lat: 40.7002, lng: -74 } } };
    }
    if (url.includes("/streetview/metadata")) {
      const next = panoramas[searched];
      if (!next) return { data: { status: "ZERO_RESULTS" } };
      searched++;
      return { data: next };
    }
    if (url.includes("/streetview")) return { status: 200, data: jpeg };
    return assert.fail(`Unexpected Google request: ${url}`);
  });
  const prompts: Vision[] = [];
  t.mock.method(OpenAI.Chat.Completions.prototype, "create", async (request: any) => {
    const vision = visionFor(request.messages[0].content);
    prompts.push(vision);
    const panoramaIndex = prompts.filter(prompt => prompt === vision).length - 1;
    const answers = given.vision[vision];
    const answer = answers[Math.min(panoramaIndex, answers.length - 1)];
    return { choices: [{ message: { content: answer } }], usage: { total_tokens: 10 } };
  });
  const rows: Record<string, any>[] = [];
  t.mock.method(lastMetersTestLogService, "record", async (row: Record<string, any>) => {
    rows.push(row);
    return `trial-${rows.length}`;
  });

  const request = { ...REQUEST, deviceHeading: "deviceHeading" in given ? given.deviceHeading : REQUEST.deviceHeading };
  // A replay saves no photo of its own, so the placeholder image is never compressed.
  const trial = new LastMetersTrial({
    request, image: "data:image/jpeg;base64,AAAA",
    options: { retry: { retryOf: "original-1", panoramaMode: "fresh", defaultsApplied: [], replayInput: { receivedAt: NOW } as any } },
    policy: strictLastMetersGuidancePolicy,
  });
  const audits: { panoId?: string; status: string }[] = [];
  const tiles = LAST_METERS_HEADINGS.map(heading => ({ heading, base64: `data:image/jpeg;base64,${jpeg.toString("base64")}` }));
  const first = given.noPanorama
    ? Promise.reject(Object.assign(new Error("No nearby panorama passed outdoor visual validation."), { code: "STREET_VIEW_NO_VALIDATED_OUTDOOR_PANORAMA" }))
    : Promise.resolve({ metadata: panoramas[0], tiles, attempts: [] });
  first.catch(() => undefined);
  const entrance = given.entrance ?? { location: NEAR, distanceMeters: 50 };
  const input: PanoramaMatchingInput = {
    request,
    image: "data:image/jpeg;base64,AAAA",
    destinationQuery: "McDonald's",
    place: { ...DESTINATION, location: entrance.location, distanceMeters: entrance.distanceMeters },
    entrance: { source: "geocoding_entrance", ...entrance },
    closedNotice: "",
    search: {
      first,
      budget: { seen: new Set(given.seen ?? ["pano-1"]), deadline: NOW + 45_000 },
      classify: async () => "outdoor",
      audit: attempt => { audits.push(attempt); },
      pinned: given.pinned ?? false,
    },
  };
  t.mock.method(console, "log", () => undefined);

  const result = await matchPanoramaHeadings(trial, input);

  /** End the Trial if matching did not, so its saved row shows what matching logged. */
  const saved = async () => {
    if (result.kind === "ok") await trial.answer({}, { success: true });
    return rows[0];
  };
  return { result, prompts, audits, saved };
}

const stepsOf = (row: Record<string, any>) => row.steps.map((step: any) => [step.name, step.panoId, step.response, step.success]);

test("matchPanoramaHeadings finds the user's heading and the destination in the first panorama", async t => {
  const { result, prompts, saved } = await match(t, world());

  assert.equal(result.kind, "ok");
  const headings = result.kind === "ok" ? result.value : assert.fail();
  assert.deepEqual(
    {
      currentHeading: headings.currentHeading,
      targetHeading: headings.targetHeading,
      visualMatch: headings.visualMatch,
      signTextMatched: headings.signTextMatched,
      reference: headings.reference,
      panoId: headings.panorama.metadata.pano_id,
      panoramaMatchedHeading: headings.comparison.panoramaMatchedHeading,
      agrees: headings.comparison.agrees,
    },
    {
      currentHeading: 90, targetHeading: 0, visualMatch: true, signTextMatched: false, reference: undefined,
      panoId: "pano-1", panoramaMatchedHeading: 90, agrees: true,
    },
  );
  assert.deepEqual(prompts, ["destination", "currentView"], "Step 2 starts before Step 1 is awaited");
  const row = await saved();
  assert.deepEqual(stepsOf(row), [
    ["panorama_current_view_match", "pano-1", "90", true],
    ["compass_current_heading", undefined, "90 DEG", true],
    ["heading_source_comparison", undefined, "AGREE: 0 DEG DIFFERENCE", true],
    ["target_store_match", "pano-1", "0", true],
  ]);
  assert.deepEqual(
    { testScenario: row.testScenario, panoId: row.panoId, panoramaTargetHeading: row.panoramaTargetHeading, currentHeading: row.currentHeading, dataSources: row.dataSources },
    { testScenario: "test_a_visible", panoId: "pano-1", panoramaTargetHeading: 0, currentHeading: 90, dataSources: ["street_view_panorama"] },
  );
  assert.equal(typeof row.panoramaPhoto, "string");
});

test("matchPanoramaHeadings falls back to the destination reference photo when Step 2 misses", async t => {
  const { result, prompts, saved } = await match(t, world({
    vision: { currentView: ["90"], destination: ["NOT_VISIBLE"], reference: ["VISIBLE"], signText: ["NO_TEXT"] },
  }));

  const headings = result.kind === "ok" ? result.value : assert.fail();
  assert.deepEqual(
    { targetHeading: headings.targetHeading, visualMatch: headings.visualMatch, signTextMatched: headings.signTextMatched, referencePlace: headings.reference?.placeName, referenceDate: headings.reference?.date },
    { targetHeading: 0, visualMatch: false, signTextMatched: false, referencePlace: "McDonald's", referenceDate: "2025-06" },
  );
  assert.equal(typeof headings.reference?.photo, "string");
  assert.deepEqual(prompts, ["destination", "currentView", "signText", "reference"], "Step 2C's work starts before Step 2B is awaited");
  const row = await saved();
  assert.deepEqual(stepsOf(row).slice(3), [
    ["target_store_match", "pano-1", "NOT_VISIBLE", false],
    ["destination_reference_match", undefined, "VISIBLE", true],
    ["sign_text_match", "pano-1", "NO_TEXT", false],
  ]);
  assert.deepEqual(
    { testScenario: row.testScenario, destinationReferenceUsed: row.destinationReferenceUsed, destinationPhotoDate: row.destinationPhotoDate, dataSources: row.dataSources },
    { testScenario: "test_a_reference", destinationReferenceUsed: true, destinationPhotoDate: "2025-06",
      dataSources: ["street_view_panorama", "street_view_sign_closeup", "street_view_reference"] },
  );
});

test("matchPanoramaHeadings falls back to sign text when Step 2 and the reference photo miss", async t => {
  const { result, saved } = await match(t, world({
    vision: { currentView: ["90"], destination: ["NOT_VISIBLE"], reference: ["NOT_VISIBLE"], signText: ["McDonald's\nOPEN"] },
  }));

  const headings = result.kind === "ok" ? result.value : assert.fail();
  assert.deepEqual(
    { targetHeading: headings.targetHeading, visualMatch: headings.visualMatch, signTextMatched: headings.signTextMatched, reference: headings.reference },
    { targetHeading: 0, visualMatch: false, signTextMatched: true, reference: undefined },
  );
  const row = await saved();
  assert.deepEqual(stepsOf(row).slice(4), [
    ["destination_reference_match", undefined, "NOT_VISIBLE", false],
    ["sign_text_match", "pano-1", "McDonald's\nOPEN", true],
  ]);
  assert.deepEqual(
    { testScenario: row.testScenario, panoramaTargetHeading: row.panoramaTargetHeading, signText: row.signText, signTextMatched: row.signTextMatched, destinationReferenceUsed: row.destinationReferenceUsed },
    { testScenario: "test_a_sign_text", panoramaTargetHeading: 0, signText: "McDonald's\nOPEN", signTextMatched: true, destinationReferenceUsed: false },
  );
});

test("matchPanoramaHeadings skips the reference photo for stale imagery but still reads sign text", async t => {
  const { result, prompts, saved } = await match(t, world({
    panoramaDates: ["2016-01"],
    vision: { currentView: ["90"], destination: ["NOT_VISIBLE"], reference: ["VISIBLE"], signText: ["McDonald's"] },
  }));

  assert.equal(result.kind === "ok" && result.value.signTextMatched, true);
  assert.deepEqual(prompts, ["destination", "currentView", "signText"]);
  const row = await saved();
  assert.deepEqual(stepsOf(row).slice(4), [
    ["destination_reference_match", undefined, "SKIPPED: stale_imagery", false],
    ["sign_text_match", "pano-1", "McDonald's", true],
  ]);
  assert.equal(row.destinationPhotoStatus, "stale_imagery");
});

test("matchPanoramaHeadings moves on to a second panorama when the first does not show the destination", async t => {
  const { result, audits, saved } = await match(t, world({
    panoramaDates: ["2025-01", "2025-02"],
    vision: { currentView: ["90"], destination: ["NOT_VISIBLE", "0"], reference: ["NOT_VISIBLE"], signText: ["NO_TEXT"] },
  }));

  const headings = result.kind === "ok" ? result.value : assert.fail();
  assert.deepEqual(
    { panoId: headings.panorama.metadata.pano_id, targetHeading: headings.targetHeading, visualMatch: headings.visualMatch, signTextMatched: headings.signTextMatched },
    { panoId: "pano-2", targetHeading: 0, visualMatch: true, signTextMatched: false },
  );
  assert.deepEqual(audits.filter(audit => audit.panoId === "pano-1").map(audit => audit.status), ["destination_not_visible"]);
  const row = await saved();
  assert.deepEqual(row.steps.filter((step: any) => step.name === "target_store_match").map((step: any) => [step.panoId, step.success]),
    [["pano-1", false], ["pano-2", true]]);
  assert.deepEqual(
    { panoId: row.panoId, panoramaDate: row.panoramaDate, destinationPhotoStatus: row.destinationPhotoStatus, signText: row.signText, destinationReferenceUsed: row.destinationReferenceUsed },
    { panoId: "pano-2", panoramaDate: "2025-02", destinationPhotoStatus: undefined, signText: undefined, destinationReferenceUsed: false },
    "the second panorama's row shows none of the first panorama's backups",
  );
});

test("matchPanoramaHeadings never moves on from a pinned panorama", async t => {
  const { result, audits, prompts } = await match(t, world({
    pinned: true,
    panoramaDates: ["2025-01", "2025-02"],
    vision: { currentView: ["90"], destination: ["NOT_VISIBLE", "0"], reference: ["NOT_VISIBLE"], signText: ["NO_TEXT"] },
  }));

  assert.equal(result.kind === "exit" && result.result.kind === "response" && result.result.body.warning, "turn_withheld");
  assert.deepEqual(audits.filter(audit => audit.status === "destination_not_visible"), []);
  assert.equal(prompts.filter(prompt => prompt === "destination").length, 1);
});

test("matchPanoramaHeadings tries at most three panoramas", async t => {
  // An empty search budget, so only the attempt limit stops it.
  const { result, prompts, saved } = await match(t, world({
    seen: [],
    panoramaDates: ["2025-01", "2025-02", "2025-03", "2025-04"],
    vision: { currentView: ["90"], destination: ["NOT_VISIBLE"], reference: ["NOT_VISIBLE"], signText: ["BAKERY", "PHARMACY", "BANK"] },
  }));

  assert.equal(result.kind, "exit");
  assert.equal(prompts.filter(prompt => prompt === "destination").length, 3);
  const row = await saved();
  assert.deepEqual({ panoId: row.panoId, signText: row.signText }, { panoId: "pano-3", signText: "BANK" },
    "the row shows the last panorama's backups");
});

/** The answer an exit ended the run with. */
function exitBody(result: Awaited<ReturnType<typeof match>>["result"]) {
  return result.kind === "exit" && result.result.kind === "response" ? result.result.body : assert.fail(`Expected an exit, got ${result.kind}`);
}

test("matchPanoramaHeadings ends the run when no outdoor panorama could be downloaded", async t => {
  const { result, prompts, saved } = await match(t, world({ noPanorama: true }));

  assert.deepEqual(exitBody(result), {
    output: "You are about 150 feet from McDonald's. I could not verify a suitable outdoor panorama, so I cannot safely provide a precise turn or entrance direction. Stay in a safe place and use your primary navigation or ask for assistance. Source: Google Maps.",
    testLogId: "trial-1", mode: undefined, testScenario: "no_panorama", targetHeading: null, warning: "no_validated_outdoor_panorama",
  });
  assert.deepEqual(prompts, []);
  const row = await saved();
  assert.deepEqual(
    { panoramaStatus: row.panoramaStatus, error: row.error, steps: stepsOf(row) },
    { panoramaStatus: "STREET_VIEW_NO_VALIDATED_OUTDOOR_PANORAMA", error: "no_validated_outdoor_panorama",
      steps: [["panorama_download", undefined, "STREET_VIEW_NO_VALIDATED_OUTDOOR_PANORAMA", false]] },
  );
});

test("matchPanoramaHeadings ends the run when the phone compass is unavailable", async t => {
  const { result, saved } = await match(t, world({ deviceHeading: undefined }));

  const body = exitBody(result);
  assert.equal(body.warning, "compass_heading_unavailable");
  assert.match(String(body.output), /compass was unavailable or not calibrated/);
  const row = await saved();
  assert.deepEqual(stepsOf(row), [
    ["panorama_current_view_match", "pano-1", "90", true],
    ["compass_current_heading", undefined, "COMPASS_UNAVAILABLE", false],
    ["heading_source_comparison", undefined, "NOT_COMPARABLE", false],
  ]);
});

test("matchPanoramaHeadings ends the run when the compass and the panorama disagree", async t => {
  const { result, saved } = await match(t, world({
    vision: { currentView: ["270"], destination: ["0"], reference: ["NOT_VISIBLE"], signText: ["NO_TEXT"] },
  }));

  const body = exitBody(result);
  assert.deepEqual(
    { warning: body.warning, currentHeading: body.currentHeading, confidenceLevel: body.confidenceLevel, testScenario: body.testScenario },
    { warning: "heading_sources_disagree", currentHeading: 90, confidenceLevel: "low", testScenario: "heading_conflict" },
  );
  const row = await saved();
  assert.deepEqual(row.safetyReasons, ["heading_sources_disagree"]);
  assert.equal(row.steps.some((step: any) => step.name === "target_store_match"), false, "Step 2's answer is never read");
});

test("matchPanoramaHeadings asks the user to move closer when the destination is too far for the backups", async t => {
  const { result, prompts, audits } = await match(t, world({
    entrance: { location: MID, distanceMeters: 111 },
    vision: { currentView: ["90"], destination: ["NOT_VISIBLE"], reference: ["NOT_VISIBLE"], signText: ["NO_TEXT"] },
  }));

  assert.deepEqual(exitBody(result), {
    output: "I could not visually confirm McDonald's. The map places it approximately 111 meters away in a straight line, but a walking route has not been verified. Stay in a safe place and use your primary walking navigation or ask for assistance. Source: Google Maps and Street View imagery from 2025-01.",
    testLogId: "trial-1", mode: "approach", testScenario: "test_b_approach",
    currentHeading: 90, targetHeading: null, warning: "destination_not_visible_move_closer",
  });
  assert.deepEqual(prompts, ["destination", "currentView"], "no reference photo or sign text this far away");
  assert.deepEqual(audits.filter(audit => audit.status === "destination_not_visible").map(audit => audit.panoId), ["pano-1"],
    "it looked for another panorama first");
});

test("matchPanoramaHeadings keeps to the map pin beside the destination's building when it is too far for the backups", async t => {
  const { result, prompts, saved } = await match(t, world({
    entrance: { location: MID, distanceMeters: 111, besideBuilding: true },
    vision: { currentView: ["90"], destination: ["NOT_VISIBLE"], reference: ["NOT_VISIBLE"], signText: ["NO_TEXT"] },
  }));

  const body = exitBody(result);
  assert.deepEqual({ warning: body.warning, safetyReasons: body.safetyReasons }, { warning: "turn_withheld", safetyReasons: ["entrance_not_visually_confirmed"] });
  assert.match(String(body.output), /Google Maps places McDonald's about 350 feet away, but the entrance is not visually verified/);
  assert.deepEqual(prompts, ["destination", "currentView"]);
  const row = await saved();
  assert.equal(row.error, "turn_withheld");
});

test("matchPanoramaHeadings keeps to the map pin when neither backup confirms the destination", async t => {
  const { result, prompts, saved } = await match(t, world({
    vision: { currentView: ["90"], destination: ["NOT_VISIBLE"], reference: ["NOT_VISIBLE"], signText: ["NO_TEXT"] },
  }));

  const body = exitBody(result);
  assert.deepEqual({ warning: body.warning, safetyReasons: body.safetyReasons }, { warning: "turn_withheld", safetyReasons: ["entrance_not_visually_confirmed"] });
  assert.match(String(body.output), /Google Maps places McDonald's about 150 feet away, but the entrance is not visually verified/);
  assert.deepEqual(prompts, ["destination", "currentView", "signText", "reference"]);
  const row = await saved();
  assert.deepEqual(
    { testScenario: row.testScenario, signText: row.signText, destinationReferenceUsed: row.destinationReferenceUsed, destinationPhotoStatus: row.destinationPhotoStatus },
    { testScenario: "test_a_reference", signText: "NO_TEXT", destinationReferenceUsed: false, destinationPhotoStatus: "OK" },
  );
});
