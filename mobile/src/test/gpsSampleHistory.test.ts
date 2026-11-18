import assert from "node:assert/strict";
import test from "node:test";
import { assessGpsTransition, calculateGpsSpeed, type GpsSample } from "../utils/gpsQuality";
import { createGpsSampleHistory } from "../utils/gpsSampleHistory";
import { MOVEMENT_DIAGNOSTICS_CONFIG as config } from "../utils/movementDiagnosticsConfig";

const at = 1_800_000_000_000;
const sample = (meters = 0, seconds = 0, speed: number | null = 0, accuracy: number | null = 3): GpsSample => ({
  latitude: meters / 6371000 * 180 / Math.PI, longitude: 10, timestamp: at + seconds * 1000,
  accuracy, reportedSpeed: speed,
});

for (const [distance, seconds, reported] of [[10, 5, 1.4], [0.2, 1, 0.2], [5, 10, 0.5], [10, 3, 2]]) {
  test(`raw apparent speed uses actual ${seconds}s elapsed for ${distance}m; reported ${reported}m/s stays separate`, () => {
    const result = calculateGpsSpeed(sample(), sample(distance, seconds, reported));
    assert.ok(Math.abs(result.apparentSpeedMps! - distance / seconds) < 1e-10);
    assert.ok(Math.abs(result.distanceMeters! - distance) < 1e-10);
    assert.equal(result.elapsedSeconds, seconds);
    assert.equal(result.reportedSpeedMps, reported);
    assert.deepEqual(result.issues, []);
  });
}

for (const [seconds, reason] of [[0, "duplicate_timestamp"], [-1, "out_of_order_timestamp"]] as const) {
  test(`${reason} cannot produce a zero-speed stationary reading`, () => {
    const result = calculateGpsSpeed(sample(), sample(5, seconds, null));
    assert.equal(result.apparentSpeedMps, null);
    assert.equal(result.reportedSpeedMps, null);
    assert.ok(result.issues.includes(reason));
  });
}

for (const speed of [null, -1, NaN, Infinity]) {
  test(`missing/invalid reported speed ${String(speed)} is null without rejecting otherwise good coordinates`, () => {
    const result = assessGpsTransition(sample(), sample(1, 2, speed), at + 2000);
    assert.equal(result.reportedSpeedMps, null);
    assert.ok(result.reportedSpeedIssue);
    assert.equal(result.apparentSpeedMps, 0.5);
    assert.equal(result.usable, true);
  });
}

test("reported zero speed is valid and distinct from missing speed", () => {
  assert.equal(calculateGpsSpeed(sample(), sample(0, 1, 0)).reportedSpeedMps, 0);
  assert.equal(calculateGpsSpeed(sample(), sample(0, 1, 0)).reportedSpeedIssue, null);
});

test("insufficient samples do not fabricate an apparent speed", () => {
  const result = calculateGpsSpeed(undefined, sample());
  assert.equal(result.apparentSpeedMps, null);
  assert.equal(result.distanceMeters, null);
  assert.ok(result.issues.includes("insufficient_samples"));
});

test("extreme finite timestamp values cannot leak infinite apparent speed into diagnostics", () => {
  const result = calculateGpsSpeed({ ...sample(), timestamp: 1e-310 }, { ...sample(100), timestamp: 2e-310 });
  assert.equal(result.apparentSpeedMps, null);
  assert.ok(result.issues.includes("apparent_speed_nonfinite"));
});

for (const patch of [{ latitude: 91 }, { longitude: -181 }, { latitude: NaN }, { longitude: Infinity }]) {
  test(`invalid coordinates ${JSON.stringify(patch)} retain a rejection reason`, () => {
    const result = assessGpsTransition(sample(), { ...sample(1, 1), ...patch }, at + 1000);
    assert.equal(result.usable, false);
    assert.equal(result.apparentSpeedMps, null);
    assert.ok(result.issues.includes("coordinates_invalid"));
  });
}

