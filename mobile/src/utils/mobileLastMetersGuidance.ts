import {
  distanceBetween,
  sensorSafetyReasons,
  type LastMetersSensors,
} from "./lastMetersSafety";

/** Keep real sensor failures while allowing location jitter inside the reported GPS uncertainty. */
export function mobileTurnSensorReasons(
  ...args: Parameters<typeof sensorSafetyReasons>
): string[] {
  const [sensors, position, , accuracy] = args;
  const reasons = sensorSafetyReasons(...args);
  const latest = sensors?.latestPosition;
  const captureAccuracy = Number.isFinite(accuracy) && accuracy! >= 0 ? accuracy! : undefined;
  const latestAccuracy = Number.isFinite(latest?.accuracy) && latest!.accuracy >= 0
    ? latest!.accuracy
    : captureAccuracy;
  if (
    latest && captureAccuracy !== undefined && latestAccuracy !== undefined &&
    distanceBetween(position, latest) <= Math.max(5, Math.hypot(captureAccuracy, latestAccuracy))
  ) {
    return reasons.filter(reason => reason !== "moved_since_capture");
  }
  return reasons;
}

/** Recheck live orientation only for an actual turn; descriptive and withheld answers remain readable. */
export function mobileResponseSensorReasons(
  answer: { targetHeading?: number | null; currentHeading?: number; guidanceKind?: string },
  sensors: LastMetersSensors | undefined,
  position: { lat: number; lng: number },
  heading: number | undefined,
  accuracy: number | undefined,
  requestedAt: number,
  now = Date.now(),
): string[] {
  if (answer.guidanceKind === "withheld" || !Number.isFinite(answer.targetHeading)) return [];
  // Capture age is measured when submitted; current readings are measured when speaking.
  const guidanceHeading = Number.isFinite(answer.currentHeading) ? answer.currentHeading : heading;
  return mobileTurnSensorReasons(sensors, position, guidanceHeading, accuracy, requestedAt, now);
}
