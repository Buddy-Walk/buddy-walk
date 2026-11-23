import assert from "node:assert/strict";
import test from "node:test";
import {
  sensorSafetyReasons,
  gpsAccuracyDiagnostics,
  GPS_ACCURACY_MAX_METERS,
  GPS_ACCURACY_BEARING_SIN,
  LastMetersSensors,
  bearingBetween,
} from "../utils/lastMetersSafety";
import { evaluateWalkingLeg, preciseTurnReasons } from "../../server/utils/lastMetersPolicy";
import { assessReplay, photoHash } from "../../server/utils/lastMetersReplay";
import { summarizeFieldEvaluation } from "../../server/utils/lastMetersEvaluation";

const now = 1_800_000_000_000;
const origin = { lat: 40.7, lng: -74 };
const target = { lat: 40.70045, lng: -74 };
const sensors = (): LastMetersSensors => ({ photoCapturedAt: now, positionTimestamp: now, headingTimestamp: now,
  headingReference: "true", latestPosition: { ...origin, accuracy: 5, timestamp: now },
  latestHeading: 359, latestHeadingTimestamp: now, latestHeadingReference: "true" });

test("fresh true-north sensors support wraparound comparison", () => {
  assert.deepEqual(sensorSafetyReasons(sensors(), origin, 1, 5, now), []);
});
test("gps accuracy gate documents Expo meters and keeps the 20 m absolute cap", () => {
  assert.equal(GPS_ACCURACY_MAX_METERS, 20);
  assert.equal(gpsAccuracyDiagnostics(5, 5).unit, "meters");
  assert.equal(gpsAccuracyDiagnostics(5, 5).reason, null);
  assert.equal(gpsAccuracyDiagnostics(20, 20).reason, null, "boundary 20 m still passes");
  assert.equal(gpsAccuracyDiagnostics(20.1, 5).reason, "gps_uncertain");
  assert.ok(gpsAccuracyDiagnostics(20.1, 5).failureKinds.includes("capture_accuracy_above_max"));
  assert.equal(gpsAccuracyDiagnostics(undefined, 5).reason, "gps_uncertain");
  assert.ok(gpsAccuracyDiagnostics(undefined, 5).failureKinds.includes("capture_accuracy_missing"));
  assert.equal(gpsAccuracyDiagnostics(-1, 5).reason, "gps_uncertain");
  assert.ok(gpsAccuracyDiagnostics(5, -1).failureKinds.includes("latest_accuracy_invalid"));
  // Chase / Main building style: 22.2 m absolute still withholds without needing distance.
  assert.ok(sensorSafetyReasons(sensors(), origin, 1, 22.2, now).includes("gps_uncertain"));
  const chase = gpsAccuracyDiagnostics(22.2, 22.2, 35.9);
  assert.equal(chase.reason, "gps_uncertain");
  assert.ok(chase.failureKinds.includes("capture_accuracy_above_max"));
});
test("gps accuracy vs distance is additive and never raises the 20 m cap", () => {
  // Reliable absolute accuracy must not pass solely because distance is large.
  assert.equal(gpsAccuracyDiagnostics(25, 25, 200).reason, "gps_uncertain");
  assert.ok(gpsAccuracyDiagnostics(25, 25, 200).failureKinds.includes("capture_accuracy_above_max"));
  // Close-range: accuracy within 20 m but too large vs distance still withholds.
  const close = gpsAccuracyDiagnostics(14, 14, 10);
  assert.equal(close.reason, "gps_uncertain");
  assert.ok(close.failureKinds.includes("accuracy_vs_distance_too_large"));
  assert.ok((close.accuracyDistanceRatio ?? 0) > GPS_ACCURACY_BEARING_SIN);
  assert.ok(sensorSafetyReasons(sensors(), origin, 1, 14, now, now, 10).includes("gps_uncertain"));
  // Adequate evidence at range: absolute and relative both OK.
  assert.equal(gpsAccuracyDiagnostics(5, 5, 50).reason, null);
  assert.deepEqual(sensorSafetyReasons(sensors(), origin, 1, 5, now, now, 50), []);
});
test("sensor gate rejects missing, old, future, magnetic, moved and rotated readings", () => {
  assert.deepEqual(sensorSafetyReasons(undefined, origin, 1, 5, now), ["capture_metadata_missing"]);
  for (const [patch, reason] of [
    [{ photoCapturedAt: now - 61_000 }, "photo_stale"],
    [{ photoCapturedAt: now + 3000 }, "photo_stale"],
    [{ positionTimestamp: now - 11_000 }, "capture_gps_stale"],
    [{ headingTimestamp: now - 6000 }, "capture_heading_stale"],
    [{ headingReference: "magnetic" }, "true_north_unavailable"],
    [{ latestHeadingTimestamp: now - 16_000 }, "current_heading_unavailable"],
    [{ latestHeading: 90 }, "turned_since_capture"],
    [{ latestPosition: { ...target, accuracy: 5, timestamp: now } }, "moved_since_capture"],
  ] as const) assert.ok(sensorSafetyReasons({ ...sensors(), ...patch } as LastMetersSensors, origin, 1, 5, now).includes(reason));
});
test("server checks snapshot at receipt, client checks live sensors before speech", () => {
  assert.deepEqual(sensorSafetyReasons(sensors(), origin, 1, 5, now + 30_000, now), []);
  assert.ok(sensorSafetyReasons(sensors(), origin, 1, 5, now + 30_000).includes("current_gps_unavailable"));
  assert.ok(sensorSafetyReasons(sensors(), origin, 1, 5, now + 61_000, now).includes("photo_stale"));
});
const leg = () => ({ start_location: origin, end_location: target, distance: { value: 50 },
  steps: [{ travel_mode: "WALKING", start_location: origin, end_location: target }] });
