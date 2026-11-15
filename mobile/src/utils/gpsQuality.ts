import { distanceBetween, validPoint } from "./lastMetersSafety";
import { MOVEMENT_DIAGNOSTICS_CONFIG as defaults, type MovementDiagnosticsConfig } from "./movementDiagnosticsConfig";

export interface GpsMeasurement {
  lat: number;
  lng: number;
  accuracy?: number;
  timestamp?: number;
  reportedSpeed?: number | null;
}

/** Local, bounded sensor history; these raw coordinates are never sent in diagnostic telemetry. */
export interface GpsSample {
  timestamp: number;
  latitude: number;
  longitude: number;
  accuracy: number | null;
  reportedSpeed: number | null;
}

export function toGpsSample(fix: GpsMeasurement): GpsSample {
  return { timestamp: fix.timestamp ?? NaN, latitude: fix.lat, longitude: fix.lng,
    accuracy: fix.accuracy ?? null, reportedSpeed: fix.reportedSpeed ?? null };
}

export function gpsSampleIssues(sample: GpsSample, observedAt: number, config: MovementDiagnosticsConfig = defaults): string[] {
  const issues: string[] = [];
  if (!validPoint({ lat: sample.latitude, lng: sample.longitude })) issues.push("coordinates_invalid");
  if (sample.accuracy === null) issues.push("accuracy_missing");
  else if (!Number.isFinite(sample.accuracy) || sample.accuracy <= 0) issues.push("accuracy_invalid");
  else if (sample.accuracy > config.maxAccuracyMeters) issues.push("accuracy_poor");
  if (!Number.isFinite(observedAt) || observedAt <= 0) issues.push("observation_timestamp_invalid");
  if (!Number.isFinite(sample.timestamp) || sample.timestamp <= 0) issues.push("timestamp_invalid");
  else if (sample.timestamp > observedAt + config.futureToleranceMs) issues.push("timestamp_future");
  else if (observedAt - sample.timestamp > config.latestMaxAgeMs) issues.push("timestamp_stale");
  return issues;
}

/** Raw Haversine distance/time, deliberately separate from device-reported speed and GPS accuracy. */
export function calculateGpsSpeed(previous: GpsSample | undefined, current: GpsSample) {
  const issues: string[] = [];
  const point = (sample: GpsSample) => ({ lat: sample.latitude, lng: sample.longitude });
  const coordinatesValid = validPoint(point(current)) && (!previous || validPoint(point(previous)));
  if (!coordinatesValid) issues.push("coordinates_invalid");
  const timestampsValid = Number.isFinite(current.timestamp) && current.timestamp > 0 &&
    (!previous || (Number.isFinite(previous.timestamp) && previous.timestamp > 0));
  if (!timestampsValid) issues.push("timestamp_invalid");
  if (!previous) issues.push("insufficient_samples");
  const elapsedSeconds = previous && timestampsValid ? (current.timestamp - previous.timestamp) / 1000 : null;
  if (elapsedSeconds === 0) issues.push("duplicate_timestamp");
  if (elapsedSeconds !== null && elapsedSeconds < 0) issues.push("out_of_order_timestamp");
  const distanceMeters = previous && coordinatesValid ? distanceBetween(point(previous), point(current)) : null;
  const calculatedSpeed = elapsedSeconds !== null && elapsedSeconds > 0 && distanceMeters !== null
    ? distanceMeters / elapsedSeconds : null;
  const apparentSpeedMps = calculatedSpeed !== null && Number.isFinite(calculatedSpeed) ? calculatedSpeed : null;
  if (calculatedSpeed !== null && !Number.isFinite(calculatedSpeed)) issues.push("apparent_speed_nonfinite");
  const reportedSpeedMps = current.reportedSpeed !== null && Number.isFinite(current.reportedSpeed) && current.reportedSpeed >= 0
    ? current.reportedSpeed : null;
  const reportedSpeedIssue = reportedSpeedMps !== null ? null
    : current.reportedSpeed === null ? "reported_speed_missing" : "reported_speed_invalid";
  return { distanceMeters, elapsedSeconds, apparentSpeedMps, reportedSpeedMps,
    accuracyMeters: current.accuracy, timestampsValid, issues, reportedSpeedIssue };
}

export function assessGpsTransition(previous: GpsSample | undefined, current: GpsSample,
  observedAt: number, config: MovementDiagnosticsConfig = defaults) {
  const speed = calculateGpsSpeed(previous, current);
  const issues = [...gpsSampleIssues(current, observedAt, config), ...speed.issues];
  if (previous) issues.push(...gpsSampleIssues(previous, observedAt, config)
    .filter(issue => issue !== "timestamp_stale").map(issue => `previous_${issue}`));
  if (speed.apparentSpeedMps !== null && speed.apparentSpeedMps > config.maxApparentSpeedMps) {
    issues.push("implausible_speed");
  }
  const noiseReferenceMeters = previous?.accuracy !== null && previous?.accuracy !== undefined &&
    current.accuracy !== null && previous.accuracy > 0 && current.accuracy > 0 &&
    Number.isFinite(previous.accuracy) && Number.isFinite(current.accuracy)
    ? Math.hypot(previous.accuracy, current.accuracy) : null;
  return { ...speed, issues: [...new Set(issues)], usable: issues.length === 0,
    noiseReferenceMeters,
    smallChangeWithinAccuracy: noiseReferenceMeters !== null && speed.distanceMeters !== null
      ? speed.distanceMeters <= noiseReferenceMeters : null,
    speedDisagreement: speed.apparentSpeedMps !== null && speed.reportedSpeedMps !== null &&
      Math.abs(speed.apparentSpeedMps - speed.reportedSpeedMps) >= config.speedDisagreementMps,
  };
}