for (const [patch, observedAt, issue] of [
  [{ accuracy: null }, at + 1000, "accuracy_missing"],
  [{ accuracy: -1 }, at + 1000, "accuracy_invalid"],
  [{ accuracy: 60 }, at + 1000, "accuracy_poor"],
  [{ timestamp: NaN }, at + 1000, "timestamp_invalid"],
  [{ timestamp: at + 4000 }, at + 1000, "timestamp_future"],
  [{}, at + 17_000, "timestamp_stale"],
] as const) {
  test(`GPS quality check ${issue} is separate from movement classification`, () => {
    const result = assessGpsTransition(sample(), { ...sample(1, 1), ...patch }, observedAt);
    assert.equal(result.usable, false);
    assert.ok(result.issues.includes(issue));
  });
}

test("100m in one second retains the observed speed and rejects the transition, without a stationary conclusion", () => {
  const result = assessGpsTransition(sample(), sample(100, 1, 0), at + 1000);
  assert.ok(Math.abs(result.apparentSpeedMps! - 100) < 1e-8);
  assert.equal(result.reportedSpeedMps, 0);
  assert.equal(result.usable, false);
  assert.ok(result.issues.includes("implausible_speed"));
  assert.equal(result.speedDisagreement, true);
  assert.equal("state" in result, false);
});

test("small distance is marked compatible with reported accuracy, never classified as drift", () => {
  const result = assessGpsTransition(sample(), sample(2, 4, 0), at + 4000);
  assert.equal(result.smallChangeWithinAccuracy, true);
  assert.equal(result.usable, true);
  assert.equal("state" in result, false);
});

test("zero latitude and longitude remain geographically valid", () => {
  const a = { ...sample(), latitude: 0, longitude: 0 };
  assert.equal(assessGpsTransition(a, { ...a, timestamp: at + 1000 }, at + 1000).usable, true);
});

test("a bounded local history retains capture, both speed sources, pair quality, and lifetime counts", () => {
  const capture = sample();
  const h = createGpsSampleHistory(capture, at, { ...config, maxHistorySamples: 4 });
  for (let i = 1; i <= 50; i++) h.observe(sample(i, i, 1), at + i * 1000);
  const result = h.snapshot(at + 50_000);
  assert.equal(result.capture!.timestamp, at);
  assert.equal(result.summary.sampleCount, 51);
  assert.equal(result.summary.retainedSampleCount, 4);
  assert.equal(result.entries.length, 3);
  assert.equal(result.summary.droppedSamples, 47);
  assert.equal(result.summary.reportedSpeed.count, 50);
  assert.ok(Math.abs(result.summary.apparentSpeed.mean! - 1) < 1e-8);
  assert.equal(result.summary.reportedSpeed.mean, 1);
  assert.equal(result.entries[2].sample.reportedSpeed, 1);
  assert.equal(result.summary.significantExcursionObserved, true);
  assert.equal(result.summary.coverageAdequate, true);
  capture.latitude = 90;
  result.capture!.latitude = 90;
  result.entries[0].sample.latitude = 90;
  assert.equal(h.snapshot(at + 50_000).capture!.latitude, 0);
  assert.notEqual(h.snapshot(at + 50_000).entries[0].sample.latitude, 90);
});

test("a rejected jump stays in history while later valid samples recover against the last accepted fix", () => {
  const h = createGpsSampleHistory(sample(), at);
  h.observe(sample(100, 1, 0), at + 1000);
  h.observe(sample(0, 2, 0), at + 2000);
  const result = h.snapshot(at + 2000);
  assert.equal(result.entries[0].accepted, false);
  assert.ok(result.entries[0].issues.includes("implausible_speed"));
  assert.equal(result.entries[1].accepted, true);
  assert.equal(result.summary.significantExcursionObserved, false);
  assert.ok(result.summary.maxObservedApparentSpeedMps! > 99);
  assert.equal(result.summary.lastAcceptedTimestamp, at + 2000);
  assert.equal(result.summary.rejectedSamples, 1);
});

test("future or out-of-order fixes cannot poison subsequent accepted time ordering", () => {
  const h = createGpsSampleHistory(sample(), at);
  h.observe(sample(2, 1000), at + 1000);
  h.observe(sample(1, 2, 0.5), at + 2000);
  h.observe(sample(0, 1), at + 3000);
  h.observe(sample(2, 4, 0.5), at + 4000);
  const s = h.snapshot(at + 4000).summary;
  assert.equal(s.lastAcceptedTimestamp, at + 4000);
  assert.equal(s.rejectedSamples, 2);
  assert.equal(s.outOfOrderSamples, 1);
  assert.ok(s.qualityIssues.includes("timestamp_future"));
});

