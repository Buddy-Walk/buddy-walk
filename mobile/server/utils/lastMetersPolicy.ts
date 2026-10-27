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

export function preciseTurnReasons(input: {
  confidenceLevel: string; photoMatched: boolean; headingAgrees: boolean | undefined;
  compassAccuracy?: number; gpsAccuracy?: number; distanceMeters: number;
  entranceListed: boolean; visualTargetMatched: boolean; walking: WalkingEvidence;
  sensorReasons: string[];
}): string[] {
  const reasons = [...input.sensorReasons];
  if (input.confidenceLevel !== "high") reasons.push("confidence_not_high");
  if (!input.photoMatched || input.headingAgrees !== true) reasons.push("orientation_not_corroborated");
  if (input.compassAccuracy !== 3) reasons.push("compass_not_high_accuracy");
  if (!input.visualTargetMatched) reasons.push("destination_not_visually_verified");
  if (!input.entranceListed) reasons.push("entrance_not_listed");
  if (!input.walking.verified) reasons.push(input.walking.reason);
  if (!Number.isFinite(input.gpsAccuracy) || input.gpsAccuracy! < 0 || input.gpsAccuracy! > 20 ||
    !Number.isFinite(input.distanceMeters) || input.distanceMeters <= 0 || input.gpsAccuracy! / input.distanceMeters > Math.sin(22.5 * Math.PI / 180)) reasons.push("bearing_uncertainty_too_large");
  return [...new Set(reasons)];
}
