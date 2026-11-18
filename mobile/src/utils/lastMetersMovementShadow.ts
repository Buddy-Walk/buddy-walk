import { toGpsSample, type GpsMeasurement } from "./gpsQuality";
import { assessMovement, type MovementAssessment } from "./movementAssessment";
import { createGpsSampleHistory } from "./gpsSampleHistory";
import { MOVEMENT_DIAGNOSTICS_CONFIG, type MovementDiagnosticsConfig } from "./movementDiagnosticsConfig";
import { createMotionActivityInterval } from "./motionActivityInterval";
import { sensorSafetyReasons, type LastMetersSensors } from "./lastMetersSafety";
import { mobileTurnSensorReasons } from "./mobileLastMetersGuidance";

export const LAST_METERS_MOVEMENT_SHADOW_ENABLED = process.env.EXPO_PUBLIC_LAST_METERS_MOVEMENT_SHADOW === "true";
type MotionOptions = Parameters<typeof createMotionActivityInterval>[0];
type Scalar = string | number | boolean | null;

export interface ShadowSnapshotInput {
  latest?: GpsMeasurement;
  sensors?: LastMetersSensors;
  captureHeading?: number;
  requestedAt: number;
  observedAt: number;
}

/** Per-photo diagnostic session. Existing locationRef and navigation decisions are never changed. */
export function createLastMetersMovementShadow(options: MotionOptions & {
  capture?: GpsMeasurement;
  captureId: string;
  config?: Partial<MovementDiagnosticsConfig>;
}) {
  const capture = options.capture ? { ...options.capture } : undefined;
  const config: MovementDiagnosticsConfig = { ...MOVEMENT_DIAGNOSTICS_CONFIG, ...options.config };
  const duration = options.maxDurationMs && Number.isFinite(options.maxDurationMs) && options.maxDurationMs > 0
    ? options.maxDurationMs : config.maxSessionDurationMs;
  const history = createGpsSampleHistory(capture ? toGpsSample(capture) : undefined, options.captureAt,
    { ...config, maxSessionDurationMs: duration });
  const motion = createMotionActivityInterval({ ...options, maxDurationMs: duration });
  return {
    captureId: options.captureId,
    observeGps(sample: GpsMeasurement, observedAt = Date.now()) {
      history.observe(toGpsSample(sample), observedAt);
    },
    markGpsUnavailable(observedAt = Date.now()) { history.markUnavailable(observedAt); },
    snapshot(input: ShadowSnapshotInput) {
      const summary = history.snapshot(input.observedAt).summary;
      const assessment = assessMovement({ capture, latest: input.latest, photoCapturedAt: options.captureAt,
        captureReferenceAt: input.requestedAt, observedAt: input.observedAt,
        motion: motion.snapshot(input.observedAt), interval: summary, history: summary, config });
      const position = capture ?? { lat: NaN, lng: NaN };
      // Counterfactual movement flags use the existing functions and legacy data,
      // including its accuracy fallback; shadow quality uses genuine raw accuracy.
      const args = [input.sensors, position, input.captureHeading, capture?.accuracy, input.requestedAt, input.observedAt] as const;
      const strictReasons = sensorSafetyReasons(...args);
      const mobileReasons = mobileTurnSensorReasons(...args);
      return { assessment, strictReasons, mobileReasons };
    },
    stop(reason = "completed") { history.stop(reason); motion.stop(reason); },
  };
}

export type LastMetersMovementShadow = ReturnType<typeof createLastMetersMovementShadow>;