test("gps_uncertain co-occurs with movement and bearing gates without dropping either", () => {
  const moved = sensorSafetyReasons({
    ...sensors(),
    latestPosition: { ...target, accuracy: 22.2, timestamp: now },
  }, origin, 1, 22.2, now);
  assert.ok(moved.includes("gps_uncertain"));
  assert.ok(moved.includes("moved_since_capture"));
  const bearing = preciseTurnReasons({
    confidenceLevel: "high", photoMatched: true, headingAgrees: true, compassAccuracy: 3,
    gpsAccuracy: 22.2, distanceMeters: 35.9, entranceListed: true, visualTargetMatched: true,
    walking: evaluateWalkingLeg(leg(), origin, target), sensorReasons: ["gps_uncertain"],
  });
  assert.ok(bearing.includes("gps_uncertain"));
  assert.ok(bearing.includes("bearing_uncertainty_too_large"));
});
test("walking route requires matching endpoints and consistent walking geometry", () => {
  assert.equal(evaluateWalkingLeg(leg(), origin, target).verified, true);
  assert.match(evaluateWalkingLeg(leg(), origin, target).reason, /not_accessibility_verified/);
  assert.equal(evaluateWalkingLeg(undefined, origin, target).verified, false);
  assert.equal(evaluateWalkingLeg({ ...leg(), end_location: origin }, origin, target).reason, "walking_route_endpoint_mismatch");
  assert.equal(evaluateWalkingLeg({ ...leg(), distance: { value: 300 } }, origin, target).reason, "walking_route_requires_detour");
  assert.equal(evaluateWalkingLeg({ ...leg(), steps: [{ travel_mode: "DRIVING", start_location: origin, end_location: target }] }, origin, target).verified, false);
  assert.equal(evaluateWalkingLeg({ ...leg(), steps: [{ travel_mode: "WALKING", start_location: origin, end_location: { lat: 40.7, lng: -73.9995 } }] }, origin, target).reason, "walking_route_requires_detour");
});
test("precise turns require every independent prerequisite", () => {
  const good = { confidenceLevel: "high", photoMatched: true, headingAgrees: true, compassAccuracy: 3,
    gpsAccuracy: 5, distanceMeters: 50, entranceListed: true, visualTargetMatched: true,
    walking: evaluateWalkingLeg(leg(), origin, target), sensorReasons: [] };
  assert.deepEqual(preciseTurnReasons(good), []);
  for (const patch of [{ confidenceLevel: "low" }, { confidenceLevel: "medium" }, { photoMatched: false },
    { headingAgrees: false }, { compassAccuracy: 2 }, { gpsAccuracy: 21 }, { gpsAccuracy: 14, distanceMeters: 10 },
    { entranceListed: false }, { visualTargetMatched: false }, { walking: { verified: false, reason: "no_route" } },
    { sensorReasons: ["moved_since_capture"] }]) assert.ok(preciseTurnReasons({ ...good, ...patch }).length);
});
test("camera-origin bearings are different evidence from user-origin bearings", () => {
  assert.equal(bearingBetween(origin, target), 0);
  assert.equal(bearingBetween({ lat: 40.7009, lng: -74 }, target), 180);
});
test("replays require original versioned inputs and an available photo", () => {
  assert.equal(assessReplay({}).status, "not_replayable");
  const replayInput = { schemaVersion: 1 as const, receivedAt: now, ...origin, destination: "Citi", sensors: sensors(),
    photoRepresentation: "stored-compressed" as const, originalPhotoSha256: photoHash("original") };
  assert.equal(assessReplay({ replayInput }).status, "not_replayable");
  assert.equal(assessReplay({ replayInput, userPhoto: "data:image/jpeg;base64,test" }).status, "replayable");
  assert.equal(assessReplay({ replayInput: { ...replayInput, lat: NaN }, userPhoto: "data:image/jpeg;base64,test" }).status, "not_replayable");
  const { sensors: _omitted, ...noSensors } = replayInput;
  assert.match(assessReplay({ replayInput: noSensors, userPhoto: "data:image/jpeg;base64,test" }).reason ?? "", /capture timestamps/);
});
test("evaluation separates versions, excludes replays and does not infer field success", () => {
  const base = { serverTs: new Date("2026-10-07"), destination: "Citi", pipelineVersion: "v3" };
  const result = summarizeFieldEvaluation([
    { ...base, reviewOutcome: "got_there", turnCorrectness: "wrong", entranceCorrectness: "correct" },
    { ...base, reviewOutcome: "needed_retake", turnCorrectness: "no_turn_given" }, base,
    { ...base, runKind: "replay", reviewOutcome: "got_there" },
    { ...base, pipelineVersion: "v2", reviewOutcome: "would_not_get_there" },
  ]);
  assert.equal(result.replayCount, 1);
  const group = result.groups.find(g => g.pipelineVersion === "v3")!;
  assert.equal(group.week, "2026-10-05");
  assert.equal(group.trials, 3);
  assert.equal(group.unscored, 1);
  assert.equal(group.successRate, 0.5);
  assert.equal(group.wrongTurnRate, 1);
  assert.equal(group.wrongEntranceRate, 0);
  assert.equal(summarizeFieldEvaluation([{}]).groups[0].successRate, null);
  assert.equal(summarizeFieldEvaluation([{}]).groups[0].week, "unknown");
});
