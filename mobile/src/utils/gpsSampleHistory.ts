import { assessGpsTransition, gpsSampleIssues, type GpsSample } from "./gpsQuality";
import { distanceBetween } from "./lastMetersSafety";
import { MOVEMENT_DIAGNOSTICS_CONFIG as defaults, type MovementDiagnosticsConfig } from "./movementDiagnosticsConfig";

export interface SpeedSummary {
  count: number; min: number | null; max: number | null; mean: number | null; latest: number | null;
}

export interface GpsHistorySummary {
  samples: number; sampleCount: number; acceptedSamples: number; retainedSampleCount: number; droppedSamples: number;
  duplicateSamples: number; outOfOrderSamples: number; invalidSamples: number;
  rejectedSamples: number; issueCounts: Record<string, number>; qualityIssues: string[];
  firstAcceptedTimestamp: number | null; lastAcceptedTimestamp: number | null;
  maxDisplacementMeters: number; significantExcursionObserved: boolean;
  validPairs: number; positiveSpeedPairs: number; speedDisagreements: number;
  apparentSpeed: SpeedSummary; reportedSpeed: SpeedSummary;
  maxObservedApparentSpeedMps: number | null; reportedMovingSamples: number;
  reportedSpeedMissingSamples: number; reportedSpeedInvalidSamples: number;
  elapsedMs: number; coveredMs: number; coverageRatio: number; coverageAdequate: boolean;
  gapCount: number; maxGapMs: number; startupGapMs: number; tailGapMs: number;
  firstReceivedAt: number | null; lastReceivedAt: number | null;
  maxDeliveryGapMs: number; maxSampleAgeAtDeliveryMs: number;
  unavailableEvents: number;
  stoppedReason?: string;
}

const emptySpeed = (): SpeedSummary => ({ count: 0, min: null, max: null, mean: null, latest: null });
const addSpeed = (summary: SpeedSummary, speed: number) => {
  summary.mean = ((summary.mean ?? 0) * summary.count + speed) / (summary.count + 1);
  summary.count++;
  summary.min = Math.min(summary.min ?? speed, speed);
  summary.max = Math.max(summary.max ?? speed, speed);
  summary.latest = speed;
};

