export interface SafetyPosition { lat: number; lng: number; accuracy: number; timestamp: number }
export interface LastMetersSensors {
  photoCapturedAt: number;
  positionTimestamp: number;
  headingTimestamp: number;
  headingReference: "true" | "magnetic" | "unknown";
  latestPosition: SafetyPosition;
  latestHeading: number;
  latestHeadingTimestamp: number;
  latestHeadingReference: "true" | "magnetic" | "unknown";
  /**
   * Optional Expo compass accuracy (0–3) when recorded by the client (#153).
   * Diagnostic only — never used to relax `TURNED_SINCE_CAPTURE_MAX_DEGREES`.
   */
  latestHeadingAccuracyLevel?: number | null;
}

/**
 * Shortest-arc heading change that withholds a stale capture pose.
 * Do not relax without a Safety Gate review.
 */
export const TURNED_SINCE_CAPTURE_MAX_DEGREES = 15;
/** Live heading must be fresh vs the evaluation snapshot clock. */
export const CURRENT_HEADING_MAX_AGE_MS = 15_000;
export const SENSOR_CLOCK_SKEW_TOLERANCE_MS = 2_000;

export type TurnedSinceCaptureFailureKind =
  | "capture_heading_missing"
  | "capture_heading_invalid"
  | "latest_heading_missing"
  | "latest_heading_invalid"
  | "latest_heading_stale"
  | "circular_delta_above_max";

/**
 * Privacy-preserving post-capture heading report.
 * Records angles, ages, and circular delta only — never lat/lng.
 */
export interface TurnedSinceCaptureDiagnostics {
  reason: "turned_since_capture" | null;
  captureHeadingDegrees: number | null;
  latestHeadingDegrees: number | null;
  /** Shortest-arc |capture − latest|; null when either heading is unusable. */
  circularDeltaDegrees: number | null;
  maxDeltaDegrees: number;
  captureHeadingTimestamp: number | null;
  latestHeadingTimestamp: number | null;
  captureHeadingAgeMs: number | null;
  latestHeadingAgeMs: number | null;
  /** Expo accuracy when the client recorded it; null when unavailable. */
  latestHeadingAccuracyLevel: number | null;
  snapshotTime: number;
  failureKinds: TurnedSinceCaptureFailureKind[];
}

function headingSample(
  value: number | undefined,
  which: "capture" | "latest",
): { degrees: number | null; kinds: TurnedSinceCaptureFailureKind[] } {
  const missing = `${which}_heading_missing` as TurnedSinceCaptureFailureKind;
  const invalid = `${which}_heading_invalid` as TurnedSinceCaptureFailureKind;
  if (value === undefined || value === null || (typeof value === "number" && Number.isNaN(value))) {
    return { degrees: null, kinds: [missing] };
  }
  if (!Number.isFinite(value) || value < 0 || value >= 360) {
    return { degrees: Number.isFinite(value) ? value : null, kinds: [invalid] };
  }
  return { degrees: value, kinds: [] };
}

/**
 * Instrument capture vs current heading for `turned_since_capture`.
 * Threshold remains 15°; wrap-around uses shortest-arc `angularDifference`.
 * Unavailable/stale samples are classified separately from a real rotation.
 */
export function turnedSinceCaptureDiagnostics(
  captureHeading: number | undefined,
  sensors: Pick<
    LastMetersSensors,
    "latestHeading" | "latestHeadingTimestamp" | "headingTimestamp" | "latestHeadingAccuracyLevel"
  > | undefined,
  snapshotTime = Date.now(),
): TurnedSinceCaptureDiagnostics {
  const capture = headingSample(captureHeading, "capture");
  const latest = headingSample(sensors?.latestHeading, "latest");
  const failureKinds: TurnedSinceCaptureFailureKind[] = [...capture.kinds, ...latest.kinds];
  const captureTs = Number.isFinite(sensors?.headingTimestamp) ? sensors!.headingTimestamp : null;
  const latestTs = Number.isFinite(sensors?.latestHeadingTimestamp) ? sensors!.latestHeadingTimestamp : null;
  const captureHeadingAgeMs = captureTs !== null ? snapshotTime - captureTs : null;
  const latestHeadingAgeMs = latestTs !== null ? snapshotTime - latestTs : null;
  const accuracyRaw = sensors?.latestHeadingAccuracyLevel;
  const latestHeadingAccuracyLevel =
    typeof accuracyRaw === "number" && Number.isFinite(accuracyRaw) ? accuracyRaw : null;

  if (latestTs === null || latestHeadingAgeMs === null ||
      latestTs > snapshotTime + SENSOR_CLOCK_SKEW_TOLERANCE_MS ||
      latestHeadingAgeMs > CURRENT_HEADING_MAX_AGE_MS) {
    failureKinds.push("latest_heading_stale");
  }

  let circularDeltaDegrees: number | null = null;
  const headingsUsable =
    capture.kinds.length === 0 && latest.kinds.length === 0 && !failureKinds.includes("latest_heading_stale");
  if (headingsUsable && capture.degrees !== null && latest.degrees !== null) {
    circularDeltaDegrees = angularDifference(capture.degrees, latest.degrees);
    if (circularDeltaDegrees > TURNED_SINCE_CAPTURE_MAX_DEGREES) {
      failureKinds.push("circular_delta_above_max");
    }
  }

  const turnedKinds = failureKinds.filter(kind => kind === "circular_delta_above_max");
  return {
    reason: turnedKinds.length ? "turned_since_capture" : null,
    captureHeadingDegrees: capture.degrees,
    latestHeadingDegrees: latest.degrees,
    circularDeltaDegrees,
    maxDeltaDegrees: TURNED_SINCE_CAPTURE_MAX_DEGREES,
    captureHeadingTimestamp: captureTs,
    latestHeadingTimestamp: latestTs,
    captureHeadingAgeMs,
    latestHeadingAgeMs,
    latestHeadingAccuracyLevel,
    snapshotTime,
    failureKinds: [...new Set(failureKinds)],
  };
}

