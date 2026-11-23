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
}

export const CURRENT_GPS_MAX_AGE_MS = 15_000;
export const SENSOR_CLOCK_SKEW_TOLERANCE_MS = 2_000;

export type CurrentGpsErrorReason =
  | "capture_position_invalid"
  | "latest_position_missing"
  | "latest_position_invalid"
  | "latest_timestamp_invalid"
  | "latest_older_than_max_age"
  | "latest_in_future_beyond_skew"
  | "cached_only_stale";

export interface CurrentGpsAvailabilityDiagnostics {
  reason: "current_gps_unavailable" | null;
  /** Capture request position validity (lat/lng only — no coordinate values). */
  capturePositionValid: boolean;
  latestPositionPresent: boolean;
  latestPositionValid: boolean;
  latestClockDomain: "unix_ms" | "suspected_unix_seconds" | "invalid";
  latestAgeMs: number | null;
  maxAgeMs: number;
  skewToleranceMs: number;
  failureKinds: CurrentGpsErrorReason[];
}

function inferEpochClockDomain(value: number): CurrentGpsAvailabilityDiagnostics["latestClockDomain"] {
  if (!Number.isFinite(value) || value <= 0) return "invalid";
  if (value >= 1_000_000_000 && value < 100_000_000_000) return "suspected_unix_seconds";
  if (value >= 100_000_000_000) return "unix_ms";
  return "invalid";
}

export function validPoint(point: { lat: number; lng: number }): boolean {
  return Number.isFinite(point?.lat) && Math.abs(point.lat) <= 90 &&
    Number.isFinite(point?.lng) && Math.abs(point.lng) <= 180;
}

/**
 * Distinguish current-GPS availability from capture-time GPS.
 * Ages and validity flags only — never lat/lng/accuracy payloads.
 */
export function currentGpsAvailabilityDiagnostics(
  sensors: LastMetersSensors | undefined,
  position: { lat: number; lng: number },
  snapshotTime = Date.now(),
): CurrentGpsAvailabilityDiagnostics {
  const latest = sensors?.latestPosition;
  const failureKinds: CurrentGpsErrorReason[] = [];
  const capturePositionValid = validPoint(position);
  const latestPositionPresent = Boolean(latest);
  const latestPositionValid = Boolean(latest && validPoint(latest));
  const latestClockDomain = latest ? inferEpochClockDomain(latest.timestamp) : "invalid";
  const latestAgeMs = latestClockDomain === "unix_ms" && latest
    ? snapshotTime - latest.timestamp
    : null;

  if (!capturePositionValid) failureKinds.push("capture_position_invalid");
  if (!latestPositionPresent) failureKinds.push("latest_position_missing");
  else if (!latestPositionValid) failureKinds.push("latest_position_invalid");
  if (latestClockDomain === "invalid" || latestClockDomain === "suspected_unix_seconds") {
    failureKinds.push("latest_timestamp_invalid");
  } else if (latest) {
    if (latest.timestamp > snapshotTime + SENSOR_CLOCK_SKEW_TOLERANCE_MS) {
      failureKinds.push("latest_in_future_beyond_skew");
    } else if (latestAgeMs! > CURRENT_GPS_MAX_AGE_MS) {
      failureKinds.push("latest_older_than_max_age");
      // Capture GPS still present on the request is not a current fix.
      if (Number.isFinite(sensors?.positionTimestamp)) failureKinds.push("cached_only_stale");
    }
  }

  return {
    reason: failureKinds.length ? "current_gps_unavailable" : null,
    capturePositionValid,
    latestPositionPresent,
    latestPositionValid,
    latestClockDomain,
    latestAgeMs,
    maxAgeMs: CURRENT_GPS_MAX_AGE_MS,
    skewToleranceMs: SENSOR_CLOCK_SKEW_TOLERANCE_MS,
    failureKinds: [...new Set(failureKinds)],
  };
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
  if (sensors.headingReference !== "true" || sensors.latestHeadingReference !== "true") reasons.push("true_north_unavailable");
  if (!Number.isFinite(heading) || heading! < 0 || heading! >= 360 || !Number.isFinite(sensors.latestHeading) ||
      sensors.latestHeading < 0 || sensors.latestHeading >= 360 || !fresh(sensors.latestHeadingTimestamp, 15_000, snapshotTime)) {
    reasons.push("current_heading_unavailable");
  } else if (angularDifference(heading!, sensors.latestHeading) > 15) reasons.push("turned_since_capture");
  if (currentGpsAvailabilityDiagnostics(sensors, position, snapshotTime).reason) {
    reasons.push("current_gps_unavailable");
  } else if (distanceBetween(position, sensors.latestPosition) > 5) {
    reasons.push("moved_since_capture");
  }
  const latest = sensors.latestPosition;
  if (!Number.isFinite(accuracy) || accuracy! < 0 || accuracy! > 20 || !Number.isFinite(latest?.accuracy) || latest.accuracy < 0 || latest.accuracy > 20) {
    reasons.push("gps_uncertain");
  }
  return reasons;
}

export const RECAPTURE_MESSAGE = "I cannot verify your current position and orientation well enough for a precise turn. Stay in a safe place, hold the phone steady, and take a new photo. Make sure the app is updated and precise location is enabled.";
