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

/** Capture-time fields required before any precise guidance that depends on this photo. */
export const REQUIRED_CAPTURE_METADATA_FIELDS = [
  "photoCapturedAt",
  "positionTimestamp",
  "headingTimestamp",
  "headingReference",
] as const;

export type CaptureMetadataField =
  | (typeof REQUIRED_CAPTURE_METADATA_FIELDS)[number]
  | "sensors"
  | "latestPosition"
  | "latestHeading"
  | "latestHeadingTimestamp"
  | "latestHeadingReference";

/** Documented capture-GPS freshness policy (milliseconds). Do not relax without a Safety Gate review. */
export const CAPTURE_GPS_MAX_AGE_MS = 60_000;
export const CAPTURE_GPS_PHOTO_ALIGNMENT_MS = 10_000;
export const CURRENT_GPS_MAX_AGE_MS = 15_000;
export const SENSOR_CLOCK_SKEW_TOLERANCE_MS = 2_000;

export type EpochClockDomain = "unix_ms" | "suspected_unix_seconds" | "invalid";

/** Classify epoch units without converting — mismatched domains must not authorize a turn. */
export function inferEpochClockDomain(value: number): EpochClockDomain {
  if (!Number.isFinite(value) || value <= 0) return "invalid";
  // Unix seconds for 2001–2286 sit near 1e9–1e10; JS Date.now() ms sits near 1e12–1e13.
  if (value >= 1_000_000_000 && value < 100_000_000_000) return "suspected_unix_seconds";
  if (value >= 100_000_000_000) return "unix_ms";
  return "invalid";
}

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
  latestClockDomain: EpochClockDomain;
  latestAgeMs: number | null;
  maxAgeMs: number;
  skewToleranceMs: number;
  failureKinds: CurrentGpsErrorReason[];
}

export interface CaptureGpsFreshnessDiagnostics {
  reason: "capture_gps_stale" | null;
  photoClockDomain: EpochClockDomain;
  gpsClockDomain: EpochClockDomain;
  /** Age of capture GPS vs evaluation clock; null when GPS timestamp is not usable as ms. */
  gpsAgeMs: number | null;
  /** Absolute gap between photo and GPS sample clocks; null when either domain is unusable. */
  photoGpsDeltaMs: number | null;
  maxAgeMs: number;
  photoAlignmentMs: number;
  skewToleranceMs: number;
  failureKinds: Array<
    | "gps_timestamp_invalid"
    | "gps_clock_domain_mismatch"
    | "gps_older_than_max_age"
    | "gps_in_future_beyond_skew"
    | "photo_gps_misaligned"
  >;
}

function ageMs(reference: number, sample: number): number {
  return reference - sample;
}

/**
 * Privacy-preserving capture-GPS freshness report.
 * Returns ages and domains only — never coordinates or accuracy meters.
 */