export function validPoint(point: { lat: number; lng: number }): boolean {
  return Number.isFinite(point?.lat) && Math.abs(point.lat) <= 90 &&
    Number.isFinite(point?.lng) && Math.abs(point.lng) <= 180;
}

export function distanceBetween(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = Math.PI / 180;
  const h = Math.sin((b.lat - a.lat) * rad / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin((b.lng - a.lng) * rad / 2) ** 2;
  return 6371000 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function bearingBetween(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = Math.PI / 180;
  const d = (b.lng - a.lng) * rad;
  return (Math.atan2(Math.sin(d) * Math.cos(b.lat * rad),
    Math.cos(a.lat * rad) * Math.sin(b.lat * rad) - Math.sin(a.lat * rad) * Math.cos(b.lat * rad) * Math.cos(d)) / rad + 360) % 360;
}

export function angularDifference(a: number, b: number): number {
  return Math.abs(((b - a + 540) % 360 + 360) % 360 - 180);
}

export function sensorSafetyReasons(
  sensors: LastMetersSensors | undefined, position: { lat: number; lng: number },
  heading: number | undefined, accuracy: number | undefined, now = Date.now(), snapshotTime = now,
): string[] {
  if (!sensors) return ["capture_metadata_missing"];
  const reasons: string[] = [];
  const fresh = (time: number, age: number, reference = now) =>
    Number.isFinite(time) && time <= reference + SENSOR_CLOCK_SKEW_TOLERANCE_MS && reference - time <= age;
  if (!fresh(sensors.photoCapturedAt, 60_000)) reasons.push("photo_stale");
  if (!fresh(sensors.positionTimestamp, 60_000) || Math.abs(sensors.photoCapturedAt - sensors.positionTimestamp) > 10_000) {
    reasons.push("capture_gps_stale");
  }
  if (!fresh(sensors.headingTimestamp, 60_000) || Math.abs(sensors.photoCapturedAt - sensors.headingTimestamp) > 5000) {
    reasons.push("capture_heading_stale");
  }
  if (sensors.headingReference !== "true" || sensors.latestHeadingReference !== "true") {
    reasons.push("true_north_unavailable");
  }
  const turned = turnedSinceCaptureDiagnostics(heading, sensors, snapshotTime);
  const headingUnusable = turned.failureKinds.some(kind =>
    kind === "capture_heading_missing" || kind === "capture_heading_invalid" ||
    kind === "latest_heading_missing" || kind === "latest_heading_invalid" ||
    kind === "latest_heading_stale");
  if (headingUnusable) reasons.push("current_heading_unavailable");
  else if (turned.reason) reasons.push("turned_since_capture");
  const latest = sensors.latestPosition;
  if (!validPoint(position) || !latest || !validPoint(latest) || !fresh(latest.timestamp, CURRENT_HEADING_MAX_AGE_MS, snapshotTime)) {
    reasons.push("current_gps_unavailable");
  } else if (distanceBetween(position, latest) > 5) reasons.push("moved_since_capture");
  if (!Number.isFinite(accuracy) || accuracy! < 0 || accuracy! > 20 || !Number.isFinite(latest?.accuracy) || latest.accuracy < 0 || latest.accuracy > 20) {
    reasons.push("gps_uncertain");
  }
  return reasons;
}

export const RECAPTURE_MESSAGE = "I cannot verify your current position and orientation well enough for a precise turn. Stay in a safe place, hold the phone steady, and take a new photo. Make sure the app is updated and precise location is enabled.";
