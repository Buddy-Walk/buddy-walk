import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import axios from "axios";
import { decideTurn, type TurnDecisionInput } from "../../server/services/lastMetersTurnDecision";
import { LastMetersTrial } from "../../server/services/lastMetersTrial";
import { lastMetersTestLogService } from "../../server/services/lastMetersTestLog";
import type { PanoramaHeadings } from "../../server/services/lastMetersPanoramaMatching";
import { strictLastMetersGuidancePolicy } from "../../server/utils/lastMetersGuidancePolicy";
import type { LastMetersRequestInput } from "../../server/utils/lastMetersReplay";
import { setTestEnv } from "./testEnv";

const NOW = Date.parse("2026-10-27T12:00:00Z");
const USER = { lat: 40.7, lng: -74 };
/** Well located, facing east, with a calibrated compass; the destination is straight north. */
const REQUEST: LastMetersRequestInput = {
  ...USER, destination: "McDonald's", deviceHeading: 90, gpsAccuracyMeters: 5, compassAccuracyLevel: 3,
};
/** About 50 meters north of the user. */
const NEAR = { lat: 40.70045, lng: -74 };

/** Panorama matching that found the user's heading and the destination, with compass and panorama agreeing. */
const HEADINGS: PanoramaHeadings = {
  currentHeading: 90,
  comparison: { compassHeading: 90, panoramaMatchedHeading: 90, authoritativeHeading: 90, differenceDegrees: 0, agrees: true },
  targetHeading: 0,
  visualMatch: true,
  signTextMatched: false,
  panorama: { metadata: { status: "OK", pano_id: "pano-1", date: "2025-01" }, tiles: [], attempts: [] },
};

/** A straight walking route from the user to the entrance. */
const ROUTE = { status: "OK", routes: [{ legs: [{
  start_location: USER, end_location: NEAR, distance: { value: 50 },
  steps: [{ travel_mode: "WALKING", start_location: USER, end_location: NEAR }],
}] }] };

/** Fake the Directions API, record what the Trial saves, and decide the turn. */
async function decide(t: TestContext, changes: Partial<TurnDecisionInput> = {}, directions: object | Error = ROUTE) {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  setTestEnv(t, { GOOGLE_MAPS_API_KEY: "test-maps" });
  const routeRequests: Record<string, unknown>[] = [];
  t.mock.method(axios, "get", async (url: string, options: { params: Record<string, unknown> }) => {
    if (!url.includes("/directions/")) return assert.fail(`Unexpected Google request: ${url}`);
    routeRequests.push(options.params);
    if (directions instanceof Error) throw directions;
    return { data: directions };
  });
  const rows: Record<string, any>[] = [];
  t.mock.method(lastMetersTestLogService, "record", async (row: Record<string, any>) => {
    rows.push(row);
    return `trial-${rows.length}`;
  });
  // A replay saves no photo of its own, so the placeholder image is never compressed.
  const trial = new LastMetersTrial({
    request: REQUEST, image: "data:image/jpeg;base64,AAAA",
    options: { retry: { retryOf: "original-1", panoramaMode: "fresh", defaultsApplied: [], replayInput: { receivedAt: NOW } as any } },
    policy: strictLastMetersGuidancePolicy,
  });
  const decision = await decideTurn(trial, {
    request: REQUEST,
    entrance: { source: "geocoding_entrance", location: NEAR, distanceMeters: 50 },
    headings: HEADINGS,
    guidanceHeading: undefined,
    turnReasons: strictLastMetersGuidancePolicy.turnReasons,
    sensorReasons: () => [],
    ...changes,
  });
  /** End the Trial so its saved row shows what the decision logged. */
  const saved = async () => {
    await trial.answer({}, { success: true });
    return rows[0];
  };
  return { decision, routeRequests, saved };
}

test("decideTurn goes ahead from the compared heading when every turn check passes", async t => {
  const { decision, routeRequests, saved } = await decide(t);

  const goAhead = decision.kind === "go_ahead" ? decision : assert.fail(`Withheld: ${JSON.stringify(decision)}`);
  assert.equal(goAhead.turnHeading, 90);
  assert.deepEqual(
    { level: goAhead.confidence.level, score: Math.round(goAhead.confidence.score * 100), reasons: goAhead.confidence.reasons },
    { level: "high", score: 90, reasons: [] },
  );
  assert.equal(goAhead.walkingEvidence.verified, true);
  assert.deepEqual(routeRequests, [{ mode: "walking", origin: "40.7,-74", destination: "40.70045,-74", key: "test-maps" }]);
  const row = await saved();
  assert.deepEqual(
    row.steps.map((step: any) => [step.name, step.response, step.success, step.error]),
    [["confidence_fusion", "HIGH: 90%", true, undefined]],
  );
  assert.deepEqual(
    { confidenceLevel: row.confidenceLevel, confidenceScore: Math.round(row.confidenceScore * 100), walkingVerified: row.walkingEvidence.verified, currentHeading: row.currentHeading },
    { confidenceLevel: "high", confidenceScore: 90, walkingVerified: true, currentHeading: 90 },
  );
});

test("decideTurn withholds the turn when the walking route cannot be looked up", async t => {
  const { decision, saved } = await decide(t, {}, new Error("socket hang up"));

  assert.deepEqual(decision, { kind: "withhold", reasons: ["walking_route_unavailable"] });
  const row = await saved();
  assert.deepEqual(row.walkingEvidence, { verified: false, reason: "walking_route_unavailable" });
  assert.equal(row.currentHeading, undefined, "a withheld turn keeps the heading panorama matching noted");
});

test("decideTurn withholds the turn when compass and panorama disagree, logging why confidence is low", async t => {
  const { decision, saved } = await decide(t, {
    headings: { ...HEADINGS, comparison: { ...HEADINGS.comparison, panoramaMatchedHeading: 180, differenceDegrees: 90, agrees: false } },
  });

  assert.deepEqual(decision, { kind: "withhold", reasons: ["confidence_not_high", "orientation_not_corroborated"] });
  const row = await saved();
  assert.deepEqual(
    row.steps.map((step: any) => [step.name, step.success, step.error]),
    [["confidence_fusion", false, "Compass and panorama headings disagree."]],
  );
  assert.equal(row.confidenceLevel, "low");
});

test("decideTurn turns from the guidance policy's heading when it has one", async t => {
  const { decision, saved } = await decide(t, { guidanceHeading: 45 });

  assert.equal(decision.kind === "go_ahead" ? decision.turnHeading : assert.fail(), 45);
  assert.equal((await saved()).currentHeading, 45);
});

test("decideTurn judges the sensors after the walking route lookup and withholds on what they report", async t => {
  let routeLookupsBeforeSensors: number | undefined;
  const { decision } = await decide(t, {
    sensorReasons: () => {
      routeLookupsBeforeSensors = (axios.get as unknown as { mock: { callCount(): number } }).mock.callCount();
      return ["turned_since_capture"];
    },
  });

  assert.equal(routeLookupsBeforeSensors, 1);
  assert.deepEqual(decision, { kind: "withhold", reasons: ["turned_since_capture"] });
});
