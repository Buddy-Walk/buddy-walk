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
  const reported = (meters: number | undefined) =>
    Number.isFinite(meters) && meters! >= 0 ? meters! : undefined;
  // Either reading can stand in when the other is missing; phones often omit one accuracy field.
  const captureAccuracy = reported(accuracy) ?? reported(latest?.accuracy);
  const latestAccuracy = reported(latest?.accuracy) ?? captureAccuracy;
  // Sum, not RSS: phone accuracy near buildings is optimistic, so hypot still false-triggers.
  if (
    latest && captureAccuracy !== undefined && latestAccuracy !== undefined &&
    distanceBetween(position, latest) <= Math.max(5, captureAccuracy + latestAccuracy)
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
