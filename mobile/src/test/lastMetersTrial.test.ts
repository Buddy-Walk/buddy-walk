import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import sharp from "sharp";
import { LastMetersTrial } from "../../server/services/lastMetersTrial";
import { lastMetersTestLogService } from "../../server/services/lastMetersTestLog";
import { mobileLastMetersGuidancePolicy, strictLastMetersGuidancePolicy } from "../../server/utils/lastMetersGuidancePolicy";
import type { VerifiedNearbyDestination } from "../../server/services/verifiedDestination";
import type { LastMetersRequestInput, ReplayInput } from "../../server/utils/lastMetersReplay";

const NOW = Date.parse("2026-10-27T12:00:00Z");
const REQUEST: LastMetersRequestInput = {
  destination: "McDonald's", lat: 40.7, lng: -74, deviceHeading: 90, gpsAccuracyMeters: 14, compassAccuracyLevel: 3,
};
const PLACE: VerifiedNearbyDestination = {
  placeId: "mcdonalds",
  placeName: "McDonald's",
  placeAddress: "10 Test Street",
  types: ["restaurant"],
  location: { lat: 40.7005, lng: -74 },
  distanceMeters: 56,
  candidateSummary: "McDonald's, 56 meters",
  placeCandidates: [{ placeId: "mcdonalds", name: "McDonald's", address: "10 Test Street", distanceMeters: 56, types: ["restaurant"], relevant: true, source: "nearby" }],
  placesSearches: ["nearby:mcdonald's"],
  openNow: true,
  businessStatus: "OPERATIONAL",
};

/** Capture what the Trial saves instead of writing it. */
function recordTrials(t: TestContext) {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const rows: Record<string, unknown>[] = [];
  t.mock.method(lastMetersTestLogService, "record", async (row: Record<string, unknown>) => {
    rows.push(row);
    return `trial-${rows.length}`;
  });
  return rows;
}

async function largePhoto() {
  const jpeg = await sharp({ create: { width: 2048, height: 1024, channels: 3, background: "#808080" } }).jpeg().toBuffer();
  return `data:image/jpeg;base64,${jpeg.toString("base64")}`;
}

test("a field run saves the Verified destination, entrance and resized photo as the flat Trial row", async t => {
  const rows = recordTrials(t);
  const photo = await largePhoto();
  const trial = new LastMetersTrial({
    request: REQUEST, image: photo, options: { requestPath: "/api/last-meters" }, policy: strictLastMetersGuidancePolicy,
  });
  trial.note({ destinationQuery: "McDonald's", verifiedDestination: PLACE });
  trial.source("google_places");
  trial.note({
    entrance: { source: "geocoding_entrance", location: { lat: 40.7004, lng: -74.0001 }, distanceMeters: 48, besideBuilding: false },
  });
  trial.note({ navigationMode: "approach", testScenario: "test_b_approach" });
  trial.step({ name: "proximity_gate", prompt: "Gate", response: "APPROACH_ONLY: 48 meters", model: "google-places", success: true });

  const result = await trial.answer({ warning: "destination_too_far" }, { finalOutput: "Walk closer.", success: true });

  assert.deepEqual(result, {
    kind: "response",
    status: 200,
    body: { output: "Walk closer.", testLogId: "trial-1", mode: "approach", testScenario: "test_b_approach", warning: "destination_too_far" },
    testLogId: "trial-1",
    reviewPanorama: undefined,
  });
  assert.equal(rows.length, 1);
  const { userPhoto, replayInput, ...row } = rows[0];
  const stored = await sharp(Buffer.from(String(userPhoto).split(",")[1], "base64")).metadata();
  assert.equal(stored.width, 1024, "the user's photo is resized before it is saved");
  assert.equal((replayInput as ReplayInput).receivedAt, NOW);
  assert.equal((replayInput as ReplayInput).destination, "McDonald's");
  assert.deepEqual(row, {
    safetyReasons: [],
    walkingEvidence: { verified: false, reason: "walking_route_not_checked" },
    panoramaTargetHeading: undefined,
    confidenceMethod: "heuristic-not-calibrated",
    destination: "McDonald's",
    destinationQuery: "McDonald's",
    lat: 40.7,
    lng: -74,
    panoramaPhoto: undefined,
    panoramaDate: undefined,
    panoramaStatus: undefined,
    panoramaValidation: [],
    panoramaSource: undefined,
    panoId: undefined,
    panoramaCopyright: undefined,
    panoramaAgeYears: undefined,
    panoramaHeadings: [],
    placeCandidates: PLACE.placeCandidates,
    placesSearches: ["nearby:mcdonald's"],
    gpsAllowanceMeters: undefined,
    exactGateWidened: undefined,
    entranceSource: "geocoding_entrance",
    entranceLat: 40.7004,
    entranceLng: -74.0001,
    besideBuilding: false,
    destinationOpenNow: true,
    destinationBusinessStatus: "OPERATIONAL",
    signText: undefined,
    signTextMatched: undefined,
    dataSources: ["google_places"],
    destinationPhoto: undefined,
    destinationPhotoDate: undefined,
    destinationPhotoStatus: undefined,
    destinationPlaceName: "McDonald's",
    destinationPlaceAddress: "10 Test Street",
    destinationTypes: ["restaurant"],
    // The distance to the entrance, not to the place's map pin.
    destinationDistanceMeters: 48,
    gpsAccuracyMeters: 14,
    compassAccuracyLevel: 3,
    destinationBearing: undefined,
    deviceHeading: 90,
    headingDifferenceDegrees: undefined,
    headingAligned: undefined,
    compassHeading: undefined,
    panoramaMatchedHeading: undefined,
    headingComparisonDifference: undefined,
    headingComparisonAgrees: undefined,
    confidenceScore: undefined,
    confidenceLevel: undefined,
    confidenceReasons: undefined,
    destinationReferenceUsed: false,
    navigationMode: "approach",
    testScenario: "test_b_approach",
    currentHeading: undefined,
    steps: [{ name: "proximity_gate", prompt: "Gate", response: "APPROACH_ONLY: 48 meters", model: "google-places", success: true }],
    latencyMs: 0,
    runKind: "field",
    requestPath: "/api/last-meters",
    finalOutput: "Walk closer.",
    success: true,
  });
});

