import {
  isLastMetersHeadingAligned,
  lastMetersHeadingDifference,
  type ExactModeGate,
} from "../utils/lastMetersNavigation";
import type { LastMetersGuidancePolicy } from "../utils/lastMetersGuidancePolicy";
import type { LastMetersRequestInput } from "../utils/lastMetersReplay";
import { calculateHeading } from "./googleMaps";
import type { GuidanceTarget, HeadingAlignment, NavigationMode } from "./lastMetersTrial";

/** Where the user stood and which way the phone faced when the photo was taken. */
type PhonePosition = Pick<LastMetersRequestInput, "lat" | "lng" | "deviceHeading" | "gpsAccuracyMeters">;

/** What the proximity gate decided, and the compass and GPS evidence it used. */
export interface ProximityGate {
  mode: NavigationMode;
  headingAlignment: HeadingAlignment;
  gate: ExactModeGate;
}

/**
 * Decides whether a trial is close enough for exact panorama matching. Past
 * the exact radius, a phone already facing the destination is aligned and any
 * other is approach.
 */
export function resolveProximityGate(
  request: PhonePosition,
  entrance: Pick<GuidanceTarget, "location" | "distanceMeters">,
  analysisGate: LastMetersGuidancePolicy["analysisGate"],
): ProximityGate {
  const { lat, lng, deviceHeading, gpsAccuracyMeters } = request;
  const destinationBearing = calculateHeading({ lat, lng }, entrance.location);
  const headingAlignment: HeadingAlignment = typeof deviceHeading === "number"
    ? {
        destinationBearing,
        differenceDegrees: lastMetersHeadingDifference(deviceHeading, destinationBearing),
        aligned: isLastMetersHeadingAligned(deviceHeading, destinationBearing),
      }
    : { destinationBearing };
  const gate = analysisGate(entrance.distanceMeters, gpsAccuracyMeters);
  const mode = gate.exact ? "exact" : headingAlignment.aligned ? "aligned" : "approach";
  return { mode, headingAlignment, gate };
}