/** Allowlist flattened diagnostics for existing telemetry. No coordinates, photo, destination or raw activity history. */
export function movementShadowTelemetry(input: {
  captureId: string; requestId: string; phase: "submission" | "response";
  assessment: MovementAssessment; strictReasons: string[]; mobileReasons: string[];
  testLogId?: string; serverReasons?: string[]; serverWarning?: string;
  finalReasons?: string[]; preciseTurnCheckApplied?: boolean;
}): Record<string, Scalar> {
  const { assessment: a } = input;
  const h = a.history;
  const shadowMoved = a.state === "movement_detected" ? true : a.state === "movement_not_detected" ? false : undefined;
  const props: Record<string, Scalar | undefined> = {
    classifierVersion: a.version, mode: a.mode, captureId: input.captureId, requestId: input.requestId, phase: input.phase,
    testLogId: input.testLogId, movementState: a.state, rationale: a.rationale.join(";"),
    displacementMeters: a.gps.displacementMeters, captureAccuracyMeters: a.gps.captureAccuracyMeters,
    latestAccuracyMeters: a.gps.latestAccuracyMeters, captureGpsTimestamp: a.gps.captureTimestamp, latestGpsTimestamp: a.gps.latestTimestamp,
    gpsIntervalMs: a.gps.intervalMs, gpsUsable: a.gps.usable,
    gpsNoiseReferenceMeters: a.gpsNoiseReferenceMeters, adjustedSpeedMps: a.gps.adjustedSpeedMps,
    sampleCount: a.sampleCount, gpsQualityIssues: a.gpsQualityIssues.join(";"),
    gpsAcceptedSamples: h?.acceptedSamples, gpsRejectedSamples: h?.rejectedSamples,
    gpsRetainedSamples: h?.retainedSampleCount, gpsDroppedSamples: h?.droppedSamples,
    gpsCoordinateIssueCount: h?.issueCounts.coordinates_invalid ?? 0,
    gpsAccuracyIssueCount: h ? (h.issueCounts.accuracy_missing ?? 0) + (h.issueCounts.accuracy_invalid ?? 0) + (h.issueCounts.accuracy_poor ?? 0) : 0,
    gpsStaleIssueCount: h?.issueCounts.timestamp_stale ?? 0, gpsFutureIssueCount: h?.issueCounts.timestamp_future ?? 0,
    gpsSpeedIssueCount: h?.issueCounts.implausible_speed ?? 0,
    gpsTimestampIssueCount: h?.issueCounts.timestamp_invalid ?? 0,
    gpsInconsistentTimestampCount: h?.issueCounts.inconsistent_timestamp ?? 0,
    gpsValidPairs: h?.validPairs, gpsElapsedMs: h?.elapsedMs, gpsCoveredMs: h?.coveredMs,
    gpsCoverageRatio: h?.coverageRatio, gpsCoverageAdequate: h?.coverageAdequate,
    gpsGapCount: h?.gapCount, gpsMaxGapMs: h?.maxGapMs, gpsStartupGapMs: h?.startupGapMs, gpsTailGapMs: h?.tailGapMs,
    gpsFirstReceivedAt: h?.firstReceivedAt, gpsLastReceivedAt: h?.lastReceivedAt,
    gpsMaxDeliveryGapMs: h?.maxDeliveryGapMs, gpsMaxSampleAgeAtDeliveryMs: h?.maxSampleAgeAtDeliveryMs,
    gpsUnavailableEvents: h?.unavailableEvents,
    gpsHistoryStopReason: h?.stoppedReason,
    apparentSpeedCount: h?.apparentSpeed.count, apparentSpeedMinMps: h?.apparentSpeed.min,
    apparentSpeedMaxMps: h?.apparentSpeed.max, apparentSpeedMeanMps: h?.apparentSpeed.mean,
    apparentSpeedLatestMps: h?.apparentSpeed.latest, maxObservedApparentSpeedMps: h?.maxObservedApparentSpeedMps,
    reportedSpeedCount: h?.reportedSpeed.count, reportedSpeedMinMps: h?.reportedSpeed.min,
    reportedSpeedMaxMps: h?.reportedSpeed.max, reportedSpeedMeanMps: h?.reportedSpeed.mean,
    reportedSpeedLatestMps: h?.reportedSpeed.latest, reportedMovingSamples: h?.reportedMovingSamples,
    reportedSpeedMissingSamples: h?.reportedSpeedMissingSamples, reportedSpeedInvalidSamples: h?.reportedSpeedInvalidSamples,
    speedDisagreements: h?.speedDisagreements,
    strictComparison: shadowMoved === undefined ? "inconclusive" : shadowMoved === input.strictReasons.includes("moved_since_capture") ? "agree" : "disagree",
    mobileComparison: shadowMoved === undefined ? "inconclusive" : shadowMoved === input.mobileReasons.includes("moved_since_capture") ? "agree" : "disagree",
    strictMoved: input.strictReasons.includes("moved_since_capture"), mobileMoved: input.mobileReasons.includes("moved_since_capture"),
    strictReasons: input.strictReasons.join(";"), mobileReasons: input.mobileReasons.join(";"),
    serverReasons: input.serverReasons?.join(";"), serverWarning: input.serverWarning,
    finalClientReasons: input.finalReasons?.join(";"), preciseTurnCheckApplied: input.preciseTurnCheckApplied,
    photoCapturedAt: a.motion?.captureAt, motionAvailability: a.motion?.availability ?? "not_collected", motionPlatform: a.motion?.platform,
    motionStartedAt: a.motion?.startedAt, motionObservedUntil: a.motion?.observedUntil,
    motionFirstReceivedAt: a.motion?.firstReceivedAt, motionLastReceivedAt: a.motion?.lastReceivedAt, motionLastEventAt: a.motion?.lastEventAt,
    motionTimestampSemantics: a.motion?.timestampSemantics, motionEvents: a.motion?.events,
    movingEvents: a.motion?.movingEvents, postCaptureMovingEvents: a.motion?.postCaptureMovingEvents,
    stationaryEvents: a.motion?.stationaryEvents, unknownEvents: a.motion?.unknownEvents,
    conflictingEvents: a.motion?.conflictingEvents, ignoredEvents: a.motion?.ignoredEvents,
    maxMovingConfidence: a.motion?.maxMovingConfidence, maxStationaryConfidence: a.motion?.maxStationaryConfidence,
    maxPostCaptureMovingConfidence: a.motion?.maxPostCaptureMovingConfidence,
    preCaptureMovingContext: a.motion?.preCaptureMovingContext, motionInterrupted: a.motion?.interrupted,
    motionIncompleteCoverage: a.motion?.incompleteCoverage, motionStopReason: a.motion?.stopReason,
    motionStartupDelayMs: a.motion?.startupDelayMs, motionEventSilenceMs: a.motion?.eventSilenceMs,
    motionMaxDeliveryGapMs: a.motion?.maxDeliveryGapMs, motionEventObservedSpanMs: a.motion?.eventObservedSpanMs,
    gpsSamples: a.interval?.samples, gpsDuplicates: a.interval?.duplicateSamples, gpsOutOfOrder: a.interval?.outOfOrderSamples,
    gpsInvalidSamples: a.interval?.invalidSamples, maxDisplacementMeters: a.interval?.maxDisplacementMeters,
    gpsExcursionObserved: a.interval?.significantExcursionObserved,
  };
  return Object.fromEntries(Object.entries(props).filter((entry): entry is [string, Scalar] =>
    entry[1] !== undefined && (typeof entry[1] !== "number" || Number.isFinite(entry[1])))
    .map(([key, value]) => [key, typeof value === "string" ? value.slice(0, 500) : value]));
}
