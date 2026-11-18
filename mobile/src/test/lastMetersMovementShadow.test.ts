import assert from "node:assert/strict";
import test from "node:test";
import { createLastMetersMovementShadow, movementShadowTelemetry } from "../utils/lastMetersMovementShadow";
import type { GpsMeasurement } from "../utils/gpsQuality";
import type { LastMetersSensors } from "../utils/lastMetersSafety";
import type { MotionActivityAdapter, MotionActivityEvent } from "../utils/motionActivityInterval";
import { toLastMetersTestResponse, toRetryHistoryEntry } from "../../server/utils/lastMetersTestRow";

const captureAt = 1_800_000_000_000;
const origin = { lat: 0, lng: 10 };
const fix = (meters: number, at: number, accuracy = 5): GpsMeasurement => ({
  ...origin, lat: meters / 6371000 * 180 / Math.PI, accuracy, timestamp: at,
});
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
const activity = (timestamp: number, type: "walking" | "stationary"): MotionActivityEvent => ({
  timestamp,
  activities: Object.fromEntries(["automotive", "cycling", "running", "walking", "stationary", "unknown"]
    .map(value => [value, { detected: value === type, confidence: 2 }])) as MotionActivityEvent["activities"],
});
const sensors = (latest: GpsMeasurement): LastMetersSensors => ({
  photoCapturedAt: captureAt, positionTimestamp: captureAt, headingTimestamp: captureAt,
  headingReference: "true", latestPosition: latest as LastMetersSensors["latestPosition"],
  latestHeading: 0, latestHeadingTimestamp: latest.timestamp!, latestHeadingReference: "true",
});
const harness = (permission = true) => {
  let clock = captureAt;
  let emit!: (event: MotionActivityEvent) => void;
  let fail!: () => void;
  let removals = 0;
  const adapter: MotionActivityAdapter = {
    requestPermission: async () => permission,
    watch: async (onEvent, onError) => {
      emit = onEvent; fail = onError;
      return { remove: () => { removals++; } };
    },
  };
  const capture = fix(0, captureAt);
  const shadow = createLastMetersMovementShadow({ captureAt, capture, captureId: "capture-test",
    platform: "ios", adapter, now: () => clock });
  const snapshot = (meters: number, at: number, requestedAt = captureAt + 10_000) => {
    const latest = fix(meters, at);
    return shadow.snapshot({ latest, sensors: sensors(latest), captureHeading: 0, requestedAt, observedAt: at });
  };
  return { shadow, capture, snapshot, setTime: (at: number) => { clock = at; },
    emit: (event: MotionActivityEvent) => emit(event), fail: () => fail(), removals: () => removals };
};

test("T2 and T3 snapshots use independent current fixes and preserve earlier diagnostics", async (t) => {
  const h = harness(); t.after(() => h.shadow.stop()); await flush();
  h.setTime(captureAt + 10_000);
  h.shadow.observeGps(fix(2, captureAt + 10_000), captureAt + 10_000);
  const t2 = h.snapshot(2, captureAt + 10_000);
  h.setTime(captureAt + 20_000);
  h.emit(activity(captureAt + 11_000, "walking"));
  h.shadow.observeGps(fix(10, captureAt + 20_000), captureAt + 20_000);
  const t3 = h.snapshot(10, captureAt + 20_000);
  assert.equal(t2.assessment.state, "movement_uncertain", "one received GPS fix is not adequate interval coverage");
  assert.equal(t2.assessment.interval?.samples, 1);
  assert.equal(t2.assessment.motion?.movingEvents, 0);
  assert.equal(t3.assessment.state, "movement_detected");
  assert.equal(t3.assessment.interval?.samples, 2);
  assert.equal(t3.assessment.motion?.movingEvents, 1);
  assert.equal(t3.assessment.gps.latestTimestamp, captureAt + 20_000);
  assert.equal(h.capture.timestamp, captureAt);
});

