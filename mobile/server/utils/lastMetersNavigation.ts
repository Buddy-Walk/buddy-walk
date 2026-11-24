import { GPS_ACCURACY_MAX_METERS } from "../../src/utils/lastMetersSafety";

export const LAST_METERS_HEADINGS = [0, 22.5, 45, 67.5, 90, 112.5, 135, 157.5, 180, 202.5, 225, 247.5, 270, 292.5, 315, 337.5] as const;
export const LAST_METERS_PANORAMA_FOV_DEGREES = 22.5;
export const LAST_METERS_EXACT_RADIUS_METERS = 250;
export const LAST_METERS_DESTINATION_REFERENCE_RADIUS_METERS = 75;
/**
 * Most GPS error the exact-mode gate will forgive. Past this the fix is too
 * vague to trust a panorama match, even if the user really is at the door.
 */
export const LAST_METERS_GPS_ALLOWANCE_MAX_METERS = 100;
export const LAST_METERS_STALE_IMAGERY_YEARS = 3;
export const LAST_METERS_REFERENCE_MAX_AGE_YEARS = 8;

export type LastMetersTestScenario =
  | "test_a_visible"
  | "test_a_reference"
  | "test_a_sign_text"
  | "test_b_approach"
  | "heading_aligned"
  | "heading_conflict"
  | "destination_unverified"
  | "no_panorama"
  | "question_routed";

export const LAST_METERS_TEST_SCENARIOS: readonly LastMetersTestScenario[] = [
  "test_a_visible",
  "test_a_reference",
  "test_a_sign_text",
  "test_b_approach",
  "heading_aligned",
  "heading_conflict",
  "destination_unverified",
  "no_panorama",
  "question_routed",
];

export type LastMetersConfidenceLevel = "high" | "medium" | "low";

/** Highest score allowed when compass and panorama disagree; always "low". */
export const LAST_METERS_HEADING_CONFLICT_MAX_SCORE = 0.5;
/** Score ≥ this is "high". Do not lower without a Safety Gate review. */
export const LAST_METERS_CONFIDENCE_HIGH_THRESHOLD = 0.75;
export const LAST_METERS_CONFIDENCE_MEDIUM_THRESHOLD = 0.55;
export const LAST_METERS_CONFIDENCE_BASE_SCORE = 0.15;
export const LAST_METERS_CONFIDENCE_COMBINATION_RULE =
  "additive_independent_evidence_with_heading_conflict_cap";

/**
 * Below this distance (or the GPS accuracy, if larger) the bearing from the
 * phone's GPS fix to the Places pin is noise, so it must not drive a turn.
 */
export const LAST_METERS_MIN_RELIABLE_BEARING_METERS = 10;
const LAST_METERS_DEFAULT_GPS_ACCURACY_METERS = 15;

export interface LastMetersConfidenceInput {
  gpsAccuracyMeters?: number;
  /** expo-location compass calibration: 3 high, 2 medium, 1 low, 0 none. */
  compassAccuracyLevel?: number;
  panoramaCurrentViewMatched: boolean;
  compassPanoramaAgrees?: boolean;
  destinationVisuallyMatched: boolean;
  destinationReferenceVerified: boolean;
  panoramaAgeYears?: number;
}

export type ConfidenceComponentId =
  | "base"
  | "gps_accuracy"
  | "panorama_current_view"
  | "compass_panorama_agreement"
  | "compass_calibration"
  | "destination_visual"
  | "destination_reference"
  | "panorama_age"
  | "heading_conflict_cap";

export interface ConfidenceFusionComponent {
  id: ConfidenceComponentId;
  /** Provenance label for Trial / diagnostics. */
  provenance: string;
  delta: number;
  /** Independent evidence slot; correlated signals share a slot and must not stack. */
  evidenceSlot: string;
  status: "applied" | "skipped" | "capped" | "unavailable" | "conflict";
}