export interface GpsQualityInput {
  capture?: GpsMeasurement;
  latest?: GpsMeasurement;
  photoCapturedAt: number;
  observedAt: number;
  captureReferenceAt?: number;
}

export interface GpsQualityAssessment {
  usable: boolean;
  issues: string[];
  displacementMeters?: number;
  captureAccuracyMeters?: number;
  latestAccuracyMeters?: number;
  captureTimestamp?: number;
  latestTimestamp?: number;
  intervalMs?: number;
  uncertaintyMeters?: number;
  adjustedSpeedMps?: number;
}

const positiveFinite = (value: number | undefined): value is number =>
  Number.isFinite(value) && value! > 0;

/** Validates a pair of GPS fixes without deciding whether the pedestrian moved. */
export function assessGpsQuality(input: GpsQualityInput, config: MovementDiagnosticsConfig = defaults): GpsQualityAssessment {
  const issues: string[] = [];
  const result: GpsQualityAssessment = { usable: false, issues };
  const captureReferenceAt = input.captureReferenceAt ?? input.observedAt;
  const observedValid = positiveFinite(input.observedAt);
  const photoValid = positiveFinite(input.photoCapturedAt);
  const referenceValid = positiveFinite(captureReferenceAt);
  if (!observedValid) issues.push("observation_timestamp_invalid");
  if (!photoValid) issues.push("photo_timestamp_invalid");
  if (!referenceValid) issues.push("capture_reference_timestamp_invalid");
  if (observedValid && photoValid && input.photoCapturedAt - input.observedAt > config.futureToleranceMs) {
    issues.push("photo_timestamp_future");
  }
  if (observedValid && referenceValid && captureReferenceAt - input.observedAt > config.futureToleranceMs) {
    issues.push("capture_reference_timestamp_future");
  }

  const inspect = (measurement: GpsMeasurement | undefined, label: "capture" | "latest") => {
    if (!measurement) {
      issues.push(`${label}_missing`);
      return {};
    }
    const point = validPoint(measurement) ? measurement : undefined;
    if (!point) issues.push(`${label}_coordinates_invalid`);
    const accuracy = positiveFinite(measurement.accuracy) ? measurement.accuracy : undefined;
    if (accuracy === undefined) {
      issues.push(`${label}_accuracy_${measurement.accuracy === undefined ? "missing" : "invalid"}`);
    } else if (accuracy > config.maxAccuracyMeters) {
      issues.push(`${label}_accuracy_poor`);
    }
    const timestamp = positiveFinite(measurement.timestamp) ? measurement.timestamp : undefined;
    if (timestamp === undefined) {
      issues.push(`${label}_timestamp_${measurement.timestamp === undefined ? "missing" : "invalid"}`);
    } else if (observedValid && timestamp - input.observedAt > config.futureToleranceMs) {
      issues.push(`${label}_timestamp_future`);
    }
    return { point, accuracy, timestamp };
  };

  const capture = inspect(input.capture, "capture");
  const latest = inspect(input.latest, "latest");
  if (capture.accuracy !== undefined) result.captureAccuracyMeters = capture.accuracy;
  if (latest.accuracy !== undefined) result.latestAccuracyMeters = latest.accuracy;
  if (capture.timestamp !== undefined) {
    result.captureTimestamp = capture.timestamp;
    if (photoValid && capture.timestamp - input.photoCapturedAt > config.futureToleranceMs) {
      issues.push("capture_after_photo");
    }
    if (photoValid && Math.abs(capture.timestamp - input.photoCapturedAt) > config.capturePhotoToleranceMs) {
      issues.push("capture_not_near_photo");
    }
    if (referenceValid && captureReferenceAt - capture.timestamp > config.captureMaxAgeMs) {
      issues.push("capture_stale");
    }
  }
  if (latest.timestamp !== undefined) {
    result.latestTimestamp = latest.timestamp;
    if (observedValid && input.observedAt - latest.timestamp > config.latestMaxAgeMs) issues.push("latest_stale");
    if (photoValid && latest.timestamp < input.photoCapturedAt) issues.push("latest_before_photo");
  }
  if (capture.point && latest.point) {
    result.displacementMeters = distanceBetween(capture.point, latest.point);
  }
  if (capture.accuracy !== undefined && latest.accuracy !== undefined) {
    // A diagnostic noise scale, not a confidence probability or a hard error bound.
    const uncertainty = Math.hypot(capture.accuracy, latest.accuracy);
    if (Number.isFinite(uncertainty)) result.uncertaintyMeters = uncertainty;
  }
  if (capture.timestamp !== undefined && latest.timestamp !== undefined) {
    const interval = latest.timestamp - capture.timestamp;
    result.intervalMs = interval;
    if (interval < 0) issues.push("latest_before_capture");
    if (interval === 0) {
      issues.push("duplicate_measurement");
      if (capture.point && latest.point &&
          (capture.point.lat !== latest.point.lat || capture.point.lng !== latest.point.lng)) {
        issues.push("inconsistent_timestamp");
      }
    }
    if (interval > 0 && result.displacementMeters !== undefined && result.uncertaintyMeters !== undefined) {
      const adjustedSpeed = Math.max(0, result.displacementMeters - result.uncertaintyMeters) / interval * 1000;
      if (Number.isFinite(adjustedSpeed)) result.adjustedSpeedMps = adjustedSpeed;
      if (adjustedSpeed > config.maxApparentSpeedMps) issues.push("implausible_jump");
    }
  }
  result.usable = issues.length === 0;
  return result;
}
