export const LAST_MILE_HEADINGS = [0, 22.5, 45, 67.5, 90, 112.5, 135, 157.5, 180, 202.5, 225, 247.5, 270, 292.5, 315, 337.5] as const;
export const LAST_MILE_PANORAMA_FOV_DEGREES = 22.5;
export const LAST_METERS_EXACT_RADIUS_METERS = 250;
export const LAST_METERS_DESTINATION_REFERENCE_RADIUS_METERS = 75;
/**
 * Most GPS error the exact-mode gate will forgive. Past this the fix is too
 * vague to trust a panorama match, even if the user really is at the door.
 */
export const LAST_METERS_GPS_ALLOWANCE_MAX_METERS = 100;
export const LAST_MILE_STALE_IMAGERY_YEARS = 3;
export const LAST_MILE_REFERENCE_MAX_AGE_YEARS = 8;

export type LastMileTestScenario =
  | "test_a_visible"
  | "test_a_reference"
  | "test_a_sign_text"
  | "test_b_approach"
  | "heading_aligned"
  | "heading_conflict"
  | "destination_unverified"
  | "no_panorama"
  | "question_routed";

export const LAST_MILE_TEST_SCENARIOS: readonly LastMileTestScenario[] = [
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

export type LastMileConfidenceLevel = "high" | "medium" | "low";

/** Highest score allowed when compass and panorama disagree; always "low". */
export const LAST_MILE_HEADING_CONFLICT_MAX_SCORE = 0.5;

/**
 * Below this distance (or the GPS accuracy, if larger) the bearing from the
 * phone's GPS fix to the Places pin is noise, so it must not drive a turn.
 */
export const LAST_MILE_MIN_RELIABLE_BEARING_METERS = 10;
const LAST_MILE_DEFAULT_GPS_ACCURACY_METERS = 15;

export interface LastMileConfidenceInput {
  gpsAccuracyMeters?: number;
  /** expo-location compass calibration: 3 high, 2 medium, 1 low, 0 none. */
  compassAccuracyLevel?: number;
  panoramaCurrentViewMatched: boolean;
  compassPanoramaAgrees?: boolean;
  destinationVisuallyMatched: boolean;
  destinationReferenceVerified: boolean;
  panoramaAgeYears?: number;
}

export interface LastMileConfidence {
  score: number;
  level: LastMileConfidenceLevel;
  reasons: string[];
}

/**
 * Combines the independent evidence sources used in the last-meters study.
 * It intentionally does not choose a guidance heading; the compass remains
 * authoritative for that decision.
 */
export function calculateLastMileConfidence(
  input: LastMileConfidenceInput
): LastMileConfidence {
  const reasons: string[] = [];
  // The score starts low: a high-confidence result needs corroboration from
  // several sources, not merely a verified map destination.
  let score = 0.15;

  if (input.gpsAccuracyMeters === undefined) {
    reasons.push("Phone GPS accuracy was not available.");
  } else if (input.gpsAccuracyMeters <= 15) {
    score += 0.2;
  } else if (input.gpsAccuracyMeters <= 40) {
    score += 0.12;
  } else {
    score += 0.03;
    reasons.push(`Phone GPS accuracy is about ${Math.round(input.gpsAccuracyMeters)} meters.`);
  }

  if (input.panoramaCurrentViewMatched) {
    score += 0.2;
  } else {
    reasons.push("The user photo did not independently match the panorama.");
  }

  if (input.compassPanoramaAgrees === true) {
    score += 0.15;
  } else if (input.compassPanoramaAgrees === false) {
    reasons.push("Compass and panorama headings disagree.");
  } else {
    reasons.push("Compass and panorama headings could not be compared.");
  }

  if (
    typeof input.compassAccuracyLevel === "number" &&
    input.compassAccuracyLevel < 3
  ) {
    score -= 0.05;
    reasons.push("Phone compass calibration is not high.");
  }

  if (input.destinationVisuallyMatched) {
    score += 0.2;
  } else if (input.destinationReferenceVerified) {
    score += 0.12;
    reasons.push("Destination was verified with a separate Street View reference.");
  } else {
    reasons.push("Destination was not visually verified.");
  }

  if (
    typeof input.panoramaAgeYears === "number" &&
    input.panoramaAgeYears >= LAST_MILE_STALE_IMAGERY_YEARS
  ) {
    score -= 0.05;
    reasons.push(
      `Street View imagery is about ${Math.floor(input.panoramaAgeYears)} years old.`
    );
  }

  // One wrong heading source means the turn itself may be wrong, so no amount
  // of other agreement can make the result trustworthy.
  if (input.compassPanoramaAgrees === false) {
    score = Math.min(score, LAST_MILE_HEADING_CONFLICT_MAX_SCORE);
  }

  const boundedScore = Math.max(0, Math.min(1, score));
  return {
    score: boundedScore,
    level: boundedScore >= 0.75 ? "high" : boundedScore >= 0.55 ? "medium" : "low",
    reasons,
  };
}

const NOT_VISIBLE_PATTERN =
  /\b(?:not visible|not in view|cannot (?:identify|locate|match|see)|can't (?:identify|locate|match|see)|unknown|no match)\b/i;

export function parseLastMileHeading(response: string): number | null {
  const text = response.trim();
  if (!text || NOT_VISIBLE_PATTERN.test(text) || /\bNOT_VISIBLE\b/i.test(text)) {
    return null;
  }

  const validHeadings = new Set<number>(LAST_MILE_HEADINGS);
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
    if (Number.isInteger(viewIndex) && viewIndex >= 1 && viewIndex <= LAST_MILE_HEADINGS.length) {
      return LAST_MILE_HEADINGS[viewIndex - 1];
    }
  }

  return null;
}

export function parseDestinationVisibility(response: string): boolean {
  return response.trim().toUpperCase() === "VISIBLE";
}

export function snapLastMileHeading(heading: number): number {
  if (!Number.isFinite(heading)) {
    throw new Error("Last Meters heading must be a finite number.");
  }
  const normalized = ((heading % 360) + 360) % 360;
  return LAST_MILE_HEADINGS[
    Math.round(normalized / LAST_MILE_PANORAMA_FOV_DEGREES) % LAST_MILE_HEADINGS.length
  ];
}

export function lastMileHeadingDifference(
  currentHeading: number,
  targetHeading: number
): number {
  if (!Number.isFinite(currentHeading) || !Number.isFinite(targetHeading)) {
    throw new Error("Last Meters headings must be finite numbers.");
  }
  return Math.abs(((targetHeading - currentHeading + 540) % 360) - 180);
}

export function isLastMileHeadingAligned(
  currentHeading: number,
  targetHeading: number,
  toleranceDegrees = 30
): boolean {
  if (!Number.isFinite(toleranceDegrees) || toleranceDegrees < 0 || toleranceDegrees > 180) {
    throw new Error("Last Meters heading tolerance must be between 0 and 180 degrees.");
  }
  return lastMileHeadingDifference(currentHeading, targetHeading) <= toleranceDegrees;
}

export function compareCompassAndPanoramaHeadings(
  deviceHeading: number | undefined,
  panoramaMatchedHeading: number | null,
  agreementToleranceDegrees = 45
): {
  compassHeading: number | null;
  panoramaMatchedHeading: number | null;
  authoritativeHeading: number | null;
  differenceDegrees?: number;
  agrees?: boolean;
} {
  const compassHeading =
    typeof deviceHeading === "number" && Number.isFinite(deviceHeading)
      ? snapLastMileHeading(deviceHeading)
      : null;
  const differenceDegrees =
    compassHeading !== null && panoramaMatchedHeading !== null
      ? lastMileHeadingDifference(compassHeading, panoramaMatchedHeading)
      : undefined;

  return {
    compassHeading,
    panoramaMatchedHeading,
    // Panorama is logged for evaluation but can never control guidance.
    authoritativeHeading: compassHeading,
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
  toleranceDegrees = LAST_MILE_PANORAMA_FOV_DEGREES
): number | null {
  if (
    !LAST_MILE_HEADINGS.includes(
      expectedMapHeading as (typeof LAST_MILE_HEADINGS)[number]
    )
  ) {
    throw new Error("Expected target heading must be a panorama direction.");
  }
  if (visuallyMatchedHeading === null) return null;
  if (
    !LAST_MILE_HEADINGS.includes(
      visuallyMatchedHeading as (typeof LAST_MILE_HEADINGS)[number]
    )
  ) {
    throw new Error("Visual target heading must be a panorama direction.");
  }
  return lastMileHeadingDifference(
    visuallyMatchedHeading,
    expectedMapHeading
  ) <= toleranceDegrees
    ? visuallyMatchedHeading
    : null;
}

export function formatLastMileDistance(distanceMeters: number): string {
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

function formatLastMileDirection(bearing: number): string {
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
  const exact = accuracyKnown && gpsAccuracyMeters <= 20 && distanceMeters + gpsAccuracyMeters <= LAST_METERS_EXACT_RADIUS_METERS;
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
    !(typeof panoramaAgeYears === "number" && Number.isFinite(panoramaAgeYears) && panoramaAgeYears > LAST_MILE_REFERENCE_MAX_AGE_YEARS);
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
    `${describeResolvedBranch(destination, address)} is roughly ${formatLastMileDistance(distanceMeters)} ahead on your current heading. ` +
    "Keep this heading and continue with your primary navigation." +
    differentBranchHint(destination, address)
  );
}

export function buildLastMileApproachInstruction(
  destination: string,
  distanceMeters: number,
  bearing: number,
  address?: string
): string {
  if (!Number.isFinite(distanceMeters) || distanceMeters < 0) {
    throw new Error("Last Meters distance must be a non-negative finite number.");
  }
  const direction = formatLastMileDirection(bearing);
  const distance = formatLastMileDistance(distanceMeters);

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
      : LAST_MILE_DEFAULT_GPS_ACCURACY_METERS;
  return distanceMeters > Math.max(LAST_MILE_MIN_RELIABLE_BEARING_METERS, accuracy);
}

export function buildHeadingConflictInstruction(
  destination: string,
  distanceMeters: number
): string {
  if (!Number.isFinite(distanceMeters) || distanceMeters < 0) {
    throw new Error("Last Meters distance must be a non-negative finite number.");
  }
  return (
    `${destination} is about ${formatLastMileDistance(distanceMeters)} away, but your phone compass and ` +
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
  const proximity = `You are within about ${formatLastMileDistance(distanceMeters)} of ${destination}. `;
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
export function buildLastMileDistanceSentence(
  destination: string,
  distanceMeters: number,
  afterTurn = true
): string {
  if (!Number.isFinite(distanceMeters) || distanceMeters < 0) {
    throw new Error("Last Meters distance must be a non-negative finite number.");
  }
  const distance = formatLastMileDistance(distanceMeters);
  const subject = afterTurn ? `After turning, ${destination}` : destination;
  return distanceMeters <= 30
    ? `${subject} is about ${distance} ahead.`
    : `${subject} is about ${distance} away in that direction. Continue with your primary navigation.`;
}

export function buildLastMileRetakeInstruction(
  destination: string,
  distanceMeters: number,
  bearing: number
): string {
  if (!Number.isFinite(distanceMeters) || distanceMeters < 0) {
    throw new Error("Last Meters distance must be a non-negative finite number.");
  }
  return (
    `${destination} is not visible from this block and is roughly ` +
    `${formatLastMileDistance(distanceMeters)} to the ${formatLastMileDirection(bearing)}. ` +
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
    `The entrance listed on Google Maps is roughly ${formatLastMileDistance(distanceMeters)} ` +
    `to the ${formatLastMileDirection(bearing)}. ` +
    "If you find a door here, ask someone nearby whether it is open to the public."
  );
}

export function buildClosedNowNotice(destination: string, temporarily = false): string {
  return temporarily
    ? ` Google Maps lists ${destination} as temporarily closed.`
    : ` Google Maps lists ${destination} as closed right now.`;
}

export function buildLastMileSourceNote(streetViewDate?: string | null): string {
  if (streetViewDate === null) return " Source: Google Maps.";
  return streetViewDate
    ? ` Source: Google Maps and Street View imagery from ${streetViewDate}.`
    : " Source: Google Maps and Street View.";
}

/**
 * Takes raw (unsnapped) headings. Snapping both sides to 45 degree sectors
 * first can turn a true 0 degree difference into "45 left" or "45 right".
 */
export function buildLastMileTurnInstruction(
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
