import { assessGpsQuality, type GpsQualityInput, type GpsQualityAssessment } from "./gpsQuality";
import type { MotionIntervalSummary } from "./motionActivityInterval";
import type { GpsHistorySummary } from "./gpsSampleHistory";
import { MOVEMENT_DIAGNOSTICS_CONFIG as defaults, type MovementDiagnosticsConfig } from "./movementDiagnosticsConfig";

export type MovementState = "movement_detected" | "movement_not_detected" | "movement_uncertain";

/** Bounded GPS history summary; no coordinate history leaves the device. */
export interface GpsIntervalSummary {
  samples: number;
  duplicateSamples: number;
  outOfOrderSamples: number;
  invalidSamples: number;
  maxDisplacementMeters: number;
  significantExcursionObserved: boolean;
}

export interface MovementAssessment {
  version: "gps-speed-motion-shadow-v2";
  mode: "shadow";
  state: MovementState;
  displacementMeters: number | null;
  sampleCount: number;
  gpsQualityIssues: string[];
  reasons: string[];
  gps: GpsQualityAssessment;
  motion?: MotionIntervalSummary;
  interval?: GpsIntervalSummary;
  history?: GpsHistorySummary;
  gpsNoiseReferenceMeters?: number;
  rationale: string[];
}

/**
 * Diagnostic only: callers must not treat this result as navigation permission.
 * Accuracy is a reported noise indicator, not an error bound or calibrated probability.
 * Walking is activity evidence, not a displacement measurement.
 */
export function assessMovement(input: GpsQualityInput & {
  motion?: MotionIntervalSummary;
  interval?: GpsIntervalSummary;
  history?: GpsHistorySummary;
  config?: MovementDiagnosticsConfig;
}): MovementAssessment {
  const config = input.config ?? defaults;
  const gps = assessGpsQuality(input, config);
  const history = input.history;
  const result: MovementAssessment = {
    version: "gps-speed-motion-shadow-v2", mode: "shadow", state: "movement_uncertain", gps,
    displacementMeters: gps.displacementMeters ?? null, sampleCount: history?.sampleCount ?? 0,
    gpsQualityIssues: [...new Set([...gps.issues, ...(history?.qualityIssues ?? [])])], reasons: [],
    motion: input.motion ? { ...input.motion } : undefined,
    interval: input.interval ? { ...input.interval } : undefined,
    history: history ? { ...history, qualityIssues: [...history.qualityIssues], issueCounts: { ...history.issueCounts },
      apparentSpeed: { ...history.apparentSpeed }, reportedSpeed: { ...history.reportedSpeed } } : undefined, rationale: [],
  };
  const decide = (state: MovementState, ...rationale: string[]) => Object.assign(result, { state, rationale, reasons: [...rationale] });
  if (!gps.usable || gps.displacementMeters === undefined || gps.uncertaintyMeters === undefined) {
    return decide("movement_uncertain", "gps_quality_insufficient", ...gps.issues);
  }
  if (!history) return decide("movement_uncertain", "gps_history_missing");
  if (history.lastAcceptedTimestamp !== gps.latestTimestamp) return decide("movement_uncertain", "latest_fix_not_accepted");
  const motion = input.motion;
  const moving = !!motion && motion.movingEvents > 0;
  const stationary = !!motion && motion.stationaryEvents > 0 && motion.maxStationaryConfidence >= 1;
  const postCaptureMotion = moving && motion!.postCaptureMovingEvents > 0 && motion!.maxPostCaptureMovingConfidence >= 1;
  const noiseReference = Math.max(config.significantDisplacementMeters, gps.uncertaintyMeters);
  result.gpsNoiseReferenceMeters = noiseReference;
  const gpsBeyondReference = gps.displacementMeters > noiseReference || history.significantExcursionObserved;

  if (motion?.conflictingEvents) return decide("movement_uncertain", "conflicting_activity_flags");
  if (history.speedDisagreements) return decide("movement_uncertain", "gps_and_reported_speed_disagree");
  // Stationary evidence is not a veto of GPS movement; disagreement needs investigation.
  if (stationary && !moving && (gpsBeyondReference || history.reportedMovingSamples > 0)) return decide("movement_uncertain", "gps_motion_conflict");
  if (gpsBeyondReference && history.validPairs > 0) return decide("movement_detected", "credible_gps_excursion_during_interval");
  // A post-capture activity transition corroborates displacement near the reference,
  // but activity alone never proves that the user traversed a measured distance.
  if (gps.displacementMeters >= config.significantDisplacementMeters && history.validPairs > 0 &&
      (postCaptureMotion || history.reportedMovingSamples >= 2)) {
    return decide("movement_detected", postCaptureMotion ? "post_capture_activity_and_gps_displacement" : "reported_speed_history_and_gps_displacement");
  }
  if (moving || motion?.preCaptureMovingContext) {
    return decide("movement_uncertain", "activity_without_resolved_displacement",
      motion?.timestampSemantics === "delivery_time" ? "activity_start_time_unavailable" : "movement_may_be_hidden_by_gps");
  }
  if (gps.displacementMeters > config.significantDisplacementMeters) return decide("movement_uncertain", "displacement_overlaps_reported_gps_noise");
  if (history.reportedMovingSamples > 0 || history.positiveSpeedPairs > 0) return decide("movement_uncertain", "speed_without_resolved_displacement");
  if (!history.coverageAdequate) return decide("movement_uncertain", "gps_coverage_insufficient");
  if (history.rejectedSamples || history.reportedSpeedMissingSamples || history.reportedSpeedInvalidSamples || motion?.interrupted || motion?.ignoredEvents) {
    return decide("movement_uncertain", "interval_contains_missing_or_unreliable_evidence");
  }
  if (motion?.availability !== "available" || !motion.events || !stationary || motion.startedAt === undefined ||
      motion.startedAt - motion.captureAt > config.maxSampleGapMs) {
    return decide("movement_uncertain", "motion_evidence_unavailable_or_insufficient");
  }
  return decide("movement_not_detected", "adequately_sampled_gps_and_speed_consistent_with_capture",
    "stationary_activity_corroborates_not_proof_of_no_movement");
}
