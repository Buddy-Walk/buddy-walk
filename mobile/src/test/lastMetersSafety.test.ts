import assert from "node:assert/strict";
import test from "node:test";
import {
  sensorSafetyReasons,
  LastMetersSensors,
  bearingBetween,
  turnedSinceCaptureDiagnostics,
  TURNED_SINCE_CAPTURE_MAX_DEGREES,
  angularDifference,
} from "../utils/lastMetersSafety";
import { evaluateWalkingLeg, preciseTurnReasons } from "../../server/utils/lastMetersPolicy";
import { assessReplay, photoHash } from "../../server/utils/lastMetersReplay";
import { summarizeFieldEvaluation } from "../../server/utils/lastMetersEvaluation";
import { mobileLastMetersGuidancePolicy } from "../../server/utils/lastMetersGuidancePolicy";

const now = 1_800_000_000_000;
const origin = { lat: 40.7, lng: -74 };
const target = { lat: 40.70045, lng: -74 };
const sensors = (): LastMetersSensors => ({ photoCapturedAt: now, positionTimestamp: now, headingTimestamp: now,
  headingReference: "true", latestPosition: { ...origin, accuracy: 5, timestamp: now },
  latestHeading: 359, latestHeadingTimestamp: now, latestHeadingReference: "true" });

test("fresh true-north sensors support wraparound comparison", () => {
  assert.deepEqual(sensorSafetyReasons(sensors(), origin, 1, 5, now), []);
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

test("turned_since_capture diagnostics instrument headings, ages, and circular delta (#71)", () => {
  assert.equal(TURNED_SINCE_CAPTURE_MAX_DEGREES, 15, "threshold must not be relaxed without Safety Gate review");
  const wrap = turnedSinceCaptureDiagnostics(1, sensors(), now);
  assert.equal(wrap.reason, null);
  assert.equal(wrap.circularDeltaDegrees, 2);
  assert.equal(wrap.captureHeadingDegrees, 1);
  assert.equal(wrap.latestHeadingDegrees, 359);
  assert.equal(wrap.maxDeltaDegrees, 15);

  const jitter = turnedSinceCaptureDiagnostics(5, { ...sensors(), latestHeading: 10 }, now);
  assert.equal(jitter.reason, null);
  assert.equal(jitter.circularDeltaDegrees, 5);

  const boundary = turnedSinceCaptureDiagnostics(0, { ...sensors(), latestHeading: 15 }, now);
  assert.equal(boundary.reason, null, "exactly 15° still passes (strict > threshold)");
  assert.equal(boundary.circularDeltaDegrees, 15);

  const rotated = turnedSinceCaptureDiagnostics(0, {
    ...sensors(), latestHeading: 90, latestHeadingAccuracyLevel: 2,
  }, now);
  assert.equal(rotated.reason, "turned_since_capture");
  assert.equal(rotated.circularDeltaDegrees, 90);
  assert.ok(rotated.failureKinds.includes("circular_delta_above_max"));
  assert.equal(rotated.latestHeadingAccuracyLevel, 2);
  assert.equal(rotated.captureHeadingAgeMs, 0);
  assert.equal(rotated.latestHeadingAgeMs, 0);

  const invalidCapture = turnedSinceCaptureDiagnostics(-1, { ...sensors(), latestHeading: 90 }, now);
  assert.equal(invalidCapture.reason, null, "invalid capture heading is not turned_since_capture");
  assert.equal(invalidCapture.circularDeltaDegrees, null);
  assert.ok(invalidCapture.failureKinds.includes("capture_heading_invalid"));

  const stale = turnedSinceCaptureDiagnostics(0, {
    ...sensors(), latestHeading: 90, latestHeadingTimestamp: now - 16_000,
  }, now);
  assert.equal(stale.reason, null, "stale heading is not classified as turned_since_capture");
  assert.ok(stale.failureKinds.includes("latest_heading_stale"));
  assert.equal(sensorSafetyReasons({
    ...sensors(), latestHeading: 90, latestHeadingTimestamp: now - 16_000,
  }, origin, 0, 5, now).includes("turned_since_capture"), false);
  assert.ok(sensorSafetyReasons({
    ...sensors(), latestHeading: 90, latestHeadingTimestamp: now - 16_000,
  }, origin, 0, 5, now).includes("current_heading_unavailable"));

  assert.equal(angularDifference(359, 1), 2);
  assert.equal(angularDifference(0, 180), 180);
});

test("mobile policy rebases onto a validated current heading instead of withholding (#71)", () => {
  const rotated = { ...sensors(), latestHeading: 90 };
  const strict = sensorSafetyReasons(rotated, origin, 1, 5, now);
  assert.ok(strict.includes("turned_since_capture"));
  const mobile = mobileLastMetersGuidancePolicy.turnSensorReasons(rotated, origin, 1, 5, now, now);
  assert.equal(mobile.includes("turned_since_capture"), false,
    "validated true-north latest heading may rebase; other gates still apply");
  assert.equal(mobileLastMetersGuidancePolicy.guidanceHeading({
    destination: "McDonald's", lat: origin.lat, lng: origin.lng, deviceHeading: 1, sensors: rotated,
  }, now), 90);
});
test("server checks snapshot at receipt, client checks live sensors before speech", () => {
  assert.deepEqual(sensorSafetyReasons(sensors(), origin, 1, 5, now + 30_000, now), []);
  assert.ok(sensorSafetyReasons(sensors(), origin, 1, 5, now + 30_000).includes("current_gps_unavailable"));
  assert.ok(sensorSafetyReasons(sensors(), origin, 1, 5, now + 61_000, now).includes("photo_stale"));
});
const leg = () => ({ start_location: origin, end_location: target, distance: { value: 50 },
  steps: [{ travel_mode: "WALKING", start_location: origin, end_location: target }] });
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
