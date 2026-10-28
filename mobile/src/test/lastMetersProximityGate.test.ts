import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { passProximityGate, resolveProximityGate, type ProximityGateInput } from "../../server/services/lastMetersProximityGate";
import { LastMetersTrial } from "../../server/services/lastMetersTrial";
import { lastMetersTestLogService } from "../../server/services/lastMetersTestLog";
import type { VerifiedNearbyDestination } from "../../server/services/verifiedDestination";
import { strictLastMetersGuidancePolicy } from "../../server/utils/lastMetersGuidancePolicy";

const USER = { lat: 40.7, lng: -74 };
/** Straight north of the user, about 300 meters away: too far for exact mode. */
const FAR_NORTH = { location: { lat: 40.7027, lng: -74 }, distanceMeters: 300 };
/** Straight south of the user, about 100 meters away: inside the exact radius. */
const NEAR_SOUTH = { location: { lat: 40.6991, lng: -74 }, distanceMeters: 100 };
const strictGate = strictLastMetersGuidancePolicy.analysisGate;

test("resolveProximityGate answers aligned when a far destination is ahead of the phone", () => {
  const result = resolveProximityGate({ ...USER, deviceHeading: 10, gpsAccuracyMeters: 14 }, FAR_NORTH, strictGate);

  assert.deepEqual(result, {
    mode: "aligned",
    headingAlignment: { destinationBearing: 0, differenceDegrees: 10, aligned: true },
    gate: { exact: false, allowanceMeters: 0, widened: false },
  });
});

test("resolveProximityGate answers approach when a far destination is not ahead of the phone", () => {
  const result = resolveProximityGate({ ...USER, deviceHeading: 90, gpsAccuracyMeters: 14 }, FAR_NORTH, strictGate);

  assert.equal(result.mode, "approach");
  assert.deepEqual(result.headingAlignment, { destinationBearing: 0, differenceDegrees: 90, aligned: false });
});

test("resolveProximityGate answers approach without a compass, recording only the bearing", () => {
  const result = resolveProximityGate({ ...USER, gpsAccuracyMeters: 14 }, FAR_NORTH, strictGate);

  assert.equal(result.mode, "approach");
  assert.deepEqual(result.headingAlignment, { destinationBearing: 0 });
});

test("resolveProximityGate answers exact within the radius, even when the phone already faces the destination", () => {
  const result = resolveProximityGate({ ...USER, deviceHeading: 175, gpsAccuracyMeters: 14 }, NEAR_SOUTH, strictGate);

  assert.deepEqual(result, {
    mode: "exact",
    headingAlignment: { destinationBearing: 180, differenceDegrees: 5, aligned: true },
    gate: { exact: true, allowanceMeters: 0, widened: false },
  });
});

test("resolveProximityGate answers approach when poor GPS accuracy keeps a near destination out of exact mode", () => {
  const result = resolveProximityGate({ ...USER, deviceHeading: 90, gpsAccuracyMeters: 45 }, NEAR_SOUTH, strictGate);

  assert.equal(result.mode, "approach");
  assert.deepEqual(result.gate, { exact: false, allowanceMeters: 0, widened: false });
});

test("resolveProximityGate answers exact when the policy's GPS allowance widens the radius", () => {
  // Forgives the whole reported GPS error past the 250 meter radius.
  const forgivingGate = (distanceMeters: number, gpsAccuracyMeters?: number) => {
    const allowanceMeters = gpsAccuracyMeters ?? 0;
    return { exact: distanceMeters <= 250 + allowanceMeters, allowanceMeters, widened: distanceMeters > 250 };
  };
  const justPastRadius = { location: { lat: 40.70234, lng: -74 }, distanceMeters: 260 };

  const result = resolveProximityGate({ ...USER, deviceHeading: 10, gpsAccuracyMeters: 30 }, justPastRadius, forgivingGate);

  assert.equal(result.mode, "exact");
  assert.deepEqual(result.gate, { exact: true, allowanceMeters: 30, widened: true });
});

const NOW = Date.parse("2026-10-27T12:00:00Z");
const DESTINATION: VerifiedNearbyDestination = {
  placeId: "mcdonalds",
  placeName: "McDonald's",
  placeAddress: "10 Test Street",
  types: ["restaurant"],
  location: FAR_NORTH.location,
  distanceMeters: 300,
  candidateSummary: "McDonald's, 300 meters",
  placeCandidates: [],
  placesSearches: ["nearby"],
  openNow: true,
  businessStatus: "OPERATIONAL",
};
const FAR_AWAY_ANSWER = "McDonald's, 10 Test Street, is approximately 300 meters away in a straight line. " +
  "A walking route has not been verified. Use your primary walking navigation before trying Last Meters closer to the destination." +
  " Google lists McDonald's as closed right now. Source: Google Maps.";