test("cache duplicates and inconsistent timestamp coordinates are retained as distinct quality facts", () => {
  const h = createGpsSampleHistory(sample(), at);
  h.observe(sample(), at + 1000);
  h.observe(sample(2), at + 2000);
  const s = h.snapshot(at + 2000).summary;
  assert.equal(s.duplicateSamples, 2);
  assert.equal(s.issueCounts.inconsistent_timestamp, 1);
  assert.equal(s.acceptedSamples, 1);
  assert.equal(s.coverageAdequate, false);
});

test("gaps include startup, missing callback spans, and the final tail using actual delivery timestamps", () => {
  const h = createGpsSampleHistory(sample(), at);
  h.observe(sample(1, 10, 0.1), at + 10_000);
  const s = h.snapshot(at + 20_000).summary;
  assert.equal(s.startupGapMs, 10_000);
  assert.equal(s.tailGapMs, 10_000);
  assert.equal(s.gapCount, 1);
  assert.equal(s.coveredMs, 0);
  assert.equal(s.coverageAdequate, false);
  assert.ok(s.qualityIssues.includes("gps_coverage_gap"));
});

test("adequate GPS coverage can be measured without treating it as a movement classification", () => {
  const h = createGpsSampleHistory(sample(), at);
  for (let i = 1; i <= 4; i++) h.observe(sample(0, i, 0), at + i * 1000);
  const s = h.snapshot(at + 4000).summary;
  assert.equal(s.coverageAdequate, true);
  assert.equal(s.coverageRatio, 1);
  assert.equal(s.apparentSpeed.mean, 0);
  assert.equal("state" in s, false);
});

test("GPS measurement cadence and delayed callback delivery are logged separately", () => {
  const h = createGpsSampleHistory(sample(), at);
  h.observe(sample(0, 1), at + 5000);
  h.observe(sample(0, 2), at + 9000);
  const result = h.snapshot(at + 9000);
  assert.equal(result.summary.maxDeliveryGapMs, 4000);
  assert.equal(result.summary.maxSampleAgeAtDeliveryMs, 7000);
  assert.equal(result.summary.firstReceivedAt, at + 5000);
  assert.equal(result.entries[0].receivedAt, at + 5000);
  assert.equal(result.summary.tailGapMs, 7000);
  assert.equal(result.summary.coverageAdequate, false);
});

test("closed or timed-out histories cannot claim current adequate coverage", () => {
  const h = createGpsSampleHistory(sample(), at);
  for (let i = 1; i <= 90; i++) h.observe(sample(0, i, 0), at + i * 1000);
  h.observe(sample(0, 91, 0), at + 91_000);
  h.markUnavailable(at + 91_000);
  assert.equal(h.snapshot(at + 91_000).summary.samples, 90);
  assert.equal(h.snapshot(at + 91_000).summary.unavailableEvents, 0);
  assert.equal(h.snapshot(at + 91_000).summary.stoppedReason, "timeout");
  assert.equal(h.snapshot(at + 91_000).summary.coverageAdequate, false);
  h.stop("cancelled");
  h.observe(sample(1, 92), at + 92_000);
  assert.equal(h.snapshot(at + 92_000).summary.samples, 90);
  assert.equal(h.snapshot(at + 92_000).summary.stoppedReason, "cancelled");
});

test("a native GPS provider failure is retained even with a recently fresh quiet fix", () => {
  const h = createGpsSampleHistory(sample(), at);
  for (let i = 1; i <= 4; i++) h.observe(sample(0, i, 0), at + i * 1000);
  h.markUnavailable(at + 4001);
  const result = h.snapshot(at + 4001).summary;
  assert.equal(result.coverageAdequate, false);
  assert.equal(result.unavailableEvents, 1);
  assert.ok(result.qualityIssues.includes("gps_provider_unavailable"));
});