/** One bounded local history per photo. Capture is retained separately from the rolling callback buffer. */
export function createGpsSampleHistory(capture: GpsSample | undefined, captureAt: number,
  config: MovementDiagnosticsConfig = defaults) {
  const anchor = capture ? { ...capture } : undefined;
  const captureIssues = anchor ? gpsSampleIssues(anchor, captureAt, config) : ["capture_missing"];
  if (anchor && Math.abs(anchor.timestamp - captureAt) > config.capturePhotoToleranceMs) captureIssues.push("capture_not_near_photo");
  let accepted = anchor && captureIssues.length === 0 ? anchor : undefined;
  let previousReceived = anchor;
  let firstPostCaptureTimestamp: number | undefined;
  let stoppedReason: string | undefined;
  const entries: Array<{ sample: GpsSample; receivedAt: number; transition: ReturnType<typeof assessGpsTransition>; accepted: boolean; issues: string[] }> = [];
  const stats = {
    samples: 0, acceptedSamples: accepted ? 1 : 0, droppedSamples: 0,
    duplicateSamples: 0, outOfOrderSamples: 0, invalidSamples: captureIssues.length ? 1 : 0,
    rejectedSamples: captureIssues.length ? 1 : 0, issueCounts: {} as Record<string, number>,
    firstAcceptedTimestamp: accepted?.timestamp ?? null,
    maxDisplacementMeters: 0, significantExcursionObserved: false,
    validPairs: 0, positiveSpeedPairs: 0, speedDisagreements: 0,
    apparentSpeed: emptySpeed(), reportedSpeed: emptySpeed(),
    maxObservedApparentSpeedMps: null as number | null, reportedMovingSamples: 0,
    reportedSpeedMissingSamples: 0, reportedSpeedInvalidSamples: 0,
    coveredMs: 0, gapCount: 0, maxGapMs: 0,
    firstReceivedAt: null as number | null, lastReceivedAt: null as number | null,
    maxDeliveryGapMs: 0, maxSampleAgeAtDeliveryMs: 0,
    unavailableEvents: 0,
  };
  const recordIssues = (issues: string[]) => {
    for (const issue of new Set(issues)) stats.issueCounts[issue] = (stats.issueCounts[issue] ?? 0) + 1;
  };
  recordIssues(captureIssues.map(issue => `capture_${issue.replace(/^capture_/, "")}`));

  return {
    observe(sample: GpsSample, observedAt: number) {
      if (stoppedReason || observedAt - captureAt > config.maxSessionDurationMs) return;
      const current = { ...sample };
      stats.samples++;
      if (Number.isFinite(observedAt)) {
        stats.firstReceivedAt ??= observedAt;
        if (stats.lastReceivedAt !== null) stats.maxDeliveryGapMs = Math.max(stats.maxDeliveryGapMs, observedAt - stats.lastReceivedAt);
        stats.lastReceivedAt = observedAt;
        if (Number.isFinite(current.timestamp)) stats.maxSampleAgeAtDeliveryMs = Math.max(stats.maxSampleAgeAtDeliveryMs, observedAt - current.timestamp);
      }
      // Always retain the consecutive raw transition for diagnostics, even if either fix is rejected.
      const transition = assessGpsTransition(previousReceived, current, observedAt, config);
      previousReceived = current;
      if (transition.apparentSpeedMps !== null) stats.maxObservedApparentSpeedMps = Math.max(
        stats.maxObservedApparentSpeedMps ?? 0, transition.apparentSpeedMps);
      const baseline = assessGpsTransition(accepted, current, observedAt, config);
      const issues = gpsSampleIssues(current, observedAt, config);
      if (current.timestamp < captureAt) issues.push("before_capture");
      if (accepted) {
        if (current.timestamp === accepted.timestamp) {
          issues.push("duplicate_timestamp"); stats.duplicateSamples++;
          if (current.latitude !== accepted.latitude || current.longitude !== accepted.longitude) issues.push("inconsistent_timestamp");
        } else if (current.timestamp < accepted.timestamp) {
          issues.push("out_of_order_timestamp"); stats.outOfOrderSamples++;
        }
        if (baseline.issues.includes("implausible_speed")) issues.push("implausible_speed");
      }
      const usable = issues.length === 0;
      if (!usable) {
        stats.rejectedSamples++;
        if (!issues.every(issue => issue === "duplicate_timestamp" || issue === "out_of_order_timestamp" || issue === "before_capture")) stats.invalidSamples++;
      }
      recordIssues([...issues, ...transition.issues, ...(transition.reportedSpeedIssue ? [transition.reportedSpeedIssue] : [])]);
      if (transition.reportedSpeedIssue === "reported_speed_missing") stats.reportedSpeedMissingSamples++;
      else if (transition.reportedSpeedIssue === "reported_speed_invalid") stats.reportedSpeedInvalidSamples++;
      if (usable) {
        if (current.timestamp >= captureAt) firstPostCaptureTimestamp ??= current.timestamp;
        if (accepted) {
          const gap = current.timestamp - Math.max(captureAt, accepted.timestamp);
          stats.maxGapMs = Math.max(stats.maxGapMs, gap);
          if (gap > config.maxSampleGapMs) stats.gapCount++;
          else stats.coveredMs += Math.max(0, gap);
        }
        if (transition.usable) {
          stats.validPairs++;
          addSpeed(stats.apparentSpeed, transition.apparentSpeedMps!);
          if (transition.apparentSpeedMps! >= config.movingSpeedMps) stats.positiveSpeedPairs++;
          if (transition.speedDisagreement) stats.speedDisagreements++;
        }
        if (transition.reportedSpeedMps !== null) {
          addSpeed(stats.reportedSpeed, transition.reportedSpeedMps);
          if (transition.reportedSpeedMps >= config.movingSpeedMps) stats.reportedMovingSamples++;
        }
        stats.acceptedSamples++;
        stats.firstAcceptedTimestamp ??= current.timestamp;
        accepted = current;
        if (anchor && captureIssues.length === 0) {
          const displacement = distanceBetween({ lat: anchor.latitude, lng: anchor.longitude },
            { lat: current.latitude, lng: current.longitude });
          stats.maxDisplacementMeters = Math.max(stats.maxDisplacementMeters, displacement);
          if (displacement > Math.max(config.significantDisplacementMeters, Math.hypot(anchor.accuracy!, current.accuracy!))) {
            stats.significantExcursionObserved = true;
          }
        }
      }
      entries.push({ sample: current, receivedAt: observedAt, transition, accepted: usable, issues: [...new Set(issues)] });
      const capacity = Math.max(0, Math.floor(config.maxHistorySamples) - (anchor ? 1 : 0));
      if (entries.length > capacity) { entries.shift(); stats.droppedSamples++; }
    },
    stop(reason: string) { stoppedReason ??= reason; },
    markUnavailable(observedAt = Date.now()) {
      if (stoppedReason || observedAt - captureAt > config.maxSessionDurationMs) return;
      stats.unavailableEvents++;
      recordIssues(["gps_provider_unavailable"]);
    },
    snapshot(observedAt: number): { capture?: GpsSample; entries: typeof entries; summary: GpsHistorySummary } {
      const elapsedMs = Math.max(0, observedAt - captureAt);
      const startupGapMs = Math.max(0, (firstPostCaptureTimestamp ?? observedAt) - captureAt);
      const tailGapMs = Math.max(0, observedAt - Math.max(captureAt, accepted?.timestamp ?? captureAt));
      const maxGapMs = Math.max(stats.maxGapMs, startupGapMs, tailGapMs);
      const coverageRatio = elapsedMs > 0 ? Math.min(1, stats.coveredMs / elapsedMs) : 0;
      const qualityIssues = Object.keys(stats.issueCounts);
      const endedReason = stoppedReason ?? (elapsedMs > config.maxSessionDurationMs ? "timeout" : undefined);
      if (endedReason === "timeout") qualityIssues.push("gps_session_timeout");
      if (!accepted) qualityIssues.push("no_accepted_samples");
      if (maxGapMs > config.maxSampleGapMs) qualityIssues.push("gps_coverage_gap");
      const coverageAdequate = Number.isFinite(observedAt) && !endedReason && !stats.unavailableEvents && elapsedMs >= config.minCoverageDurationMs &&
        stats.acceptedSamples >= config.minAcceptedSamples && maxGapMs <= config.maxSampleGapMs && coverageRatio >= config.minCoverageRatio;
      return {
        capture: anchor ? { ...anchor } : undefined,
        entries: entries.map(entry => ({ sample: { ...entry.sample }, receivedAt: entry.receivedAt, accepted: entry.accepted,
          issues: [...entry.issues], transition: { ...entry.transition, issues: [...entry.transition.issues] } })),
        summary: { ...stats, issueCounts: { ...stats.issueCounts }, qualityIssues,
          sampleCount: stats.samples + (anchor ? 1 : 0), retainedSampleCount: entries.length + (anchor ? 1 : 0),
          lastAcceptedTimestamp: accepted?.timestamp ?? null,
          apparentSpeed: { ...stats.apparentSpeed }, reportedSpeed: { ...stats.reportedSpeed },
          elapsedMs, startupGapMs, tailGapMs, maxGapMs, coverageRatio, coverageAdequate, stoppedReason: endedReason },
      };
    },
  };
}
