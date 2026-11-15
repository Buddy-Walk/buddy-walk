import assert from "node:assert/strict";
import test from "node:test";
import { assessMovement, type GpsIntervalSummary } from "../utils/movementAssessment";
import type { GpsQualityInput } from "../utils/gpsQuality";
import type { MotionIntervalSummary } from "../utils/motionActivityInterval";
import { createGpsSampleHistory } from "../utils/gpsSampleHistory";
import { toGpsSample } from "../utils/gpsQuality";

const captureAt = 1_800_000_000_000;
const origin = { lat: 0, lng: 10 };
const north = (meters: number) => ({ ...origin, lat: meters / 6371000 * 180 / Math.PI });
const gps = (meters = 2, accuracy = 5, reported: number | null = meters / 20, seconds = 20) => {
  const capture = { ...origin, accuracy, timestamp: captureAt, reportedSpeed: 0 };
  const history = createGpsSampleHistory(toGpsSample(capture), captureAt);
  for (let i = 1; i <= 4; i++) history.observe(toGpsSample({ ...north(meters * i / 4), accuracy,
    timestamp: captureAt + seconds * 1000 * i / 4, reportedSpeed: reported }), captureAt + seconds * 1000 * i / 4);
  const summary = history.snapshot(captureAt + seconds * 1000).summary;
  return { capture, latest: { ...north(meters), accuracy, timestamp: captureAt + seconds * 1000, reportedSpeed: reported },
    photoCapturedAt: captureAt, observedAt: captureAt + seconds * 1000, history: summary, interval: summary };
};
const motion = (patch: Partial<MotionIntervalSummary> = {}): MotionIntervalSummary => ({
  version: 1, platform: "ios", availability: "available", captureAt,
  startedAt: captureAt, observedUntil: captureAt + 20_000,
  events: 0, movingEvents: 0, stationaryEvents: 0, unknownEvents: 0,
  conflictingEvents: 0, ignoredEvents: 0, maxMovingConfidence: -1, maxStationaryConfidence: -1,
  postCaptureMovingEvents: 0, maxPostCaptureMovingConfidence: -1, preCaptureMovingContext: false, timestampSemantics: "activity_start",
  interrupted: false, incompleteCoverage: true, ...patch,
});
const stationary = () => motion({ events: 1, stationaryEvents: 1, maxStationaryConfidence: 2 });
const walking = () => motion({ events: 1, movingEvents: 1, postCaptureMovingEvents: 1,
  maxMovingConfidence: 2, maxPostCaptureMovingConfidence: 2 });
const interval = (patch: Partial<GpsIntervalSummary> = {}): GpsIntervalSummary => ({
  samples: 2, duplicateSamples: 0, outOfOrderSamples: 0, invalidSamples: 0,
  maxDisplacementMeters: 2, significantExcursionObserved: false, ...patch,
});

for (const [meters, accuracy, state, rationale] of [
  [2, 3, "movement_not_detected", "stationary_activity_corroborates_not_proof_of_no_movement"],
  [8, 6, "movement_uncertain", "displacement_overlaps_reported_gps_noise"],
  [15, 12, "movement_uncertain", "displacement_overlaps_reported_gps_noise"],
  [8, 2, "movement_uncertain", "gps_motion_conflict"],
  [15, 5, "movement_uncertain", "gps_motion_conflict"],
] as const) {
  test(`stationary activity with ${meters} meter drift and ${accuracy} meter accuracy: ${state}`, () => {
    // Simulated ground truth is stationary; displaced GPS alone is not the ground truth.
    const result = assessMovement({ ...gps(meters, accuracy, 0), motion: stationary() });
    assert.equal(result.state, state);
    assert.ok(result.rationale.includes(rationale));
    assert.equal(result.mode, "shadow");
    assert.equal(result.version, "gps-speed-motion-shadow-v2");
  });
}

for (const [meters, accuracy] of [[5, 5], [10, 5], [20, 15]]) {
  test(`post-capture walking corroborates a ${meters} meter pedestrian span`, () => {
    const result = assessMovement({ ...gps(meters, accuracy), motion: walking() });
    assert.equal(result.state, "movement_detected");
    assert.equal(result.gps.displacementMeters, meters);
    assert.equal(result.motion?.postCaptureMovingEvents, 1);
  });
}

test("walking followed by stationary activity keeps the earlier movement evidence", () => {
  const result = assessMovement({ ...gps(5), motion: { ...walking(), events: 2,
    stationaryEvents: 1, maxStationaryConfidence: 2 } });
  assert.equal(result.state, "movement_detected");
  assert.ok(result.rationale.includes("post_capture_activity_and_gps_displacement"));
});

test("walking followed by stationary near the capture remains unresolved without a measured excursion", () => {
  const result = assessMovement({ ...gps(2), motion: { ...walking(), events: 2,
    stationaryEvents: 1, maxStationaryConfidence: 2 } });
  assert.equal(result.state, "movement_uncertain");
  assert.ok(result.rationale.includes("activity_without_resolved_displacement"));
});

