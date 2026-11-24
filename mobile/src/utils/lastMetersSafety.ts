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
   * Optional Expo compass accuracy (0?3) when recorded by the client (#153).
   * Diagnostic only ? never used to relax `TURNED_SINCE_CAPTURE_MAX_DEGREES`.
   */
  latestHeadingAccuracyLevel?: number | null;
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
/**
 * Shortest-arc heading change that withholds a stale capture pose.
 * Do not relax without a Safety Gate review.
 */
export const TURNED_SINCE_CAPTURE_MAX_DEGREES = 15;
/** Live heading must be fresh vs the evaluation snapshot clock. */
export const CURRENT_HEADING_MAX_AGE_MS = 15_000;
export const SENSOR_CLOCK_SKEW_TOLERANCE_MS = 2_000;

/**
 * Expo / Geolocation `coords.accuracy` is a horizontal accuracy radius in **meters**
 * (OS confidence circle). Passed through as `gpsAccuracyMeters` with no unit conversion.
 * Do not relax without a Safety Gate review.
 */
export const GPS_ACCURACY_MAX_METERS = 20;

/**
 * Same angular budget as `bearing_uncertainty_too_large` in preciseTurnReasons:
 * GPS radius must not subtend more than ±22.5° at the target distance.
 * Used only to add withhold pressure when distance is known — never to raise the 20 m cap.
 */
export const GPS_ACCURACY_BEARING_SIN = Math.sin((22.5 * Math.PI) / 180);

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

export type GpsAccuracyFailureKind =
  | "capture_accuracy_missing"
  | "capture_accuracy_invalid"
  | "capture_accuracy_above_max"
  | "latest_accuracy_missing"
  | "latest_accuracy_invalid"
  | "latest_accuracy_above_max"
  | "accuracy_vs_distance_too_large";

export interface GpsAccuracyDiagnostics {
  reason: "gps_uncertain" | null;
  /** Documented: Expo horizontal accuracy meters. */
  unit: "meters";
  maxAccuracyMeters: number;
  captureAccuracyMeters: number | null;
  latestAccuracyMeters: number | null;
  /** Target distance when known; null when the sensor gate has no destination range yet. */
  distanceMeters: number | null;
  /** captureAccuracy / distance when both finite and distance > 0. */
  accuracyDistanceRatio: number | null;
  bearingBudgetSin: number;
  failureKinds: GpsAccuracyFailureKind[];
}

function ageMs(reference: number, sample: number): number {
  return reference - sample;
}

function accuracyFailures(
  value: number | undefined,
  which: "capture" | "latest",
): { meters: number | null; kinds: GpsAccuracyFailureKind[] } {
  const missing = `${which}_accuracy_missing` as GpsAccuracyFailureKind;
  const invalid = `${which}_accuracy_invalid` as GpsAccuracyFailureKind;
  const above = `${which}_accuracy_above_max` as GpsAccuracyFailureKind;
  if (value === undefined || value === null || (typeof value === "number" && Number.isNaN(value))) {
    return { meters: null, kinds: [missing] };
  }
  if (!Number.isFinite(value) || value < 0) {
    return { meters: Number.isFinite(value) ? value : null, kinds: [invalid] };
  }
  if (value > GPS_ACCURACY_MAX_METERS) {
    return { meters: value, kinds: [above] };
  }
  return { meters: value, kinds: [] };
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

/**
 * Absolute 20 m cap is unchanged. When `distanceMeters` is provided and positive,
 * also require accuracy/distance ≤ sin(22.5°) — strictly additive withhold, never a raise of the cap.
 */
export function gpsAccuracyDiagnostics(
  accuracy: number | undefined,
  latestAccuracy: number | undefined,
  distanceMeters?: number,
): GpsAccuracyDiagnostics {
  const capture = accuracyFailures(accuracy, "capture");
  const latest = accuracyFailures(latestAccuracy, "latest");
  const failureKinds = [...capture.kinds, ...latest.kinds];
  const distance =
    typeof distanceMeters === "number" && Number.isFinite(distanceMeters) && distanceMeters > 0
      ? distanceMeters
      : null;
  let accuracyDistanceRatio: number | null = null;
  if (distance !== null && capture.meters !== null && capture.kinds.length === 0) {
    accuracyDistanceRatio = capture.meters / distance;
    if (accuracyDistanceRatio > GPS_ACCURACY_BEARING_SIN) {
      failureKinds.push("accuracy_vs_distance_too_large");
    }
  }
  return {
    reason: failureKinds.length ? "gps_uncertain" : null,
    unit: "meters",
    maxAccuracyMeters: GPS_ACCURACY_MAX_METERS,
    captureAccuracyMeters: capture.meters,
    latestAccuracyMeters: latest.meters,
    distanceMeters: distance,
    accuracyDistanceRatio,
    bearingBudgetSin: GPS_ACCURACY_BEARING_SIN,
    failureKinds: [...new Set(failureKinds)],
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

export type TurnedSinceCaptureFailureKind =
  | "capture_heading_missing"
  | "capture_heading_invalid"
  | "latest_heading_missing"
  | "latest_heading_invalid"
  | "latest_heading_stale"
  | "circular_delta_above_max";

/**
 * Privacy-preserving post-capture heading report.
 * Records angles, ages, and circular delta only ? never lat/lng.
 */
export interface TurnedSinceCaptureDiagnostics {
  reason: "turned_since_capture" | null;
  captureHeadingDegrees: number | null;
  latestHeadingDegrees: number | null;
  /** Shortest-arc |capture ? latest|; null when either heading is unusable. */
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
 * Threshold remains 15�; wrap-around uses shortest-arc `angularDifference`.
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
  /** When known (e.g. entrance distance), applies the additive distance-relative accuracy check. */
  distanceMeters?: number,
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
  const turned = turnedSinceCaptureDiagnostics(heading, ready, snapshotTime);
  const headingUnusable = turned.failureKinds.some(kind =>
    kind === "capture_heading_missing" || kind === "capture_heading_invalid" ||
    kind === "latest_heading_missing" || kind === "latest_heading_invalid" ||
    kind === "latest_heading_stale");
  if (headingUnusable) reasons.push("current_heading_unavailable");
  else if (turned.reason) reasons.push("turned_since_capture");
  if (currentGpsAvailabilityDiagnostics(ready, position, snapshotTime).reason) {
    reasons.push("current_gps_unavailable");
  } else if (distanceBetween(position, ready.latestPosition) > 5) {
    reasons.push("moved_since_capture");
  }
  const latest = ready.latestPosition;
  if (gpsAccuracyDiagnostics(accuracy, latest?.accuracy, distanceMeters).reason) {
    reasons.push("gps_uncertain");
  }
  return reasons;
}

export const RECAPTURE_MESSAGE = "I cannot verify your current position and orientation well enough for a precise turn. Stay in a safe place, hold the phone steady, and take a new photo. Make sure the app is updated and precise location is enabled.";
