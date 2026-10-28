import axios from "axios";
import { calculateLastMetersConfidence, streetViewImageryAgeYears, type LastMetersConfidence } from "../utils/lastMetersNavigation";
import { evaluateWalkingLeg, type WalkingEvidence } from "../utils/lastMetersPolicy";
import type { LastMetersGuidancePolicy } from "../utils/lastMetersGuidancePolicy";
import type { LastMetersRequestInput } from "../utils/lastMetersReplay";
import { getGoogleMapsApiKey } from "./googleMaps";
import type { PanoramaHeadings } from "./lastMetersPanoramaMatching";
import type { GuidanceTarget, LastMetersTrial } from "./lastMetersTrial";

/** What the run says when the turn checks withhold the turn. */
export const TURN_NOT_VERIFIED_MESSAGE =
  "I cannot verify the entrance and your orientation well enough for a precise turn. Stay in a safe place and use your primary walking navigation or ask for assistance. Entrance accessibility has not been verified.";

/** What the turn decision needs to know about the user, the entrance, and the matched headings. */
export interface TurnDecisionInput {
  request: Pick<LastMetersRequestInput, "lat" | "lng" | "gpsAccuracyMeters" | "compassAccuracyLevel">;
  entrance: GuidanceTarget;
  headings: PanoramaHeadings;
  /** The heading the guidance policy turns the user from, when it has one instead of the compared heading. */
  guidanceHeading: number | undefined;
  turnReasons: LastMetersGuidancePolicy["turnReasons"];
  /** The guidance policy's sensor checks, judged once the walking route is known. */
  sensorReasons: () => string[];
}

/** Go ahead with a precise turn, or the reasons to withhold it. */
export type TurnDecision =
  | {
      kind: "go_ahead";
      /** The heading the turn is measured from. */
      turnHeading: number;
      confidence: LastMetersConfidence;
      walkingEvidence: WalkingEvidence;
    }
  | { kind: "withhold"; reasons: string[] };

/**
 * Scores the evidence, checks the walking route to the entrance, and applies
 * the guidance policy's turn checks to decide whether the run may give a
 * precise turn.
 */
export async function decideTurn(trial: LastMetersTrial, input: TurnDecisionInput): Promise<TurnDecision> {
  const { request, entrance, headings } = input;
  const { lat, lng, gpsAccuracyMeters, compassAccuracyLevel } = request;
  const { comparison, visualMatch, signTextMatched } = headings;
  const destinationReferenceUsed = headings.reference !== undefined;
  const panoramaMatched = comparison.panoramaMatchedHeading !== null;
  const confidence = calculateLastMetersConfidence({
    gpsAccuracyMeters,
    compassAccuracyLevel,
    panoramaCurrentViewMatched: panoramaMatched,
    compassPanoramaAgrees: comparison.agrees,
    destinationVisuallyMatched: visualMatch || signTextMatched,
    destinationReferenceVerified: destinationReferenceUsed,
    panoramaAgeYears: streetViewImageryAgeYears(headings.panorama.metadata.date),
  });
  trial.note({ confidence });
  trial.step({
    name: "confidence_fusion", prompt: "Score independent evidence before the turn safety gate; this is a heuristic, not a calibrated probability.",
    response: `${confidence.level.toUpperCase()}: ${Math.round(confidence.score * 100)}%`,
    model: "deterministic-confidence", success: confidence.level === "high",
    error: confidence.level !== "high" ? confidence.reasons.join(" ") : undefined,
  });
  const walkingEvidence = await checkWalkingRoute({ lat, lng }, entrance.location);
  trial.note({ walkingEvidence });
  const reasons = input.turnReasons({ confidenceLevel: confidence.level,
    photoMatched: panoramaMatched, headingAgrees: comparison.agrees,
    compassAccuracy: compassAccuracyLevel, gpsAccuracy: gpsAccuracyMeters, distanceMeters: entrance.distanceMeters,
    entranceListed: entrance.source === "geocoding_entrance",
    visualTargetMatched: visualMatch || signTextMatched || destinationReferenceUsed,
    walking: walkingEvidence, sensorReasons: input.sensorReasons() });
  if (reasons.length) return { kind: "withhold", reasons };
  // Visual bearings remain camera-origin evidence. Guidance uses phone-origin geometry.
  const turnHeading = input.guidanceHeading ?? headings.currentHeading;
  trial.note({ currentHeading: turnHeading });
  return { kind: "go_ahead", turnHeading, confidence, walkingEvidence };
}

async function checkWalkingRoute(origin: { lat: number; lng: number }, target: { lat: number; lng: number }): Promise<WalkingEvidence> {
  try {
    const route = await axios.get("https://maps.googleapis.com/maps/api/directions/json", {
      params: { mode: "walking", origin: `${origin.lat},${origin.lng}`, destination: `${target.lat},${target.lng}`, key: getGoogleMapsApiKey() }, timeout: 8000,
    });
    return route.data.status === "OK"
      ? evaluateWalkingLeg(route.data.routes?.[0]?.legs?.[0], origin, target)
      : { verified: false, reason: "walking_route_unavailable" };
  } catch {
    return { verified: false, reason: "walking_route_unavailable" };
  }
}
