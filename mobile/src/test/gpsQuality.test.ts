import assert from "node:assert/strict";
import test from "node:test";
import { assessGpsQuality, GpsMeasurement, GpsQualityInput } from "../utils/gpsQuality";

const now = 1_800_000_000_000;
const origin = { lat: 40.7, lng: -74 };
const north = (meters: number) => ({ ...origin, lat: origin.lat + meters / 6371000 * 180 / Math.PI });
const input = (meters = 5, accuracy = 5, intervalMs = 10_000): GpsQualityInput => ({
  capture: { ...origin, accuracy, timestamp: now - intervalMs },
  latest: { ...north(meters), accuracy, timestamp: now },
  photoCapturedAt: now - intervalMs,
  observedAt: now,
});
const withMeasurement = (label: "capture" | "latest", patch: Partial<GpsMeasurement>) => {
  const value = input();
  return { ...value, [label]: { ...value[label], ...patch } };
};

test("GPS quality preserves 2, 8 and 15 meter drift as diagnostics without claiming movement", () => {
  for (const meters of [2, 8, 15]) {
    const result = assessGpsQuality(input(meters));
    assert.equal(result.usable, true);
    assert.deepEqual(result.issues, []);
    assert.ok(Math.abs(result.displacementMeters! - meters) < 0.001);
    assert.equal(result.uncertaintyMeters, Math.hypot(5, 5));
    assert.ok(Math.abs(result.adjustedSpeedMps! - Math.max(0, meters - Math.hypot(5, 5)) / 10) < 0.001);
    assert.equal("moved" in result, false);
  }
});

test("5, 10 and 20 meter pedestrian spans retain displacement and measurement intervals", () => {
  for (const meters of [5, 10, 20]) {
    const result = assessGpsQuality(input(meters, 3, meters * 1000));
    assert.equal(result.usable, true);
    assert.ok(Math.abs(result.displacementMeters! - meters) < 0.001);
    assert.equal(result.intervalMs, meters * 1000);
    assert.equal(result.captureTimestamp, now - meters * 1000);
    assert.equal(result.latestTimestamp, now);
    assert.equal(result.captureAccuracyMeters, 3);
    assert.equal(result.latestAccuracyMeters, 3);
  }
});

test("positive accuracy through 20 meters is usable; poor accuracy on either fix is rejected", () => {
  for (const accuracy of [0.1, 5, 20]) assert.equal(assessGpsQuality(input(5, accuracy)).usable, true);
  for (const label of ["capture", "latest"] as const) {
    const result = assessGpsQuality(withMeasurement(label, { accuracy: 20.001 }));
    assert.equal(result.usable, false);
    assert.ok(result.issues.includes(`${label}_accuracy_poor`));
  }
});

test("missing, nonfinite, zero and negative accuracies cannot support GPS quality", () => {
  for (const label of ["capture", "latest"] as const) {
    for (const accuracy of [undefined, NaN, Infinity, -Infinity, 0, -1]) {
      const result = assessGpsQuality(withMeasurement(label, { accuracy }));
      assert.equal(result.usable, false);
      assert.ok(result.issues.includes(`${label}_accuracy_${accuracy === undefined ? "missing" : "invalid"}`));
      assert.equal(result.uncertaintyMeters, undefined);
      assert.equal(result.adjustedSpeedMps, undefined);
    }
  }
});

test("missing measurements and invalid coordinates are explicit quality failures", () => {
  for (const label of ["capture", "latest"] as const) {
    const missing = assessGpsQuality({ ...input(), [label]: undefined });
    assert.equal(missing.usable, false);
    assert.ok(missing.issues.includes(`${label}_missing`));
    assert.equal(missing.displacementMeters, undefined);
    for (const patch of [{ lat: NaN }, { lng: Infinity }, { lat: 90.01 }, { lng: -180.01 }]) {
      const result = assessGpsQuality(withMeasurement(label, patch));
      assert.equal(result.usable, false);
      assert.ok(result.issues.includes(`${label}_coordinates_invalid`));
      assert.equal(result.displacementMeters, undefined);
    }
  }
});

test("missing and invalid fix timestamps are rejected without producing derived intervals", () => {
  for (const label of ["capture", "latest"] as const) {
    for (const timestamp of [undefined, NaN, Infinity, -Infinity, 0, -1]) {
      const result = assessGpsQuality(withMeasurement(label, { timestamp }));
      assert.equal(result.usable, false);
      assert.ok(result.issues.includes(`${label}_timestamp_${timestamp === undefined ? "missing" : "invalid"}`));
      assert.equal(result.intervalMs, undefined);
      assert.equal(result.adjustedSpeedMps, undefined);
    }
  }
});

test("invalid observation, photo and capture reference times reject the pair", () => {
  for (const [field, code] of [
    ["observedAt", "observation_timestamp_invalid"],
    ["photoCapturedAt", "photo_timestamp_invalid"],
    ["captureReferenceAt", "capture_reference_timestamp_invalid"],
  ] as const) {
    for (const value of [0, -1, NaN, Infinity, -Infinity]) {
      const result = assessGpsQuality({ ...input(), [field]: value });
      assert.equal(result.usable, false);
      assert.ok(result.issues.includes(code));
    }
  }
});

test("capture fixes must be within ten seconds of the photo on either side", () => {
  for (const offset of [-10_001, 10_001]) {
    const result = assessGpsQuality(withMeasurement("capture", { timestamp: now - 10_000 + offset }));
    assert.equal(result.usable, false);
    assert.ok(result.issues.includes("capture_not_near_photo"));
  }
  for (const offset of [-10_000, 2000]) {
    const value = input(5, 5, 20_000);
    value.capture!.timestamp = value.photoCapturedAt + offset;
    assert.equal(assessGpsQuality(value).usable, true);
  }
});