test("a credible interval excursion retains out-and-back movement when the endpoint returns", () => {
  const input = gps(0);
  const history = createGpsSampleHistory(toGpsSample(input.capture), captureAt);
  history.observe(toGpsSample({ ...north(15), accuracy: 5, timestamp: captureAt + 10_000, reportedSpeed: 1.5 }), captureAt + 10_000);
  history.observe(toGpsSample({ ...north(0), accuracy: 5, timestamp: captureAt + 20_000, reportedSpeed: 1.5 }), captureAt + 20_000);
  const result = assessMovement({ ...input, history: history.snapshot(captureAt + 20_000).summary, motion: walking() });
  assert.equal(result.state, "movement_detected");
  assert.equal(result.gps.displacementMeters, 0);
  assert.ok(result.rationale.includes("credible_gps_excursion_during_interval"));
});

test("iOS pre-capture walking context does not prove movement after capture", () => {
  const result = assessMovement({ ...gps(5), motion: { ...walking(), postCaptureMovingEvents: 0,
    preCaptureMovingContext: true } });
  assert.equal(result.state, "movement_uncertain");
  assert.ok(result.rationale.includes("movement_may_be_hidden_by_gps"));
});

test("Android delivery timestamps do not prove when walking began", () => {
  const result = assessMovement({ ...gps(5), motion: { ...walking(), platform: "android",
    timestampSemantics: "delivery_time", postCaptureMovingEvents: 0 } });
  assert.equal(result.state, "movement_uncertain");
  assert.ok(result.rationale.includes("activity_start_time_unavailable"));
});

test("low-confidence walking cannot corroborate displacement inside reported noise", () => {
  const result = assessMovement({ ...gps(5), motion: { ...walking(), maxMovingConfidence: 0, maxPostCaptureMovingConfidence: 0 } });
  assert.equal(result.state, "movement_uncertain");
});

test("high-confidence pre-capture walking cannot upgrade low-confidence post-capture activity", () => {
  const result = assessMovement({ ...gps(5), motion: { ...walking(), events: 2, movingEvents: 2,
    preCaptureMovingContext: true, maxMovingConfidence: 2, maxPostCaptureMovingConfidence: 0 } });
  assert.equal(result.state, "movement_uncertain");
  assert.ok(result.rationale.includes("activity_without_resolved_displacement"));
});

test("simultaneous moving and stationary flags remain uncertain even with GPS displacement", () => {
  const result = assessMovement({ ...gps(20), motion: { ...walking(), stationaryEvents: 1,
    maxStationaryConfidence: 2, conflictingEvents: 1 } });
  assert.equal(result.state, "movement_uncertain");
  assert.ok(result.rationale.includes("conflicting_activity_flags"));
});

test("denied motion permission is retained and cannot turn an interrupted interval into stationary proof", () => {
  const result = assessMovement({ ...gps(), motion: motion({ availability: "permission_denied",
    interrupted: true, stopReason: "permission_denied" }) });
  assert.equal(result.state, "movement_uncertain");
  assert.equal(result.motion?.stationaryEvents, 0);
  assert.ok(result.rationale.includes("interval_contains_missing_or_unreliable_evidence"));
});

test("missing and unsupported motion cannot turn quiet GPS into no movement detected", () => {
  for (const summary of [undefined, motion({ availability: "unsupported", timestampSemantics: "unavailable" })]) {
    const result = assessMovement({ ...gps(), motion: summary });
    assert.equal(result.state, "movement_uncertain");
    assert.ok(result.rationale.includes("motion_evidence_unavailable_or_insufficient"));
    assert.equal(result.rationale.some(value => value.includes("stationary_activity_observed")), false);
  }
});

const qualityCases: Array<[string, (value: GpsQualityInput) => GpsQualityInput, string]> = [
  ["poor accuracy", value => ({ ...value, latest: { ...value.latest!, accuracy: 21 } }), "latest_accuracy_poor"],
  ["missing accuracy", value => ({ ...value, capture: { ...value.capture!, accuracy: undefined } }), "capture_accuracy_missing"],
  ["invalid accuracy", value => ({ ...value, latest: { ...value.latest!, accuracy: NaN } }), "latest_accuracy_invalid"],
  ["stale latest", value => ({ ...value, observedAt: captureAt + 36_000 }), "latest_stale"],
  ["missing timestamp", value => ({ ...value, latest: { ...value.latest!, timestamp: undefined } }), "latest_timestamp_missing"],
  ["invalid timestamp", value => ({ ...value, capture: { ...value.capture!, timestamp: 0 } }), "capture_timestamp_invalid"],
  ["future timestamp", value => ({ ...value, latest: { ...value.latest!, timestamp: value.observedAt + 2001 } }), "latest_timestamp_future"],
  ["cached fix", value => ({ ...value, latest: { ...value.latest!, timestamp: captureAt } }), "duplicate_measurement"],
  ["missing capture", value => ({ ...value, capture: undefined }), "capture_missing"],
];
for (const [label, change, issue] of qualityCases) {
  test(`${label} keeps classification uncertain despite confident walking`, () => {
    const result = assessMovement({ ...change(gps(20)), motion: walking() });
    assert.equal(result.state, "movement_uncertain");
    assert.ok(result.rationale.includes("gps_quality_insufficient"));
    assert.ok(result.gps.issues.includes(issue));
  });
}