test("a delayed T3 keeps capture freshness referenced to T2 submission", async (t) => {
  const h = harness(); t.after(() => h.shadow.stop()); await flush();
  const t3 = h.snapshot(2, captureAt + 75_000, captureAt + 10_000);
  assert.equal(t3.assessment.gps.usable, true);
  assert.equal(t3.assessment.gps.issues.includes("capture_stale"), false);
  const oldSubmission = h.snapshot(2, captureAt + 75_000, captureAt + 61_000);
  assert.ok(oldSubmission.assessment.gps.issues.includes("capture_stale"));
});

test("GPS excursions from 61 to 90 seconds remain usable for a timely submission and delayed response", async (t) => {
  const h = harness(); t.after(() => h.shadow.stop()); await flush();
  h.setTime(captureAt + 61_000);
  h.shadow.observeGps(fix(2, captureAt + 61_000), captureAt + 61_000);
  h.setTime(captureAt + 75_000);
  h.shadow.observeGps(fix(15, captureAt + 75_000), captureAt + 75_000);
  h.setTime(captureAt + 89_000);
  h.shadow.observeGps(fix(0, captureAt + 89_000), captureAt + 89_000);
  const result = h.snapshot(0, captureAt + 89_000, captureAt + 10_000).assessment;
  assert.equal(result.gps.usable, true);
  assert.equal(result.interval?.samples, 3);
  assert.equal(result.interval?.invalidSamples, 0);
  assert.equal(result.interval?.maxDisplacementMeters, 15);
  assert.equal(result.interval?.significantExcursionObserved, true);
  assert.equal(result.state, "movement_detected");
  h.shadow.observeGps(fix(20, captureAt + 90_001), captureAt + 90_001);
  assert.equal(h.snapshot(0, captureAt + 90_001).assessment.interval?.samples, 3);
});

test("walking then stationary retains activity and an out-and-back GPS excursion", async (t) => {
  const h = harness(); t.after(() => h.shadow.stop()); await flush();
  h.setTime(captureAt + 10_000);
  h.emit(activity(captureAt + 1000, "walking"));
  h.shadow.observeGps(fix(15, captureAt + 10_000), captureAt + 10_000);
  h.setTime(captureAt + 20_000);
  h.emit(activity(captureAt + 20_000, "stationary"));
  h.shadow.observeGps(fix(0, captureAt + 20_000), captureAt + 20_000);
  const result = h.snapshot(0, captureAt + 20_000).assessment;
  assert.equal(result.state, "movement_detected");
  assert.equal(result.gps.displacementMeters, 0);
  assert.equal(result.interval?.maxDisplacementMeters, 15);
  assert.equal(result.interval?.significantExcursionObserved, true);
  assert.equal(result.motion?.movingEvents, 1);
  assert.equal(result.motion?.stationaryEvents, 1);
});

test("duplicate cached GPS fixes are counted without fabricating a new interval excursion", async (t) => {
  const h = harness(); t.after(() => h.shadow.stop()); await flush();
  h.shadow.observeGps(fix(0, captureAt), captureAt + 1000);
  h.shadow.observeGps(fix(20, captureAt), captureAt + 2000);
  const result = h.snapshot(0, captureAt + 10_000).assessment;
  assert.equal(result.interval?.samples, 2);
  assert.equal(result.interval?.duplicateSamples, 2);
  assert.equal(result.interval?.invalidSamples, 1);
  assert.equal(result.interval?.significantExcursionObserved, false);
  assert.equal(result.state, "movement_uncertain");
});

test("out-of-order GPS is counted and cannot establish an excursion", async (t) => {
  const h = harness(); t.after(() => h.shadow.stop()); await flush();
  h.shadow.observeGps(fix(20, captureAt - 1), captureAt + 1000);
  const result = h.snapshot(0, captureAt + 10_000).assessment;
  assert.equal(result.interval?.outOfOrderSamples, 1);
  assert.equal(result.interval?.significantExcursionObserved, false);
  assert.equal(result.state, "movement_uncertain");
});