test("a capture fix cannot postdate its photo beyond the two-second clock tolerance", () => {
  for (const offset of [2000, 2001, 10_000]) {
    const value = input(5, 5, 20_000);
    value.capture!.timestamp = value.photoCapturedAt + offset;
    const result = assessGpsQuality(value);
    assert.equal(result.usable, offset === 2000);
    assert.equal(result.issues.includes("capture_after_photo"), offset > 2000);
  }
});

test("capture age is limited to sixty seconds, with an optional fixed capture reference", () => {
  assert.equal(assessGpsQuality(input(5, 5, 60_000)).usable, true);
  const old = input(5, 5, 60_001);
  assert.ok(assessGpsQuality(old).issues.includes("capture_stale"));
  const delayed = { ...input(5, 5, 90_000), captureReferenceAt: now - 30_000 };
  assert.equal(assessGpsQuality(delayed).usable, true);
});

test("latest fixes are fresh through fifteen seconds and are stale beyond that boundary", () => {
  for (const age of [15_000, 15_001]) {
    const value = input(5, 5, 30_000);
    value.latest!.timestamp = now - age;
    const result = assessGpsQuality(value);
    assert.equal(result.usable, age === 15_000);
    assert.equal(result.issues.includes("latest_stale"), age > 15_000);
  }
});

test("the two-second future clock tolerance applies to fixes and photo/reference times", () => {
  const tolerated = input();
  tolerated.latest!.timestamp = now + 2000;
  assert.equal(assessGpsQuality(tolerated).usable, true);
  for (const label of ["capture", "latest"] as const) {
    const result = assessGpsQuality(withMeasurement(label, { timestamp: now + 2001 }));
    assert.equal(result.usable, false);
    assert.ok(result.issues.includes(`${label}_timestamp_future`));
  }
  assert.ok(assessGpsQuality({ ...input(), photoCapturedAt: now + 2001 }).issues.includes("photo_timestamp_future"));
  assert.ok(assessGpsQuality({ ...input(), captureReferenceAt: now + 2001 }).issues.includes("capture_reference_timestamp_future"));
});

test("a latest fix preceding the photo or the capture cannot corroborate current movement", () => {
  const beforePhoto = input(5, 5, 20_000);
  beforePhoto.photoCapturedAt = now - 10_000;
  beforePhoto.latest!.timestamp = now - 11_000;
  const result = assessGpsQuality(beforePhoto);
  assert.equal(result.usable, false);
  assert.ok(result.issues.includes("latest_before_photo"));
  assert.equal(result.issues.includes("latest_before_capture"), false);
  const beforeCapture = assessGpsQuality(withMeasurement("latest", { timestamp: now - 11_000 }));
  assert.ok(beforeCapture.issues.includes("latest_before_capture"));
  assert.equal(beforeCapture.intervalMs, -1000);
  assert.equal(beforeCapture.adjustedSpeedMps, undefined);
});

test("cached fixes with the same timestamp are unusable even at identical coordinates", () => {
  const value = input(0);
  value.latest!.timestamp = value.capture!.timestamp;
  const result = assessGpsQuality(value);
  assert.equal(result.usable, false);
  assert.ok(result.issues.includes("duplicate_measurement"));
  assert.equal(result.issues.includes("inconsistent_timestamp"), false);
  assert.equal(result.displacementMeters, 0);
  assert.equal(result.intervalMs, 0);
  assert.equal(result.adjustedSpeedMps, undefined);
});

test("different positions with the same timestamp are both duplicate and inconsistent", () => {
  const value = input(8);
  value.latest!.timestamp = value.capture!.timestamp;
  const result = assessGpsQuality(value);
  assert.equal(result.usable, false);
  assert.ok(result.issues.includes("duplicate_measurement"));
  assert.ok(result.issues.includes("inconsistent_timestamp"));
  assert.equal(result.adjustedSpeedMps, undefined);
});

test("a short-interval GPS jump is rejected after accounting for the heuristic noise scale", () => {
  const jump = assessGpsQuality(input(100, 3, 1000));
  assert.equal(jump.usable, false);
  assert.ok(jump.issues.includes("implausible_jump"));
  assert.ok(jump.adjustedSpeedMps! > 90);
  const noise = assessGpsQuality(input(15, 20, 1000));
  assert.equal(noise.usable, true);
  assert.equal(noise.adjustedSpeedMps, 0);
  assert.equal(assessGpsQuality(input(20, 1, 3000)).usable, true);
  assert.ok(assessGpsQuality(input(20, 1, 2000)).issues.includes("implausible_jump"));
});

test("quality diagnostics have finite numeric values and do not expose raw locations", () => {
  const values = [input(), input(5, Number.MAX_VALUE), input(5, NaN), input(5, Infinity),
    withMeasurement("capture", { timestamp: NaN }), withMeasurement("latest", { lat: NaN })];
  for (const value of values) {
    const result = assessGpsQuality(value);
    for (const [key, diagnostic] of Object.entries(result)) {
      if (typeof diagnostic === "number") assert.ok(Number.isFinite(diagnostic), `${key} must be finite`);
    }
    for (const rawKey of ["lat", "lng", "capture", "latest", "point", "location"]) {
      assert.equal(rawKey in result, false);
    }
    assert.equal(JSON.stringify(result).includes('"lat"'), false);
  }
});
