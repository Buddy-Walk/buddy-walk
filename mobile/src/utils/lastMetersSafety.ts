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
  const fresh = (time: number, age: number, reference = now) => Number.isFinite(time) && time <= reference + 2000 && reference - time <= age;
  if (!fresh(ready.photoCapturedAt, 60_000)) reasons.push("photo_stale");
  if (!fresh(ready.positionTimestamp, 60_000) || Math.abs(ready.photoCapturedAt - ready.positionTimestamp) > 10_000) reasons.push("capture_gps_stale");
  if (!fresh(ready.headingTimestamp, 60_000) || Math.abs(ready.photoCapturedAt - ready.headingTimestamp) > 5000) reasons.push("capture_heading_stale");
  if (ready.headingReference !== "true" || ready.latestHeadingReference !== "true") reasons.push("true_north_unavailable");
  if (!Number.isFinite(heading) || heading! < 0 || heading! >= 360 || !Number.isFinite(ready.latestHeading) ||
      ready.latestHeading < 0 || ready.latestHeading >= 360 || !fresh(ready.latestHeadingTimestamp, 15_000, snapshotTime)) reasons.push("current_heading_unavailable");
  else if (angularDifference(heading!, ready.latestHeading) > 15) reasons.push("turned_since_capture");
  const latest = ready.latestPosition;
  if (!validPoint(position) || !latest || !validPoint(latest) || !fresh(latest.timestamp, 15_000, snapshotTime)) reasons.push("current_gps_unavailable");
  else if (distanceBetween(position, latest) > 5) reasons.push("moved_since_capture");
  if (!Number.isFinite(accuracy) || accuracy! < 0 || accuracy! > 20 || !Number.isFinite(latest?.accuracy) || latest.accuracy < 0 || latest.accuracy > 20) reasons.push("gps_uncertain");
  return reasons;
}

export const RECAPTURE_MESSAGE = "I cannot verify your current position and orientation well enough for a precise turn. Stay in a safe place, hold the phone steady, and take a new photo. Make sure the app is updated and precise location is enabled.";