export interface ConfidenceFusionDiagnostics {
  reason: "confidence_not_high" | null;
  combinationRule: typeof LAST_METERS_CONFIDENCE_COMBINATION_RULE;
  baseScore: number;
  highThreshold: number;
  mediumThreshold: number;
  headingConflictMaxScore: number;
  components: ConfidenceFusionComponent[];
  /** Evidence slots that contributed a positive delta (no double-count). */
  independentSlotsApplied: string[];
  rawScoreBeforeCap: number;
  finalScore: number;
  level: LastMetersConfidenceLevel;
  hardGateHints: Array<"heading_sources_disagree" | "orientation_not_corroborated" | "bearing_uncertainty_too_large">;
}

export interface LastMetersConfidence {
  score: number;
  level: LastMetersConfidenceLevel;
  reasons: string[];
  /** Provenance for #78; optional for older callers that only read score/level/reasons. */
  fusion?: ConfidenceFusionDiagnostics;
}

/**
 * Combines the independent evidence sources used in the last-meters study.
 * It intentionally does not choose a guidance heading; the compass remains
 * authoritative for that decision.
 */
export function calculateLastMetersConfidence(
  input: LastMetersConfidenceInput
): LastMetersConfidence {
  const reasons: string[] = [];
  const components: ConfidenceFusionComponent[] = [{
    id: "base",
    provenance: "heuristic_floor",
    delta: LAST_METERS_CONFIDENCE_BASE_SCORE,
    evidenceSlot: "base",
    status: "applied",
  }];
  // The score starts low: a high-confidence result needs corroboration from
  // several sources, not merely a verified map destination.
  let score = LAST_METERS_CONFIDENCE_BASE_SCORE;
  const appliedSlots = new Set<string>(["base"]);

  const applyPositive = (
    id: ConfidenceComponentId,
    provenance: string,
    slot: string,
    delta: number,
  ) => {
    if (appliedSlots.has(slot)) {
      components.push({ id, provenance, delta: 0, evidenceSlot: slot, status: "skipped" });
      return;
    }
    appliedSlots.add(slot);
    score += delta;
    components.push({ id, provenance, delta, evidenceSlot: slot, status: "applied" });
  };

  if (input.gpsAccuracyMeters === undefined) {
    reasons.push("Phone GPS accuracy was not available.");
    components.push({
      id: "gps_accuracy", provenance: "device_gps_accuracy_meters", delta: 0,
      evidenceSlot: "gps", status: "unavailable",
    });
  } else if (input.gpsAccuracyMeters <= 15) {
    applyPositive("gps_accuracy", "device_gps_accuracy_meters", "gps", 0.2);
  } else if (input.gpsAccuracyMeters <= 40) {
    applyPositive("gps_accuracy", "device_gps_accuracy_meters", "gps", 0.12);
  } else {
    applyPositive("gps_accuracy", "device_gps_accuracy_meters", "gps", 0.03);
    reasons.push(`Phone GPS accuracy is about ${Math.round(input.gpsAccuracyMeters)} meters.`);
  }

  if (input.panoramaCurrentViewMatched) {
    applyPositive("panorama_current_view", "panorama_current_view_match", "panorama_view", 0.2);
  } else {
    reasons.push("The user photo did not independently match the panorama.");
    components.push({
      id: "panorama_current_view", provenance: "panorama_current_view_match", delta: 0,
      evidenceSlot: "panorama_view", status: "unavailable",
    });
  }

  if (input.compassPanoramaAgrees === true) {
    applyPositive("compass_panorama_agreement", "compass_vs_panorama_heading", "heading_cross_check", 0.15);
  } else if (input.compassPanoramaAgrees === false) {
    reasons.push("Compass and panorama headings disagree.");
    components.push({
      id: "compass_panorama_agreement", provenance: "compass_vs_panorama_heading", delta: 0,
      evidenceSlot: "heading_cross_check", status: "conflict",
    });
  } else {
    reasons.push("Compass and panorama headings could not be compared.");
    components.push({
      id: "compass_panorama_agreement", provenance: "compass_vs_panorama_heading", delta: 0,
      evidenceSlot: "heading_cross_check", status: "unavailable",
    });
  }

  if (
    typeof input.compassAccuracyLevel === "number" &&
    input.compassAccuracyLevel < 3
  ) {
    score -= 0.05;
    reasons.push("Phone compass calibration is not high.");
    components.push({
      id: "compass_calibration", provenance: "expo_compass_accuracy_level", delta: -0.05,
      evidenceSlot: "compass_calibration", status: "applied",
    });
  }

  // Destination visual and Street View reference share one evidence slot — never stack both.
  if (input.destinationVisuallyMatched) {
    applyPositive("destination_visual", "destination_visually_matched", "destination", 0.2);
  } else if (input.destinationReferenceVerified) {
    applyPositive("destination_reference", "destination_street_view_reference", "destination", 0.12);
    reasons.push("Destination was verified with a separate Street View reference.");
  } else {
    reasons.push("Destination was not visually verified.");
    components.push({
      id: "destination_visual", provenance: "destination_visually_matched", delta: 0,
      evidenceSlot: "destination", status: "unavailable",
    });
  }

  if (
    typeof input.panoramaAgeYears === "number" &&
    input.panoramaAgeYears >= LAST_METERS_STALE_IMAGERY_YEARS
  ) {
    score -= 0.05;
    reasons.push(
      `Street View imagery is about ${Math.floor(input.panoramaAgeYears)} years old.`
    );
    components.push({
      id: "panorama_age", provenance: "street_view_imagery_age_years", delta: -0.05,
      evidenceSlot: "panorama_age", status: "applied",
    });
  }

  const rawScoreBeforeCap = score;
  // One wrong heading source means the turn itself may be wrong, so no amount
  // of other agreement can make the result trustworthy.
  if (input.compassPanoramaAgrees === false) {
    score = Math.min(score, LAST_METERS_HEADING_CONFLICT_MAX_SCORE);
    components.push({
      id: "heading_conflict_cap",
      provenance: "LAST_METERS_HEADING_CONFLICT_MAX_SCORE",
      delta: score - rawScoreBeforeCap,
      evidenceSlot: "heading_conflict_cap",
      status: "capped",
    });
  }

  const boundedScore = Math.max(0, Math.min(1, score));
  const level: LastMetersConfidenceLevel =
    boundedScore >= LAST_METERS_CONFIDENCE_HIGH_THRESHOLD ? "high"
      : boundedScore >= LAST_METERS_CONFIDENCE_MEDIUM_THRESHOLD ? "medium"
        : "low";

  const hardGateHints: ConfidenceFusionDiagnostics["hardGateHints"] = [];
  if (input.compassPanoramaAgrees === false) hardGateHints.push("heading_sources_disagree");
  if (!input.panoramaCurrentViewMatched || input.compassPanoramaAgrees !== true) {
    hardGateHints.push("orientation_not_corroborated");
  }

  const fusion: ConfidenceFusionDiagnostics = {
    reason: level === "high" ? null : "confidence_not_high",
    combinationRule: LAST_METERS_CONFIDENCE_COMBINATION_RULE,
    baseScore: LAST_METERS_CONFIDENCE_BASE_SCORE,
    highThreshold: LAST_METERS_CONFIDENCE_HIGH_THRESHOLD,
    mediumThreshold: LAST_METERS_CONFIDENCE_MEDIUM_THRESHOLD,
    headingConflictMaxScore: LAST_METERS_HEADING_CONFLICT_MAX_SCORE,
    components,
    independentSlotsApplied: [...appliedSlots].filter(slot => slot !== "base"),
    rawScoreBeforeCap,
    finalScore: boundedScore,
    level,
    hardGateHints,
  };

  return {
    score: boundedScore,
    level,
    reasons,
    fusion,
  };
}