test("a sudden out-and-back jump is rejected by the preceding-segment speed check", async (t) => {
  const h = harness(); t.after(() => h.shadow.stop()); await flush();
  h.shadow.observeGps(fix(0, captureAt + 20_000), captureAt + 20_000);
  h.shadow.observeGps(fix(30, captureAt + 21_000), captureAt + 21_000);
  h.shadow.observeGps(fix(0, captureAt + 22_000), captureAt + 22_000);
  const result = h.snapshot(0, captureAt + 22_000).assessment;
  assert.ok(result.interval!.invalidSamples >= 1);
  assert.equal(result.interval?.significantExcursionObserved, false);
  assert.equal(result.state, "movement_uncertain");
});

test("motion permission denial does not disable independent GPS excursion diagnostics", async (t) => {
  const h = harness(false); t.after(() => h.shadow.stop()); await flush();
  h.shadow.observeGps(fix(15, captureAt + 10_000), captureAt + 10_000);
  h.shadow.observeGps(fix(0, captureAt + 20_000), captureAt + 20_000);
  const result = h.snapshot(0, captureAt + 20_000).assessment;
  assert.equal(result.motion?.availability, "permission_denied");
  assert.equal(result.interval?.samples, 2);
  assert.equal(result.interval?.significantExcursionObserved, true);
  assert.equal(result.state, "movement_detected");
});

test("native motion failure does not stop independent GPS history", async (t) => {
  const h = harness(); t.after(() => h.shadow.stop()); await flush();
  h.fail();
  h.shadow.observeGps(fix(15, captureAt + 10_000), captureAt + 10_000);
  const result = h.snapshot(0, captureAt + 20_000).assessment;
  assert.equal(result.motion?.availability, "unavailable");
  assert.equal(result.interval?.samples, 1);
  assert.equal(result.interval?.significantExcursionObserved, true);
});

test("an invalid future GPS fix cannot poison ordering of subsequent valid fixes", async (t) => {
  const h = harness(); t.after(() => h.shadow.stop()); await flush();
  h.shadow.observeGps(fix(2, captureAt + 1_000_000), captureAt + 1000);
  h.shadow.observeGps(fix(15, captureAt + 10_000), captureAt + 10_000);
  const result = h.snapshot(15, captureAt + 10_000).assessment;
  assert.equal(result.interval?.invalidSamples, 1);
  assert.equal(result.interval?.outOfOrderSamples, 0);
  assert.equal(result.interval?.significantExcursionObserved, true);
});

test("snapshot counterfactuals retain existing strict and mobile movement thresholds", async (t) => {
  const h = harness(); t.after(() => h.shadow.stop()); await flush();
  const result = h.snapshot(6, captureAt + 10_000);
  assert.ok(result.strictReasons.includes("moved_since_capture"));
  assert.equal(result.mobileReasons.includes("moved_since_capture"), false);
  assert.equal(result.assessment.state, "movement_uncertain");
});

test("missing or invalid capture and current fixes keep shadow diagnostics uncertain", () => {
  for (const capture of [undefined, { ...fix(0, captureAt), lat: NaN }, fix(0, captureAt)]) {
    const shadow = createLastMetersMovementShadow({ captureAt, capture, captureId: "capture-invalid", platform: "web" });
    const latest = capture?.lat === 0 ? undefined : fix(2, captureAt + 10_000);
    const result = shadow.snapshot({ latest, requestedAt: captureAt + 10_000, observedAt: captureAt + 10_000 });
    assert.equal(result.assessment.state, "movement_uncertain");
    assert.equal(result.assessment.gps.usable, false);
    assert.ok(result.strictReasons.includes("capture_metadata_missing"));
    shadow.stop();
  }
});

test("explicit session stop freezes GPS collection and releases motion once", async () => {
  const h = harness(); await flush();
  h.shadow.observeGps(fix(2, captureAt + 10_000), captureAt + 10_000);
  h.shadow.stop("recapture");
  h.shadow.stop("completed");
  h.shadow.observeGps(fix(20, captureAt + 20_000), captureAt + 20_000);
  const result = h.snapshot(2, captureAt + 20_000).assessment;
  assert.equal(result.interval?.samples, 1);
  assert.equal(h.removals(), 1);
  assert.equal(result.motion?.stopReason, "recapture");
});

