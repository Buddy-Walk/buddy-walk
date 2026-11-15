/** Experimental shadow-only parameters. Tune from held-out field data, never as calibrated error bounds. */
export const MOVEMENT_DIAGNOSTICS_CONFIG = Object.freeze({
  maxAccuracyMeters: 20,
  latestMaxAgeMs: 15_000,
  captureMaxAgeMs: 60_000,
  capturePhotoToleranceMs: 10_000,
  futureToleranceMs: 2_000,
  maxApparentSpeedMps: 8,
  movingSpeedMps: 0.3,
  speedDisagreementMps: 1,
  significantDisplacementMeters: 5,
  maxSampleGapMs: 5_000,
  minAcceptedSamples: 4,
  minCoverageDurationMs: 3_000,
  minCoverageRatio: 0.8,
  maxHistorySamples: 96,
  maxSessionDurationMs: 90_000,
});

export type MovementDiagnosticsConfig = { readonly [K in keyof typeof MOVEMENT_DIAGNOSTICS_CONFIG]: number };