const NOT_VISIBLE_PATTERN =
  /\b(?:not visible|not in view|cannot (?:identify|locate|match|see)|can't (?:identify|locate|match|see)|unknown|no match)\b/i;

export function parseLastMetersHeading(response: string): number | null {
  const text = response.trim();
  if (!text || NOT_VISIBLE_PATTERN.test(text) || /\bNOT_VISIBLE\b/i.test(text)) {
    return null;
  }

  const validHeadings = new Set<number>(LAST_METERS_HEADINGS);
  const numbers = [...text.matchAll(/-?\d+(?:\.\d+)?/g)].map((match) => Number(match[0]));
  const headingMatches = [
    ...new Set(
      numbers
        .map((heading) => (heading === 360 ? 0 : heading))
        .filter((heading) => validHeadings.has(heading)),
    ),
  ];
  if (headingMatches.length === 1) return headingMatches[0];

  // Tile overlays are "VIEW n | 045 DEG". The model sometimes echoes the
  // view index instead of the heading; 1-16 never overlap real headings.
  if (headingMatches.length === 0 && numbers.length === 1) {
    const viewIndex = numbers[0];
    if (Number.isInteger(viewIndex) && viewIndex >= 1 && viewIndex <= LAST_METERS_HEADINGS.length) {
      return LAST_METERS_HEADINGS[viewIndex - 1];
    }
  }

  return null;
}

export function parseDestinationVisibility(response: string): boolean {
  return response.trim().toUpperCase() === "VISIBLE";
}

export function snapLastMetersHeading(heading: number): number {
  if (!Number.isFinite(heading)) {
    throw new Error("Last Meters heading must be a finite number.");
  }
  const normalized = ((heading % 360) + 360) % 360;
  return LAST_METERS_HEADINGS[
    Math.round(normalized / LAST_METERS_PANORAMA_FOV_DEGREES) % LAST_METERS_HEADINGS.length
  ];
}

export function lastMetersHeadingDifference(
  currentHeading: number,
  targetHeading: number
): number {
  if (!Number.isFinite(currentHeading) || !Number.isFinite(targetHeading)) {
    throw new Error("Last Meters headings must be finite numbers.");
  }
  return Math.abs(((targetHeading - currentHeading + 540) % 360) - 180);
}

export function isLastMetersHeadingAligned(
  currentHeading: number,
  targetHeading: number,
  toleranceDegrees = 30
): boolean {
  if (!Number.isFinite(toleranceDegrees) || toleranceDegrees < 0 || toleranceDegrees > 180) {
    throw new Error("Last Meters heading tolerance must be between 0 and 180 degrees.");
  }
  return lastMetersHeadingDifference(currentHeading, targetHeading) <= toleranceDegrees;
}

/**
 * Compass vs visual (panorama-matched) agreement budget.
 * Do not widen without a Safety Gate review — wrong-direction leakage risk.
 */
export const HEADING_SOURCES_AGREEMENT_MAX_DEGREES = 45;

export type HeadingSourceReferenceFrame =
  | "compass_true_north_snapped"
  | "compass_magnetic_snapped"
  | "compass_unknown_snapped"
  | "panorama_tile_heading";

export type HeadingSourcesDisagreeFailureKind =
  | "compass_heading_unavailable"
  | "panorama_heading_unavailable"
  | "circular_discrepancy_above_max";

export interface HeadingSourcesDisagreeDiagnostics {
  reason: "heading_sources_disagree" | null;
  /** Raw device compass before tile snap; null when missing/invalid. */
  rawCompassHeadingDegrees: number | null;
  /** Snapped compass used for comparison (authoritative for turns). */
  compassHeadingDegrees: number | null;
  panoramaMatchedHeadingDegrees: number | null;
  circularDiscrepancyDegrees: number | null;
  maxAgreementDegrees: number;
  compassReferenceFrame: HeadingSourceReferenceFrame;
  panoramaReferenceFrame: HeadingSourceReferenceFrame;
  /** Optional client timestamps when known; ages only — no lat/lng. */
  compassTimestamp: number | null;
  panoramaMatchTimestamp: number | null;
  /** Optional Expo compass accuracy 0–3 when recorded. */
  compassAccuracyLevel: number | null;
  failureKinds: HeadingSourcesDisagreeFailureKind[];
}

/**
 * Instrument compass vs panorama conflict detection (#74).
 * Unavailable sources are classified separately from a trusted disagreement.
 * Threshold remains 45°; wrap-around uses shortest-arc difference after snap.
 */
export function headingSourcesDisagreeDiagnostics(
  deviceHeading: number | undefined,
  panoramaMatchedHeading: number | null,
  options?: {
    agreementToleranceDegrees?: number;
    compassTimestamp?: number;
    panoramaMatchTimestamp?: number;
    compassAccuracyLevel?: number | null;
    /** Reference of the compass sample actually compared (capture headingReference). */
    compassReference?: "true" | "magnetic" | "unknown";
  },
): HeadingSourcesDisagreeDiagnostics {
  const maxAgreementDegrees = options?.agreementToleranceDegrees ?? HEADING_SOURCES_AGREEMENT_MAX_DEGREES;
  const failureKinds: HeadingSourcesDisagreeFailureKind[] = [];
  const rawOk = typeof deviceHeading === "number" && Number.isFinite(deviceHeading);
  const rawCompassHeadingDegrees = rawOk ? deviceHeading : null;
  const compassHeadingDegrees = rawOk ? snapLastMetersHeading(deviceHeading!) : null;
  if (compassHeadingDegrees === null) failureKinds.push("compass_heading_unavailable");

  const panoramaOk = typeof panoramaMatchedHeading === "number" && Number.isFinite(panoramaMatchedHeading);
  const panoramaMatchedHeadingDegrees = panoramaOk ? panoramaMatchedHeading : null;
  if (panoramaMatchedHeadingDegrees === null) failureKinds.push("panorama_heading_unavailable");

  let circularDiscrepancyDegrees: number | null = null;
  if (compassHeadingDegrees !== null && panoramaMatchedHeadingDegrees !== null) {
    circularDiscrepancyDegrees = lastMetersHeadingDifference(
      compassHeadingDegrees,
      panoramaMatchedHeadingDegrees,
    );
    if (circularDiscrepancyDegrees > maxAgreementDegrees) {
      failureKinds.push("circular_discrepancy_above_max");
    }
  }

  const accuracy = options?.compassAccuracyLevel;
  const compassReferenceFrame: HeadingSourceReferenceFrame =
    options?.compassReference === "magnetic" ? "compass_magnetic_snapped"
      : options?.compassReference === "unknown" ? "compass_unknown_snapped"
        : "compass_true_north_snapped";
  return {
    reason: failureKinds.includes("circular_discrepancy_above_max") ? "heading_sources_disagree" : null,
    rawCompassHeadingDegrees,
    compassHeadingDegrees,
    panoramaMatchedHeadingDegrees,
    circularDiscrepancyDegrees,
    maxAgreementDegrees,
    compassReferenceFrame,
    panoramaReferenceFrame: "panorama_tile_heading",
    compassTimestamp: Number.isFinite(options?.compassTimestamp) ? options!.compassTimestamp! : null,
    panoramaMatchTimestamp: Number.isFinite(options?.panoramaMatchTimestamp)
      ? options!.panoramaMatchTimestamp!
      : null,
    compassAccuracyLevel:
      typeof accuracy === "number" && Number.isFinite(accuracy) ? accuracy : null,
    failureKinds: [...new Set(failureKinds)],
  };
}

export function compareCompassAndPanoramaHeadings(
  deviceHeading: number | undefined,
  panoramaMatchedHeading: number | null,
  agreementToleranceDegrees = HEADING_SOURCES_AGREEMENT_MAX_DEGREES
): {
  compassHeading: number | null;
  panoramaMatchedHeading: number | null;
  authoritativeHeading: number | null;
  differenceDegrees?: number;
  agrees?: boolean;
} {
  const diag = headingSourcesDisagreeDiagnostics(deviceHeading, panoramaMatchedHeading, {
    agreementToleranceDegrees,
  });
  const differenceDegrees = diag.circularDiscrepancyDegrees ?? undefined;

  return {
    compassHeading: diag.compassHeadingDegrees,
    panoramaMatchedHeading: diag.panoramaMatchedHeadingDegrees,
    // Panorama is logged for evaluation but can never control guidance.
    authoritativeHeading: diag.compassHeadingDegrees,
    differenceDegrees,
    agrees:
      differenceDegrees === undefined
        ? undefined
        : differenceDegrees <= agreementToleranceDegrees,
  };
}

export function resolveVerifiedTargetHeading(
  visuallyMatchedHeading: number | null,
  expectedMapHeading: number,
  toleranceDegrees = LAST_METERS_PANORAMA_FOV_DEGREES
): number | null {
  if (
    !LAST_METERS_HEADINGS.includes(
      expectedMapHeading as (typeof LAST_METERS_HEADINGS)[number]
    )
  ) {
    throw new Error("Expected target heading must be a panorama direction.");
  }
  if (visuallyMatchedHeading === null) return null;
  if (
    !LAST_METERS_HEADINGS.includes(
      visuallyMatchedHeading as (typeof LAST_METERS_HEADINGS)[number]
    )
  ) {
    throw new Error("Visual target heading must be a panorama direction.");
  }
  return lastMetersHeadingDifference(
    visuallyMatchedHeading,
    expectedMapHeading
  ) <= toleranceDegrees
    ? visuallyMatchedHeading
    : null;
}

export function formatLastMetersDistance(distanceMeters: number): string {
  if (distanceMeters >= 1_000) {
    return `${(distanceMeters / 1_609.344).toFixed(1)} miles`;
  }

  const feet = distanceMeters * 3.28084;

  // For very short distances, round to nearest 5 feet
  if (feet <= 30) {
    const minFeet = Math.max(5, Math.round(feet / 5) * 5);
    return `${minFeet} feet`;
  }

  // For 30-100 feet, round to nearest 10 feet
  if (feet <= 100) {
    return `${Math.round(feet / 10) * 10} feet`;
  }

  const roundedFeet = Math.round(feet / 50) * 50;
  return `${roundedFeet.toLocaleString("en-US")} feet`;
}

function formatLastMetersDirection(bearing: number): string {
  const directionNames = [
    "north",
    "northeast",
    "east",
    "southeast",
    "south",
    "southwest",
    "west",
    "northwest",
  ];
  return directionNames[Math.round((((bearing % 360) + 360) % 360) / 45) % 8];
}

export interface ExactModeGate {
  exact: boolean;
  /** Meters of GPS error forgiven; 0 when accuracy was unknown. */
  allowanceMeters: number;
  /** True only when the allowance is what let the trial into exact mode. */
  widened: boolean;
}

/**
 * Require the whole reported GPS uncertainty radius to fit inside exact mode.
 * Poor or unknown accuracy must not widen the precise-guidance boundary.
 */
export function resolveExactModeGate(
  distanceMeters: number,
  gpsAccuracyMeters?: number
): ExactModeGate {
  if (!Number.isFinite(distanceMeters) || distanceMeters < 0) {
    throw new Error("Last Meters distance must be a non-negative finite number.");
  }
  const accuracyKnown = typeof gpsAccuracyMeters === "number" && Number.isFinite(gpsAccuracyMeters) && gpsAccuracyMeters >= 0;
  const allowanceMeters = 0;
  const exact = accuracyKnown && gpsAccuracyMeters <= GPS_ACCURACY_MAX_METERS &&
    distanceMeters + gpsAccuracyMeters <= LAST_METERS_EXACT_RADIUS_METERS;
  return {
    exact,
    allowanceMeters,
    widened: false,
  };
}

/** Street View dates are "YYYY" or "YYYY-MM". */
export function streetViewImageryAgeYears(
  date: string | undefined,
  now = new Date()
): number | undefined {
  const match = date?.trim().match(/^(\d{4})(?:-(\d{1,2}))?/);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = match[2] ? Number(match[2]) : 6;
  if (!Number.isFinite(year) || month < 1 || month > 12) return undefined;
  const capturedMonths = year * 12 + (month - 1);
  const nowMonths = now.getUTCFullYear() * 12 + now.getUTCMonth();
  return Math.max(0, (nowMonths - capturedMonths) / 12);
}

export function shouldUseDestinationReference(distanceMeters: number, panoramaAgeYears?: number): boolean {
  if (!Number.isFinite(distanceMeters) || distanceMeters < 0) {
    throw new Error("Last Meters distance must be a non-negative finite number.");
  }
  return distanceMeters <= LAST_METERS_DESTINATION_REFERENCE_RADIUS_METERS &&
    !(typeof panoramaAgeYears === "number" && Number.isFinite(panoramaAgeYears) && panoramaAgeYears > LAST_METERS_REFERENCE_MAX_AGE_YEARS);
}

function describeResolvedBranch(destination: string, address?: string): string {
  const trimmed = address?.trim();
  return trimmed && trimmed !== destination
    ? `The nearest ${destination} I found, at ${trimmed},`
    : destination;
}

function differentBranchHint(destination: string, address?: string): string {
  return address?.trim() && address.trim() !== destination
    ? ` If you are at a different ${destination}, add the street name and try again.`
    : "";
}

export function buildAlignedHeadingInstruction(
  destination: string,
  distanceMeters: number,
  address?: string
): string {
  if (!Number.isFinite(distanceMeters) || distanceMeters < 0) {
    throw new Error("Last Meters distance must be a non-negative finite number.");
  }
  return (
    `${describeResolvedBranch(destination, address)} is roughly ${formatLastMetersDistance(distanceMeters)} ahead on your current heading. ` +
    "Keep this heading and continue with your primary navigation." +
    differentBranchHint(destination, address)
  );
}

export function buildLastMetersApproachInstruction(
  destination: string,
  distanceMeters: number,
  bearing: number,
  address?: string
): string {
  if (!Number.isFinite(distanceMeters) || distanceMeters < 0) {
    throw new Error("Last Meters distance must be a non-negative finite number.");
  }
  const direction = formatLastMetersDirection(bearing);
  const distance = formatLastMetersDistance(distanceMeters);

  return (
    `${describeResolvedBranch(destination, address)} is roughly ${distance} to the ${direction}. ` +
    "Continue with your primary navigation and use Last Meters again when you are within about 800 feet." +
    differentBranchHint(destination, address)
  );
}

export function isDestinationBearingReliable(
  distanceMeters: number,
  gpsAccuracyMeters?: number
): boolean {
  const accuracy =
    typeof gpsAccuracyMeters === "number" && Number.isFinite(gpsAccuracyMeters)
      ? gpsAccuracyMeters
      : LAST_METERS_DEFAULT_GPS_ACCURACY_METERS;
  return distanceMeters > Math.max(LAST_METERS_MIN_RELIABLE_BEARING_METERS, accuracy);
}

export function buildHeadingConflictInstruction(
  destination: string,
  distanceMeters: number
): string {
  if (!Number.isFinite(distanceMeters) || distanceMeters < 0) {
    throw new Error("Last Meters distance must be a non-negative finite number.");
  }
  return (
    `${destination} is about ${formatLastMetersDistance(distanceMeters)} away, but your phone compass and ` +
    "Street View disagree about which way you are facing, so I will not guess a turn. " +
    "Stay where you are, move the phone in a slow figure eight to recalibrate the compass, " +
    "then hold it upright in front of you and take a new photo."
  );
}

export function buildCloseRangeNoTurnInstruction(
  destination: string,
  distanceMeters: number,
  headingAligned = false,
  imageryDate?: string,
): string {
  if (!Number.isFinite(distanceMeters) || distanceMeters < 0) {
    throw new Error("Last Meters distance must be a non-negative finite number.");
  }
  const proximity = `You are within about ${formatLastMetersDistance(distanceMeters)} of ${destination}. `;
  if (headingAligned) {
    return proximity + "Your compass agrees with the estimated map direction, but GPS is too uncertain here to confirm the entrance is ahead. " +
      "Keep your current orientation while taking another photo; do not move forward based on this estimate. " +
      (imageryDate ? `Street View imagery from ${imageryDate} did not confirm the door.` : "Street View did not confirm the door.");
  }
  return (
    proximity +
    "At this range GPS cannot tell which side the entrance is on, so I will not guess a turn. " +
    "Face the storefront and take a new photo, or ask someone nearby for the door."
  );
}

/**
 * States how far the destination is once the user has turned. Built in code,
 * not by the model, because the model is forbidden from telling a blind user
 * to walk.
 */
export function buildLastMetersDistanceSentence(
  destination: string,
  distanceMeters: number,
  afterTurn = true
): string {
  if (!Number.isFinite(distanceMeters) || distanceMeters < 0) {
    throw new Error("Last Meters distance must be a non-negative finite number.");
  }
  const distance = formatLastMetersDistance(distanceMeters);
  const subject = afterTurn ? `After turning, ${destination}` : destination;
  return distanceMeters <= 30
    ? `${subject} is about ${distance} ahead.`
    : `${subject} is about ${distance} away in that direction. Continue with your primary navigation.`;
}

export function buildLastMetersRetakeInstruction(
  destination: string,
  distanceMeters: number,
  bearing: number
): string {
  if (!Number.isFinite(distanceMeters) || distanceMeters < 0) {
    throw new Error("Last Meters distance must be a non-negative finite number.");
  }
  return (
    `${destination} is not visible from this block and is roughly ` +
    `${formatLastMetersDistance(distanceMeters)} to the ${formatLastMetersDirection(bearing)}. ` +
    "Continue with your primary navigation for another block, then stop safely and take a new photo."
  );
}

/**
 * For a user standing at a large building whose listed entrance is elsewhere:
 * "not visible from this block" would wrongly send them away from a door that
 * may be right in front of them.
 */
export function buildBesideBuildingInstruction(
  destination: string,
  distanceMeters: number,
  bearing: number
): string {
  if (!Number.isFinite(distanceMeters) || distanceMeters < 0) {
    throw new Error("Last Meters distance must be a non-negative finite number.");
  }
  return (
    `You appear to be beside ${destination}, which may have more than one entrance. ` +
    "I could not confirm an entrance in front of you in Street View. " +
    `The entrance listed on Google Maps is roughly ${formatLastMetersDistance(distanceMeters)} ` +
    `to the ${formatLastMetersDirection(bearing)}. ` +
    "If you find a door here, ask someone nearby whether it is open to the public."
  );
}

export function buildClosedNowNotice(destination: string, temporarily = false): string {
  return temporarily
    ? ` Google Maps lists ${destination} as temporarily closed.`
    : ` Google Maps lists ${destination} as closed right now.`;
}

export function buildLastMetersSourceNote(streetViewDate?: string | null): string {
  if (streetViewDate === null) return " Source: Google Maps.";
  return streetViewDate
    ? ` Source: Google Maps and Street View imagery from ${streetViewDate}.`
    : " Source: Google Maps and Street View.";
}

/**
 * Takes raw (unsnapped) headings. Snapping both sides to 45 degree sectors
 * first can turn a true 0 degree difference into "45 left" or "45 right".
 */
export function buildLastMetersTurnInstruction(
  currentHeading: number,
  targetHeading: number
): string {
  if (!Number.isFinite(currentHeading) || !Number.isFinite(targetHeading)) {
    throw new Error("Last Meters headings must be finite numbers.");
  }

  // Signed difference in (-180, 180]; positive means turn right.
  const diff = ((((targetHeading - currentHeading) % 360) + 540) % 360) - 180;
  const degrees = Math.round(Math.abs(diff) / 5) * 5;

  if (degrees <= 15) {
    return "No turn needed. Keep facing forward.";
  }
  if (degrees >= 165) {
    return "Turn around 180 degrees without moving forward.";
  }

  const side = diff > 0 ? "right" : "left";
  if (degrees <= 35) {
    return `Turn slightly to your ${side}, about ${degrees} degrees.`;
  }
  return `Turn ${degrees} degrees to your ${side}.`;
}