test("invalid and out-of-order GPS interval samples prevent a no-movement classification", () => {
  for (const patch of [{ invalidSamples: 1 }, { outOfOrderSamples: 1 }]) {
    const input = gps();
    const result = assessMovement({ ...input, motion: stationary(), history: { ...input.history, ...patch, rejectedSamples: 1 } });
    assert.equal(result.state, "movement_uncertain");
    assert.ok(result.rationale.includes("interval_contains_missing_or_unreliable_evidence"));
  }
});

test("ignored activity events and interrupted collection keep quiet endpoints uncertain", () => {
  for (const patch of [{ ignoredEvents: 1 }, { interrupted: true }]) {
    const result = assessMovement({ ...gps(), motion: motion(patch) });
    assert.equal(result.state, "movement_uncertain");
  }
});

test("unknown activity is not independent stationary evidence", () => {
  const result = assessMovement({ ...gps(), motion: motion({ events: 1, unknownEvents: 1 }) });
  assert.equal(result.state, "movement_uncertain");
  assert.ok(result.rationale.includes("motion_evidence_unavailable_or_insufficient"));
});

test("movement assessments snapshot interval and motion summaries without mutating callers", () => {
  const suppliedMotion = walking();
  const suppliedInterval = interval();
  const result = assessMovement({ ...gps(10), motion: suppliedMotion, interval: suppliedInterval });
  suppliedMotion.movingEvents = 100;
  suppliedInterval.samples = 100;
  assert.equal(result.motion?.movingEvents, 1);
  assert.equal(result.interval?.samples, 2);
  assert.equal(result.state, "movement_detected");
});

test("GPS-derived speed conflicting with reported speed remains uncertain even with walking activity", () => {
  const result = assessMovement({ ...gps(10, 1, 0, 4), motion: walking() });
  assert.equal(result.state, "movement_uncertain");
  assert.ok(result.reasons.includes("gps_and_reported_speed_disagree"));
  assert.ok(result.history!.apparentSpeed.mean! > 2);
  assert.equal(result.history!.reportedSpeed.mean, 0);
});

test("simulated slow walking at 0.2m/s can retain significant movement without a speed-only walking inference", () => {
  const result = assessMovement({ ...gps(6, 2, 0.2, 30), motion: walking() });
  assert.equal(result.state, "movement_detected");
  assert.ok(result.history!.apparentSpeed.mean! < 0.3);
  assert.equal(result.history!.significantExcursionObserved, true);
});

test("reported movement with very small displacement is unresolved, not stationary", () => {
  const result = assessMovement({ ...gps(2, 3, 0.6), motion: stationary() });
  assert.equal(result.state, "movement_uncertain");
  assert.ok(result.reasons.includes("gps_motion_conflict"));
});

test("missing reported speed does not become zero or a no-movement decision", () => {
  const result = assessMovement({ ...gps(2, 3, null), motion: stationary() });
  assert.equal(result.state, "movement_uncertain");
  assert.equal(result.history!.reportedSpeed.mean, null);
  assert.ok(result.history!.reportedSpeedMissingSamples > 0);
});

test("a single stationary activity event without GPS history is insufficient", () => {
  const input = gps();
  const result = assessMovement({ ...input, history: undefined, motion: stationary() });
  assert.equal(result.state, "movement_uncertain");
  assert.ok(result.reasons.includes("gps_history_missing"));
});

test("a gap during long server processing prevents a no-movement conclusion", () => {
  const input = gps(0, 3, 0, 60);
  const result = assessMovement({ ...input, captureReferenceAt: captureAt + 1000, motion: stationary() });
  assert.equal(result.state, "movement_uncertain");
  assert.ok(result.reasons.includes("gps_coverage_insufficient"));
  assert.ok(result.gpsQualityIssues.includes("gps_coverage_gap"));
});

test("old endpoint-only callers get an explicit uncertain result with stable structured fields", () => {
  const result = assessMovement({ capture: { ...origin, accuracy: 3, timestamp: captureAt },
    latest: { ...origin, accuracy: 3, timestamp: captureAt + 1000 },
    photoCapturedAt: captureAt, observedAt: captureAt + 1000 });
  assert.equal(result.state, "movement_uncertain");
  assert.equal(result.sampleCount, 0);
  assert.equal(result.displacementMeters, 0);
  assert.ok(Array.isArray(result.gpsQualityIssues));
  assert.deepEqual(result.reasons, result.rationale);
});