test("a replay links to its original, keeps its snapshot and saves no photo of its own", async t => {
  const rows = recordTrials(t);
  const replayInput = { receivedAt: NOW - 86_400_000, destination: "McDonald's" } as ReplayInput;
  const trial = new LastMetersTrial({
    request: REQUEST,
    image: "data:image/jpeg;base64,AAAA",
    options: { retry: { retryOf: "original-1", panoramaMode: "original", defaultsApplied: ["sensors"], replayInput } },
    policy: strictLastMetersGuidancePolicy,
  });
  trial.note({
    verifiedDestination: PLACE,
    entrance: { source: "places_pin", location: PLACE.location, distanceMeters: 56 },
    headingAlignment: { destinationBearing: 0, differenceDegrees: 90, aligned: false },
    gate: { exact: true, allowanceMeters: 0, widened: false },
    navigationMode: "exact",
    panorama: {
      metadata: { status: "OK", pano_id: "pano-1", copyright: "Google", date: "2024-10" },
      tiles: [{ heading: 0, base64: "data:image/jpeg;base64,T0" }, { heading: 45, base64: "data:image/jpeg;base64,T1" }],
    },
    panoramaPhoto: "data:image/jpeg;base64,GRID",
    headingComparison: { compassHeading: 90, panoramaMatchedHeading: 90, authoritativeHeading: 90, differenceDegrees: 0, agrees: true },
    currentHeading: 90,
    destinationReference: { photo: "data:image/jpeg;base64,REF", date: "2023-05", status: "OK" },
    destinationReferenceUsed: true,
    signText: { text: "McDONALD'S", matched: true },
    panoramaTargetHeading: 0,
    confidence: { score: 0.9, level: "high", reasons: [] },
    walkingEvidence: { verified: true },
  });

  const result = await trial.answer({ currentHeading: 90, targetHeading: 0 }, {
    finalOutput: "Turn left.", success: true, targetHeading: 0, turnInstruction: "Turn left.",
  });

  assert.equal(result.testLogId, "trial-1");
  const row = rows[0];
  assert.equal(row.replayInput, replayInput);
  assert.equal("userPhoto" in row, false);
  assert.deepEqual(
    { runKind: row.runKind, retryOf: row.retryOf, retryPanoramaMode: row.retryPanoramaMode, retryDefaultsApplied: row.retryDefaultsApplied },
    { runKind: "replay", retryOf: "original-1", retryPanoramaMode: "original", retryDefaultsApplied: ["sensors"] },
  );
  assert.deepEqual({
    panoramaPhoto: row.panoramaPhoto, panoramaDate: row.panoramaDate, panoramaStatus: row.panoramaStatus,
    panoramaSource: row.panoramaSource, panoId: row.panoId, panoramaCopyright: row.panoramaCopyright,
    panoramaAgeYears: row.panoramaAgeYears, panoramaHeadings: row.panoramaHeadings,
  }, {
    panoramaPhoto: "data:image/jpeg;base64,GRID", panoramaDate: "2024-10", panoramaStatus: "OK",
    panoramaSource: "pipeline", panoId: "pano-1", panoramaCopyright: "Google", panoramaAgeYears: 2, panoramaHeadings: [0, 45],
  });
  assert.deepEqual({
    entranceSource: row.entranceSource, entranceLat: row.entranceLat, destinationDistanceMeters: row.destinationDistanceMeters,
    destinationBearing: row.destinationBearing, headingDifferenceDegrees: row.headingDifferenceDegrees, headingAligned: row.headingAligned,
    gpsAllowanceMeters: row.gpsAllowanceMeters, exactGateWidened: row.exactGateWidened,
  }, {
    // A map pin is not a listed entrance, so no entrance coordinates are saved.
    entranceSource: "places_pin", entranceLat: undefined, destinationDistanceMeters: 56,
    destinationBearing: 0, headingDifferenceDegrees: 90, headingAligned: false, gpsAllowanceMeters: 0, exactGateWidened: false,
  });
  assert.deepEqual({
    compassHeading: row.compassHeading, panoramaMatchedHeading: row.panoramaMatchedHeading,
    headingComparisonDifference: row.headingComparisonDifference, headingComparisonAgrees: row.headingComparisonAgrees,
    currentHeading: row.currentHeading, confidenceScore: row.confidenceScore, confidenceLevel: row.confidenceLevel,
    confidenceReasons: row.confidenceReasons,
  }, {
    compassHeading: 90, panoramaMatchedHeading: 90, headingComparisonDifference: 0, headingComparisonAgrees: true,
    currentHeading: 90, confidenceScore: 0.9, confidenceLevel: "high", confidenceReasons: [],
  });
  assert.deepEqual({
    destinationPhoto: row.destinationPhoto, destinationPhotoDate: row.destinationPhotoDate,
    destinationPhotoStatus: row.destinationPhotoStatus, destinationReferenceUsed: row.destinationReferenceUsed,
    signText: row.signText, signTextMatched: row.signTextMatched, panoramaTargetHeading: row.panoramaTargetHeading,
    walkingEvidence: row.walkingEvidence, targetHeading: row.targetHeading, turnInstruction: row.turnInstruction,
  }, {
    destinationPhoto: "data:image/jpeg;base64,REF", destinationPhotoDate: "2023-05", destinationPhotoStatus: "OK",
    destinationReferenceUsed: true, signText: "McDONALD'S", signTextMatched: true, panoramaTargetHeading: 0,
    walkingEvidence: { verified: true }, targetHeading: 0, turnInstruction: "Turn left.",
  });
});

