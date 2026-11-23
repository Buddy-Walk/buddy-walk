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
  /** When known (e.g. entrance distance), applies the additive distance-relative accuracy check. */
  distanceMeters?: number,
): string[] {
  if (!sensors) return ["capture_metadata_missing"];
  const reasons: string[] = [];
  const fresh = (time: number, age: number, reference = now) => Number.isFinite(time) && time <= reference + 2000 && reference - time <= age;
  if (!fresh(sensors.photoCapturedAt, 60_000)) reasons.push("photo_stale");
  if (!fresh(sensors.positionTimestamp, 60_000) || Math.abs(sensors.photoCapturedAt - sensors.positionTimestamp) > 10_000) reasons.push("capture_gps_stale");
  if (!fresh(sensors.headingTimestamp, 60_000) || Math.abs(sensors.photoCapturedAt - sensors.headingTimestamp) > 5000) reasons.push("capture_heading_stale");
  if (sensors.headingReference !== "true" || sensors.latestHeadingReference !== "true") reasons.push("true_north_unavailable");
  if (!Number.isFinite(heading) || heading! < 0 || heading! >= 360 || !Number.isFinite(sensors.latestHeading) ||
      sensors.latestHeading < 0 || sensors.latestHeading >= 360 || !fresh(sensors.latestHeadingTimestamp, 15_000, snapshotTime)) reasons.push("current_heading_unavailable");
  else if (angularDifference(heading!, sensors.latestHeading) > 15) reasons.push("turned_since_capture");
  const latest = sensors.latestPosition;
  if (!validPoint(position) || !latest || !validPoint(latest) || !fresh(latest.timestamp, 15_000, snapshotTime)) reasons.push("current_gps_unavailable");
  else if (distanceBetween(position, latest) > 5) reasons.push("moved_since_capture");
  if (gpsAccuracyDiagnostics(accuracy, latest?.accuracy, distanceMeters).reason) {
    reasons.push("gps_uncertain");
  }
  return reasons;
}

export const RECAPTURE_MESSAGE = "I cannot verify your current position and orientation well enough for a precise turn. Stay in a safe place, hold the phone steady, and take a new photo. Make sure the app is updated and precise location is enabled.";
