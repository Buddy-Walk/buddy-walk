import assert from "node:assert/strict";
import test from "node:test";
import { resolveProximityGate } from "../../server/services/lastMetersProximityGate";
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
