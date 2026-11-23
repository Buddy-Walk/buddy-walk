import { angularDifference, bearingBetween, distanceBetween, validPoint } from "../../src/utils/lastMetersSafety";

export interface WalkingEvidence { verified: boolean; reason: string; firstBearing?: number; distanceMeters?: number }

export function evaluateWalkingLeg(leg: any, origin: { lat: number; lng: number }, target: { lat: number; lng: number }): WalkingEvidence {
  const failed = (reason: string): WalkingEvidence => ({ verified: false, reason });
  if (!leg || !validPoint(leg.start_location) || !validPoint(leg.end_location)) return failed("walking_route_unavailable");
  if (distanceBetween(origin, leg.start_location) > 25 || distanceBetween(target, leg.end_location) > 25) return failed("walking_route_endpoint_mismatch");
  if (!Number.isFinite(leg.distance?.value) || leg.distance.value <= 0) return failed("walking_route_invalid");
  const steps = leg.steps;
  if (!Array.isArray(steps) || !steps.length || steps.some(s => s.travel_mode !== "WALKING" || !validPoint(s.start_location) || !validPoint(s.end_location))) return failed("walking_route_invalid");
  // Do not convert a route around a corner/barrier into a direct turn toward a pin.
  const segment = steps.find(s => distanceBetween(s.start_location, s.end_location) >= 3);
  if (!segment) return failed("walking_route_too_short");
  const firstBearing = bearingBetween(segment.start_location, segment.end_location);
  if (angularDifference(firstBearing, bearingBetween(origin, target)) > 30 || leg.distance.value > distanceBetween(origin, target) * 1.5 + 10) return failed("walking_route_requires_detour");
  return { verified: true, reason: "walking_route_consistent_not_accessibility_verified", firstBearing, distanceMeters: leg.distance.value };
}

/**
 * Minimum independent evidence for orientation corroboration (#75).
 * Both rows are required. Duplicating the same panorama match does not count twice.
 */
export const ORIENTATION_CORROBORATION_DECISION_TABLE = [
  {
    source: "panorama_current_view_match",
    role: "independent_visual",
    required: true,
    passesWhen: "photoMatched === true",
  },
  {
    source: "compass_vs_panorama_heading",
    role: "independent_sensor_cross_check",
    required: true,
    passesWhen: "headingAgrees === true",
  },
] as const;

export type OrientationSourceStatus = "pass" | "unavailable" | "conflicting" | "mismatched" | "correlated_duplicate";

export interface OrientationCorroborationSourceReport {
  source: (typeof ORIENTATION_CORROBORATION_DECISION_TABLE)[number]["source"];
  role: (typeof ORIENTATION_CORROBORATION_DECISION_TABLE)[number]["role"];
  status: OrientationSourceStatus;
  required: true;
}

export interface OrientationCorroborationDiagnostics {
  reason: "orientation_not_corroborated" | null;
  decisionTableVersion: "1";
  sources: OrientationCorroborationSourceReport[];
  /** True only when every required independent source passes. */
  corroborated: boolean;
}

/**
 * Report whether independent visual + heading cross-check corroborate orientation.
 * Correlated duplicates (e.g. counting photo match as both signals) are rejected.
 */
export function orientationCorroborationDiagnostics(input: {
  photoMatched: boolean;
  headingAgrees: boolean | undefined;
  /** When true, caller attempted to reuse photo match as heading evidence — not independent. */
  headingDerivedFromPhotoMatchOnly?: boolean;
}): OrientationCorroborationDiagnostics {
  const photoStatus: OrientationSourceStatus = input.photoMatched ? "pass" : "mismatched";
  let headingStatus: OrientationSourceStatus;
  if (input.headingDerivedFromPhotoMatchOnly) {
    headingStatus = "correlated_duplicate";
  } else if (input.headingAgrees === true) {
    headingStatus = "pass";
  } else if (input.headingAgrees === false) {
    headingStatus = "conflicting";
  } else {
    headingStatus = "unavailable";
  }

  const sources: OrientationCorroborationSourceReport[] = [
    {
      source: "panorama_current_view_match",
      role: "independent_visual",
      status: photoStatus,
      required: true,
    },
    {
      source: "compass_vs_panorama_heading",
      role: "independent_sensor_cross_check",
      status: headingStatus,
      required: true,
    },
  ];
  const corroborated = sources.every(source => source.status === "pass");
  return {
    reason: corroborated ? null : "orientation_not_corroborated",
    decisionTableVersion: "1",
    sources,
    corroborated,
  };
}

export function preciseTurnReasons(input: {
  confidenceLevel: string; photoMatched: boolean; headingAgrees: boolean | undefined;
  compassAccuracy?: number; gpsAccuracy?: number; distanceMeters: number;
  entranceListed: boolean; visualTargetMatched: boolean; walking: WalkingEvidence;
  sensorReasons: string[];
  /** True when heading agreement was derived only from the photo match — not independent. */
  headingDerivedFromPhotoMatchOnly?: boolean;
}): string[] {
  const reasons = [...input.sensorReasons];
  if (input.confidenceLevel !== "high") reasons.push("confidence_not_high");
  if (orientationCorroborationDiagnostics({
    photoMatched: input.photoMatched,
    headingAgrees: input.headingAgrees,
    headingDerivedFromPhotoMatchOnly: input.headingDerivedFromPhotoMatchOnly,
  }).reason) {
    reasons.push("orientation_not_corroborated");
  }
  if (input.compassAccuracy !== 3) reasons.push("compass_not_high_accuracy");
  if (!input.visualTargetMatched) reasons.push("destination_not_visually_verified");
  if (!input.entranceListed) reasons.push("entrance_not_listed");
  if (!input.walking.verified) reasons.push(input.walking.reason);
  if (!Number.isFinite(input.gpsAccuracy) || input.gpsAccuracy! < 0 || input.gpsAccuracy! > 20 ||
    !Number.isFinite(input.distanceMeters) || input.distanceMeters <= 0 || input.gpsAccuracy! / input.distanceMeters > Math.sin(22.5 * Math.PI / 180)) reasons.push("bearing_uncertainty_too_large");
  return [...new Set(reasons)];
}
