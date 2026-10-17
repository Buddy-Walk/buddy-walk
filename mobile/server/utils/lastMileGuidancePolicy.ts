import { sensorSafetyReasons, RECAPTURE_MESSAGE } from "../../src/utils/lastMileSafety";
import { mobileTurnSensorReasons } from "../../src/utils/mobileLastMileGuidance";
import { preciseTurnReasons, type WalkingEvidence } from "./lastMilePolicy";
import { buildLastMileSourceNote, formatLastMileDistance, resolveExactModeGate, LAST_METERS_EXACT_RADIUS_METERS } from "./lastMileNavigation";
import type { LastMetersRequestInput } from "./lastMileReplay";

export const MOBILE_LAST_MILE_GUIDANCE_VERSION = "2.0.0";

export interface LastMileGuidanceContext {
  destinationPlaceName?: string;
  destinationPlaceAddress?: string;
  destinationDistanceMeters?: number;
  panoramaMatchedHeading?: number;
  signTextMatched?: boolean;
  destinationReferenceUsed?: boolean;
  panoramaTargetHeading?: number;
}

interface FinalGuidance {
  turnInstruction: string;
  distanceSentence: string;
  landmarksGuidance: string;
  closedNotice: string;
  panoramaDate?: string;
  walkingEvidence: WalkingEvidence;
}

export interface LastMileGuidancePolicy {
  version?: string;
  landmarkContext?: string;
  analysisGate: typeof resolveExactModeGate;
  guidanceHeading(request: LastMetersRequestInput, receivedAt: number): number | undefined;
  initialSensorReasons: typeof sensorSafetyReasons;
  turnSensorReasons: typeof sensorSafetyReasons;
  turnReasons: typeof preciseTurnReasons;
  withheldMessage(reasons: string[], message: string, context: LastMileGuidanceContext): string;
  finalOutput(input: FinalGuidance): string;
}

/** Preserve the existing shared and retry policy exactly unless a mobile instance opts in. */
export const strictLastMileGuidancePolicy: LastMileGuidancePolicy = {
  analysisGate: resolveExactModeGate,
  /** Preserve the original capture heading for shared and retry executions. */
  guidanceHeading: request => request.deviceHeading,
  initialSensorReasons: sensorSafetyReasons,
  turnSensorReasons: sensorSafetyReasons,
  turnReasons: preciseTurnReasons,
  /** Keep the shared pipeline's original explanation. */
  withheldMessage: (_reasons, message) => message,
  /** Keep the shared pipeline's original final answer. */
  finalOutput: ({ turnInstruction, distanceSentence, landmarksGuidance, closedNotice, panoramaDate }) =>
    `${turnInstruction} ${distanceSentence} Landmarks: ${landmarksGuidance}` + closedNotice +
    " Entrance accessibility has not been verified. " + buildLastMileSourceNote(panoramaDate),
};

/** Require corroborated orientation, without treating optional map metadata as entrance evidence. */
function mobileTurnReasons(input: Parameters<typeof preciseTurnReasons>[0]): string[] {
  return preciseTurnReasons(input).filter(reason => {
    if (reason === "entrance_not_listed") return false;
    if (reason === "compass_not_high_accuracy" && input.compassAccuracy === 2) return false;
    if (reason === "confidence_not_high" && input.confidenceLevel === "medium") return false;
    // These results turn the user in place; they do not authorize walking along an unverified route.
    if (reason === input.walking.reason && !input.walking.verified) return false;
    return true;
  });
}

/** Preserve known destination facts when the evidence cannot support a current precise turn. */
function mobileWithheldMessage(
  reasons: string[],
  message: string,
  context: LastMileGuidanceContext,
): string {
  const name = context.destinationPlaceName;
  if (!name || reasons.includes("destination_branch_ambiguous")) return message;
  const address = context.destinationPlaceAddress ? ` at ${context.destinationPlaceAddress}` : "";
  const distance = Number.isFinite(context.destinationDistanceMeters)
    ? ` From where you took the photo, it is about ${formatLastMileDistance(context.destinationDistanceMeters!)} away in a straight line.`
    : "";
  let explanation = "I could not confirm a precise turn from this capture.";
  if (reasons.includes("turned_since_capture") || reasons.includes("moved_since_capture")) {
    explanation = "The phone's latest position or direction differs from the photo, so take a fresh photo before following a turn.";
  } else if (reasons.includes("gps_uncertain") || reasons.includes("bearing_uncertainty_too_large")) {
    explanation = "GPS is too uncertain to calculate a precise turn to the entrance from this spot.";
  } else if (reasons.includes("capture_metadata_missing")) {
    explanation = "This photo has no capture-time sensor readings, so I cannot calculate a current turn.";
  } else if (message !== RECAPTURE_MESSAGE) {
    explanation = message;
  }
  return `I found ${name}${address}.${distance} ${explanation}`;
}

/** Analyze mobile captures before deciding whether the result supports a turn or a descriptive answer. */
export const mobileLastMileGuidancePolicy: LastMileGuidancePolicy = {
  version: MOBILE_LAST_MILE_GUIDANCE_VERSION,
  landmarkContext: "\nThe phone may have turned after this photo was captured. " +
    "Describe landmarks as features shown in the photo. Do not give left/right or clock-face directions " +
    "relative to the user's current body from this earlier camera view.",
  /** GPS quality limits precise turns later; it must not skip nearby photo analysis altogether. */
  analysisGate: (distance, accuracy) => ({
    ...resolveExactModeGate(distance, accuracy), exact: distance <= LAST_METERS_EXACT_RADIUS_METERS,
  }),
  /** Use a genuine current true-north reading for the turn while retaining photo-time evidence. */
  guidanceHeading: (request, receivedAt) => {
    const sensors = request.sensors;
    return sensors && sensors.latestHeadingReference === "true" &&
      Number.isFinite(sensors.latestHeading) && sensors.latestHeading >= 0 && sensors.latestHeading < 360 &&
      Number.isFinite(sensors.latestHeadingTimestamp) && sensors.latestHeadingTimestamp <= receivedAt + 2000 &&
      receivedAt - sensors.latestHeadingTimestamp <= 15_000
      ? sensors.latestHeading : request.deviceHeading;
  },
  /** Sensor quality limits the final turn, rather than preventing photo and destination analysis. */
  initialSensorReasons: () => [],
  /** Judge the submitted snapshot at receipt; API processing time cannot age its sensors afterward. */
  turnSensorReasons: (sensors, position, heading, accuracy, now = Date.now(), snapshotTime = now) => {
    const reasons = mobileTurnSensorReasons(sensors, position, heading, accuracy, snapshotTime, snapshotTime);
    const currentHeadingValid = sensors?.latestHeadingReference === "true" &&
      !reasons.includes("current_heading_unavailable");
    // A rotation before submission is supported by rebasing the turn onto that real current reading.
    return currentHeadingValid ? reasons.filter(reason => reason !== "turned_since_capture") : reasons;
  },
  turnReasons: mobileTurnReasons,
  withheldMessage: mobileWithheldMessage,
  /** Keep landmarks and orientation while explicitly separating them from an unverified walking route. */
  finalOutput: input => {
    const output = strictLastMileGuidancePolicy.finalOutput(input);
    return input.walkingEvidence.verified
      ? output
      : `${input.turnInstruction} ${input.distanceSentence} Landmarks: ${input.landmarksGuidance}` +
        input.closedNotice + " Turn in place only; the distance is a straight-line estimate, not a verified walking path. " +
        "Entrance accessibility has not been verified. " + buildLastMileSourceNote(input.panoramaDate);
  },
};