test("a new photo owns fresh speed history and cannot inherit movement from a previous photo", () => {
  const first = createLastMetersMovementShadow({ captureAt, capture: fix(0, captureAt), captureId: "first", platform: "web" });
  first.observeGps({ ...fix(20, captureAt + 10_000), reportedSpeed: 2 }, captureAt + 10_000);
  first.stop("retake");
  const secondAt = captureAt + 20_000;
  const second = createLastMetersMovementShadow({ captureAt: secondAt, capture: fix(20, secondAt), captureId: "second", platform: "web" });
  second.observeGps({ ...fix(20, secondAt + 1000), reportedSpeed: 0 }, secondAt + 1000);
  const result = second.snapshot({ latest: fix(20, secondAt + 1000), requestedAt: secondAt + 1000, observedAt: secondAt + 1000 });
  assert.equal(result.assessment.history!.samples, 1);
  assert.equal(result.assessment.history!.maxDisplacementMeters, 0);
  assert.equal(result.assessment.history!.reportedSpeed.mean, 0);
  assert.equal(result.assessment.history!.significantExcursionObserved, false);
  second.stop();
});

test("a reused photo after cancellation retains old evidence as closed, without collecting a new request's samples", async (t) => {
  const h = harness(); t.after(() => h.shadow.stop()); await flush();
  h.shadow.observeGps({ ...fix(2, captureAt + 2000), reportedSpeed: 1 }, captureAt + 2000);
  h.shadow.stop("cancelled");
  h.shadow.observeGps({ ...fix(20, captureAt + 4000), reportedSpeed: 2 }, captureAt + 4000);
  const result = h.snapshot(20, captureAt + 4000, captureAt + 4000).assessment;
  assert.equal(result.history!.samples, 1);
  assert.equal(result.history!.stoppedReason, "cancelled");
  assert.equal(result.history!.coverageAdequate, false);
  assert.equal(result.state, "movement_uncertain");
  assert.ok(result.reasons.includes("latest_fix_not_accepted"));
});

test("telemetry separates apparent/reported speeds and marks uncertainty as an inconclusive comparison", () => {
  const shadow = createLastMetersMovementShadow({ captureAt, capture: fix(0, captureAt), captureId: "speeds", platform: "web" });
  shadow.observeGps({ ...fix(10, captureAt + 2000, 1), reportedSpeed: 0 }, captureAt + 2000);
  const snapshot = shadow.snapshot({ latest: fix(10, captureAt + 2000, 1), requestedAt: captureAt + 2000, observedAt: captureAt + 2000 });
  const props = movementShadowTelemetry({ ...snapshot, captureId: "speeds", requestId: "req-speeds", phase: "response" });
  assert.equal(props.apparentSpeedMeanMps, 5);
  assert.equal(props.reportedSpeedMeanMps, 0);
  assert.equal(props.speedDisagreements, 1);
  assert.equal(props.movementState, "movement_uncertain");
  assert.equal(props.strictComparison, "inconclusive");
  assert.equal(props.mobileComparison, "inconclusive");
  shadow.stop();
});

test("unknown or injected local history fields cannot leak through diagnostic telemetry", () => {
  const shadow = createLastMetersMovementShadow({ captureAt, capture: fix(0, captureAt), captureId: "private", platform: "web" });
  const snapshot = shadow.snapshot({ latest: fix(0, captureAt + 1000), requestedAt: captureAt + 1000, observedAt: captureAt + 1000 });
  Object.assign(snapshot.assessment.history!, { samplesRaw: [{ latitude: 10, longitude: 20 }], secret: "private-gps-history" });
  Object.assign(snapshot.assessment.history!.issueCounts, { latitude: 10, secret: "private-rejection" });
  const props = movementShadowTelemetry({ ...snapshot, captureId: "private", requestId: "private-test", phase: "submission" });
  assert.equal(JSON.stringify(props).includes("private-gps-history"), false);
  assert.equal(JSON.stringify(props).includes("private-rejection"), false);
  assert.equal(JSON.stringify(props).includes('"latitude"'), false);
  shadow.stop();
});