test("withholding a turn saves the reasons and words the answer with the guidance policy", async t => {
  const rows = recordTrials(t);
  const trial = new LastMetersTrial({
    request: REQUEST, image: "data:image/jpeg;base64,AAAA", options: { retry: {
      retryOf: "original-1", panoramaMode: "fresh", defaultsApplied: [], replayInput: { receivedAt: NOW } as ReplayInput,
    } }, policy: mobileLastMetersGuidancePolicy,
  });
  trial.note({ verifiedDestination: PLACE, entrance: { source: "geocoding_entrance", location: PLACE.location, distanceMeters: 48 } });

  const result = await trial.withhold(["gps_uncertain", "gps_uncertain"]);

  // 150 feet is the 48 meters to the entrance, not the 56 meters to the map pin.
  const output = "I found McDonald's at 10 Test Street. From where you took the photo, it is about 150 feet away in a straight line. " +
    "GPS is too uncertain to calculate a precise turn to the entrance from this spot.";
  assert.equal(result.kind, "response");
  assert.deepEqual(result.kind === "response" && result.body, {
    output, testLogId: "trial-1", warning: "turn_withheld", safetyReasons: ["gps_uncertain"],
    guidanceKind: "withheld", targetHeading: null, pipelineVersion: "3.0.0-safety-gated",
  });
  assert.deepEqual(
    { safetyReasons: rows[0].safetyReasons, finalOutput: rows[0].finalOutput, success: rows[0].success, error: rows[0].error },
    { safetyReasons: ["gps_uncertain"], finalOutput: output, success: false, error: "turn_withheld" },
  );
  assert.deepEqual(rows[0].steps, [{ name: "turn_safety_gate", prompt: "Require sufficient evidence before any precise turn.",
    response: "gps_uncertain", model: "deterministic-safety-policy", success: false }]);
});

test("a failed run answers 502 naming the stage it was in", async t => {
  const rows = recordTrials(t);
  t.mock.method(console, "error", () => undefined);
  const trial = new LastMetersTrial({
    request: REQUEST, image: "data:image/jpeg;base64,AAAA", options: {}, policy: strictLastMetersGuidancePolicy,
  });
  trial.stage("current-view matching");

  const result = await trial.fail(Object.assign(new Error("Rate limited"), { status: 429 }));

  assert.deepEqual(result, {
    kind: "response", status: 502, testLogId: "trial-1", reviewPanorama: undefined,
    body: { error: "Last Meters failed during current-view matching: upstream returned HTTP 429." },
  });
  assert.deepEqual({ success: rows[0].success, error: rows[0].error }, { success: false, error: "Rate limited" });
});