/** Record what the Trial saves and pass the proximity gate for a user at USER. */
async function gateTrial(t: TestContext, changes: Partial<ProximityGateInput>) {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const rows: Record<string, any>[] = [];
  t.mock.method(lastMetersTestLogService, "record", async (row: Record<string, any>) => {
    rows.push(row);
    return `trial-${rows.length}`;
  });
  const attached: [string, Record<string, unknown>][] = [];
  t.mock.method(lastMetersTestLogService, "attachPanorama", async (id: string, panorama: Record<string, unknown>) => {
    attached.push([id, panorama]);
  });
  const request = { ...USER, destination: "McDonald's", deviceHeading: 10, gpsAccuracyMeters: 14 };
  // A replay saves no photo of its own, so the placeholder image is never compressed.
  const trial = new LastMetersTrial({
    request, image: "data:image/jpeg;base64,AAAA",
    options: { retry: { retryOf: "original-1", panoramaMode: "fresh", defaultsApplied: [], replayInput: { receivedAt: NOW } as any } },
    policy: strictLastMetersGuidancePolicy,
  });
  const firstPanorama = Promise.reject(Object.assign(new Error("No panorama"), { code: "STREET_VIEW_NO_VALIDATED_OUTDOOR_PANORAMA" }));
  firstPanorama.catch(() => undefined);
  const result = await passProximityGate(trial, {
    request,
    destinationQuery: "McDonald's",
    place: DESTINATION,
    entrance: { source: "places_pin", ...FAR_NORTH },
    closedNotice: " Google lists McDonald's as closed right now.",
    firstPanorama,
    analysisGate: strictGate,
    ...changes,
  });
  /** End the Trial if the gate did not, so its saved row shows what the gate logged. */
  const saved = async () => {
    if (result.kind === "ok") await trial.answer({}, { success: true });
    return rows[0];
  };
  return { result, attached, saved };
}

const stepsOf = (row: Record<string, any>) => row.steps.map((step: any) => [step.name, step.response]);

test("passProximityGate answers a far destination ahead of the phone and saves the panorama for review afterwards", async t => {
  const { result, attached, saved } = await gateTrial(t, {});

  const exit = result.kind === "exit" ? result.result : assert.fail();
  assert.equal(exit.kind, "response");
  const response = exit.kind === "response" ? exit : assert.fail();
  assert.deepEqual({ status: response.status, body: response.body }, {
    status: 200,
    body: { output: FAR_AWAY_ANSWER, testLogId: "trial-1", mode: "aligned", testScenario: "heading_aligned", warning: "heading_already_aligned" },
  });
  await response.reviewPanorama;
  assert.deepEqual(attached, [["trial-1", { panoramaValidation: [], panoramaStatus: "STREET_VIEW_NO_VALIDATED_OUTDOOR_PANORAMA" }]]);
  const row = await saved();
  assert.deepEqual(stepsOf(row), [
    ["heading_alignment", "ALIGNED: phone 10.0 degrees, destination 0.0 degrees, difference 10.0 degrees"],
    ["proximity_gate", "APPROACH_ONLY: 300 meters"],
  ]);
  assert.match(row.steps[1].prompt, /^Resolve "McDonald's" near the user's coordinates/);
  assert.deepEqual(
    { navigationMode: row.navigationMode, headingAligned: row.headingAligned, exactGateWidened: row.exactGateWidened, dataSources: row.dataSources },
    { navigationMode: "aligned", headingAligned: true, exactGateWidened: false, dataSources: ["phone_gps", "phone_compass"] },
  );
});

test("passProximityGate tells a user without a compass to approach a far destination", async t => {
  const { result, saved } = await gateTrial(t, { request: { ...USER, destination: "McDonald's", gpsAccuracyMeters: 14 } });

  const response = result.kind === "exit" && result.result.kind === "response" ? result.result : assert.fail();
  assert.deepEqual(response.body, {
    output: FAR_AWAY_ANSWER, testLogId: "trial-1", mode: "approach", testScenario: "test_b_approach", warning: "destination_too_far",
  });
  const row = await saved();
  assert.deepEqual(stepsOf(row), [["proximity_gate", "APPROACH_ONLY: 300 meters, 0.0 degrees"]]);
  assert.deepEqual(row.dataSources, ["phone_gps"]);
});

test("passProximityGate lets a near destination through to exact matching, logging the widened GPS allowance", async t => {
  const forgivingGate = () => ({ exact: true, allowanceMeters: 60, widened: true });
  const { result, saved } = await gateTrial(t, { analysisGate: forgivingGate });

  assert.deepEqual(result, {
    kind: "ok",
    value: {
      mode: "exact",
      headingAlignment: { destinationBearing: 0, differenceDegrees: 10, aligned: true },
      gate: { exact: true, allowanceMeters: 60, widened: true },
    },
  });
  const row = await saved();
  assert.deepEqual(stepsOf(row).slice(1), [["proximity_gate", "EXACT: 300 meters (within 250 m after a 60 m GPS allowance)"]]);
  assert.deepEqual({ navigationMode: row.navigationMode, gpsAllowanceMeters: row.gpsAllowanceMeters }, { navigationMode: "exact", gpsAllowanceMeters: 60 });
});