test("saved Trials without speed-history diagnostics remain readable and retryable in the existing row adapters", () => {
  const legacy = { _id: "legacy-trial", destination: "CVS", userPhoto: "data:image/jpeg;base64,AAAA",
    pipelineVersion: "3.0.0-safety-gated", safetyReasons: ["moved_since_capture"],
    moduleTimingsMs: { step0: 0, moduleB: 120 }, replayInput: { schemaVersion: 1, receivedAt: 123 } };
  const before = JSON.stringify(legacy);
  const detail = toLastMetersTestResponse(legacy, true);
  const retry = toRetryHistoryEntry(legacy);
  assert.equal(detail.destination, "CVS");
  assert.deepEqual(detail.safetyReasons, ["moved_since_capture"]);
  assert.deepEqual(detail.replayInput, legacy.replayInput);
  assert.deepEqual(detail.moduleTimingsMs, legacy.moduleTimingsMs);
  assert.equal(retry.id, "legacy-trial");
  assert.deepEqual(retry.safetyReasons, ["moved_since_capture"]);
  assert.equal("movementState" in detail, false);
  assert.equal("gpsHistory" in detail, false);
  assert.equal(JSON.stringify(legacy), before);
});

test("telemetry uses scalar allowlisted diagnostics and excludes raw GPS, photo and activity payloads", async (t) => {
  const h = harness(); t.after(() => h.shadow.stop()); await flush();
  const snapshot = h.snapshot(8, captureAt + 10_000);
  const assessment = Object.assign(snapshot.assessment, { lat: 99, destination: "private address",
    photo: "private-image-data", activityHistory: [{ walking: true }] });
  Object.assign(assessment.gps, { location: { lat: 99, lng: 44 }, rawLocation: "private-location" });
  const props = movementShadowTelemetry({ captureId: "capture-test", requestId: "request-test", phase: "response",
    assessment, strictReasons: snapshot.strictReasons, mobileReasons: snapshot.mobileReasons,
    finalReasons: ["moved_since_capture"], serverReasons: ["gps_uncertain"], testLogId: "trial-test",
    preciseTurnCheckApplied: true });
  assert.equal(props.captureId, "capture-test");
  assert.equal(props.requestId, "request-test");
  assert.equal(props.phase, "response");
  assert.equal(props.testLogId, "trial-test");
  assert.equal(props.strictMoved, true);
  assert.equal(props.finalClientReasons, "moved_since_capture");
  assert.equal(props.preciseTurnCheckApplied, true);
  for (const value of Object.values(props)) {
    assert.ok(value === null || ["string", "number", "boolean"].includes(typeof value));
  }
  for (const secret of ["private address", "private-image-data", "private-location", '"activityHistory"', '"location"', '"lat"', '"lng"']) {
    assert.equal(JSON.stringify(props).includes(secret), false);
  }
});

test("telemetry drops nonfinite numbers, bounds strings and carries both snapshot phases", async (t) => {
  const h = harness(); t.after(() => h.shadow.stop()); await flush();
  const snapshot = h.snapshot(2, captureAt + 10_000);
  snapshot.assessment.gps.adjustedSpeedMps = Infinity;
  snapshot.assessment.gps.displacementMeters = NaN;
  for (const phase of ["submission", "response"] as const) {
    const props = movementShadowTelemetry({ captureId: "capture-test", requestId: "request-test", phase,
      ...snapshot, serverWarning: "x".repeat(900) });
    assert.equal(props.phase, phase);
    assert.equal("adjustedSpeedMps" in props, false);
    assert.equal("displacementMeters" in props, false);
    assert.equal((props.serverWarning as string).length, 500);
    assert.equal(props.motionTimestampSemantics, "activity_start");
  }
});
