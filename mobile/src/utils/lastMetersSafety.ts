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
  if (!Number.isFinite(accuracy) || accuracy! < 0 || accuracy! > 20 || !Number.isFinite(latest?.accuracy) || latest.accuracy < 0 || latest.accuracy > 20) reasons.push("gps_uncertain");
  return reasons;
}

export const RECAPTURE_MESSAGE = "I cannot verify your current position and orientation well enough for a precise turn. Stay in a safe place, hold the phone steady, and take a new photo. Make sure the app is updated and precise location is enabled.";