export function captureGpsFreshnessDiagnostics(
  sensors: LastMetersSensors,
  now = Date.now(),
): CaptureGpsFreshnessDiagnostics {
  const photoClockDomain = inferEpochClockDomain(sensors.photoCapturedAt);
  const gpsClockDomain = inferEpochClockDomain(sensors.positionTimestamp);
  const failureKinds: CaptureGpsFreshnessDiagnostics["failureKinds"] = [];

  if (gpsClockDomain === "invalid") failureKinds.push("gps_timestamp_invalid");
  if (
    gpsClockDomain === "suspected_unix_seconds" ||
    (photoClockDomain !== "invalid" && gpsClockDomain !== "invalid" && photoClockDomain !== gpsClockDomain)
  ) {
    failureKinds.push("gps_clock_domain_mismatch");
  }

  const gpsUsable = gpsClockDomain === "unix_ms";
  const photoUsable = photoClockDomain === "unix_ms";
  const gpsAgeMs = gpsUsable ? ageMs(now, sensors.positionTimestamp) : null;
  const photoGpsDeltaMs = gpsUsable && photoUsable
    ? Math.abs(sensors.photoCapturedAt - sensors.positionTimestamp)
    : null;

  if (gpsUsable) {
    if (sensors.positionTimestamp > now + SENSOR_CLOCK_SKEW_TOLERANCE_MS) {
      failureKinds.push("gps_in_future_beyond_skew");
    } else if (gpsAgeMs! > CAPTURE_GPS_MAX_AGE_MS) {
      failureKinds.push("gps_older_than_max_age");
    }
  }
  if (photoGpsDeltaMs !== null && photoGpsDeltaMs > CAPTURE_GPS_PHOTO_ALIGNMENT_MS) {
    failureKinds.push("photo_gps_misaligned");
  }

  return {
    reason: failureKinds.length ? "capture_gps_stale" : null,
    photoClockDomain,
    gpsClockDomain,
    gpsAgeMs,
    photoGpsDeltaMs,
    maxAgeMs: CAPTURE_GPS_MAX_AGE_MS,
    photoAlignmentMs: CAPTURE_GPS_PHOTO_ALIGNMENT_MS,
    skewToleranceMs: SENSOR_CLOCK_SKEW_TOLERANCE_MS,
    failureKinds,
  };
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

/**
 * Privacy-preserving field names for Trial diagnostics.
 * Returns statuses only — never coordinates, headings, or raw payloads.
 */
export function missingCaptureMetadataFields(
  sensors: LastMetersSensors | undefined,
): CaptureMetadataField[] {
  if (!sensors || typeof sensors !== "object") return ["sensors"];
  const missing: CaptureMetadataField[] = [];
  if (!Number.isFinite(sensors.photoCapturedAt) || sensors.photoCapturedAt <= 0) {
    missing.push("photoCapturedAt");
  }
  if (!Number.isFinite(sensors.positionTimestamp) || sensors.positionTimestamp <= 0) {
    missing.push("positionTimestamp");
  }
  if (!Number.isFinite(sensors.headingTimestamp) || sensors.headingTimestamp <= 0) {
    missing.push("headingTimestamp");
  }
  if (
    sensors.headingReference !== "true" &&
    sensors.headingReference !== "magnetic" &&
    sensors.headingReference !== "unknown"
  ) {
    missing.push("headingReference");
  }
  return missing;
}

export function sensorSafetyReasons(
  sensors: LastMetersSensors | undefined, position: { lat: number; lng: number },
  heading: number | undefined, accuracy: number | undefined, now = Date.now(), snapshotTime = now,
): string[] {
  // Absent package or incomplete capture-time fields: do not attempt a precise turn.
  if (missingCaptureMetadataFields(sensors).length) return ["capture_metadata_missing"];
  const ready = sensors as LastMetersSensors;
  const reasons: string[] = [];
  const fresh = (time: number, age: number, reference = now) =>
    Number.isFinite(time) && time <= reference + SENSOR_CLOCK_SKEW_TOLERANCE_MS && reference - time <= age;
  if (!fresh(ready.photoCapturedAt, CAPTURE_GPS_MAX_AGE_MS)) reasons.push("photo_stale");
  if (captureGpsFreshnessDiagnostics(ready, now).reason) reasons.push("capture_gps_stale");
  if (!fresh(ready.headingTimestamp, CAPTURE_GPS_MAX_AGE_MS) ||
      Math.abs(ready.photoCapturedAt - ready.headingTimestamp) > 5000) {
    reasons.push("capture_heading_stale");
  }
  if (ready.headingReference !== "true" || ready.latestHeadingReference !== "true") reasons.push("true_north_unavailable");
  if (!Number.isFinite(heading) || heading! < 0 || heading! >= 360 || !Number.isFinite(ready.latestHeading) ||
      ready.latestHeading < 0 || ready.latestHeading >= 360 || !fresh(ready.latestHeadingTimestamp, 15_000, snapshotTime)) {
    reasons.push("current_heading_unavailable");
  } else if (angularDifference(heading!, ready.latestHeading) > 15) reasons.push("turned_since_capture");
  if (currentGpsAvailabilityDiagnostics(ready, position, snapshotTime).reason) {
    reasons.push("current_gps_unavailable");
  } else if (distanceBetween(position, ready.latestPosition) > 5) {
    reasons.push("moved_since_capture");
  }
  const latest = ready.latestPosition;
  if (!Number.isFinite(accuracy) || accuracy! < 0 || accuracy! > 20 || !Number.isFinite(latest?.accuracy) || latest.accuracy < 0 || latest.accuracy > 20) {
    reasons.push("gps_uncertain");
  }
  return reasons;
}

export const RECAPTURE_MESSAGE = "I cannot verify your current position and orientation well enough for a precise turn. Stay in a safe place, hold the phone steady, and take a new photo. Make sure the app is updated and precise location is enabled.";
