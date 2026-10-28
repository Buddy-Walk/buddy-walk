import {
  buildLastMetersSourceNote,
  isLastMetersHeadingAligned,
  LAST_METERS_EXACT_RADIUS_METERS,
  lastMetersHeadingDifference,
  type ExactModeGate,
} from "../utils/lastMetersNavigation";
import type { LastMetersGuidancePolicy } from "../utils/lastMetersGuidancePolicy";
import type { LastMetersRequestInput } from "../utils/lastMetersReplay";
import { calculateHeading } from "./googleMaps";
import { proximityGatePrompt } from "./lastMetersDestination";
import { saveBackgroundPanorama, type processPanoramaTiles } from "./streetViewPanorama";
import type { GuidanceTarget, HeadingAlignment, LastMetersTrial, NavigationMode, StepResult } from "./lastMetersTrial";
import type { VerifiedNearbyDestination } from "./verifiedDestination";

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

/** What passing the proximity gate needs to log the gate and answer a far-away trial. */
export interface ProximityGateInput {
  request: PhonePosition;
  destinationQuery: string;
  place: VerifiedNearbyDestination;
  entrance: GuidanceTarget;
  closedNotice: string;
  /** The first panorama at the user's position, which an aligned or approach answer saves for review. */
  firstPanorama: ReturnType<typeof processPanoramaTiles>;
  analysisGate: LastMetersGuidancePolicy["analysisGate"];
}

/**
 * Resolves the proximity gate and logs it on the Trial. Lets an exact trial
 * through to panorama matching, or ends an aligned or approach trial with
 * the straight-line distance.
 */
export async function passProximityGate(
  trial: LastMetersTrial,
  input: ProximityGateInput,
): Promise<StepResult<ProximityGate>> {
  const { request: { deviceHeading }, place, entrance, closedNotice } = input;
  const distanceMeters = entrance.distanceMeters;
  const proximityPrompt = proximityGatePrompt(input.destinationQuery);
  const proximity = resolveProximityGate(input.request, entrance, input.analysisGate);
  const { mode, headingAlignment, gate } = proximity;
  const { destinationBearing, differenceDegrees, aligned } = headingAlignment;
  if (typeof deviceHeading === "number" && differenceDegrees !== undefined) {
    trial.step({
      name: "heading_alignment",
      prompt:
        "Compare the phone compass heading with the verified destination bearing.",
      response:
        `${aligned ? "ALIGNED" : "MISALIGNED"}: phone ` +
        `${deviceHeading.toFixed(1)} degrees, destination ` +
        `${destinationBearing.toFixed(1)} degrees, difference ` +
        `${differenceDegrees.toFixed(1)} degrees`,
      model: "deterministic-compass",
      success: true,
    });
  }

  trial.note({ headingAlignment });

  trial.source("phone_gps");
  if (typeof deviceHeading === "number") trial.source("phone_compass");

  trial.note({ gate });

  if (mode === "exact") {
    trial.note({ navigationMode: "exact" });
    trial.step({
      name: "proximity_gate",
      prompt: proximityPrompt,
      response:
        `EXACT: ${Math.round(distanceMeters)} meters` +
        (gate.widened
          ? ` (within ${LAST_METERS_EXACT_RADIUS_METERS} m after a ` +
            `${Math.round(gate.allowanceMeters)} m GPS allowance)`
          : ""),
      model: "google-places",
      success: true,
    });
    return { kind: "ok", value: proximity };
  }

  trial.note(mode === "aligned"
    ? { navigationMode: "aligned", testScenario: "heading_aligned" }
    : { navigationMode: "approach", testScenario: "test_b_approach" });
  trial.step({
    name: "proximity_gate",
    prompt: proximityPrompt,
    response: mode === "aligned"
      ? `APPROACH_ONLY: ${Math.round(distanceMeters)} meters`
      : `APPROACH_ONLY: ${Math.round(distanceMeters)} meters, ` +
        `${destinationBearing.toFixed(1)} degrees`,
    model: "google-places",
    success: true,
  });
  const finalOutput =
    `${place.placeName}, ${place.placeAddress}, is approximately ${Math.round(distanceMeters)} meters away in a straight line. A walking route has not been verified. Use your primary walking navigation before trying Last Meters closer to the destination.` +
    closedNotice +
    buildLastMetersSourceNote(null);
  const warning = mode === "aligned" ? "heading_already_aligned" : "destination_too_far";
  return {
    kind: "exit",
    result: await trial.answer({ warning }, { finalOutput, success: true },
      testLogId => saveBackgroundPanorama(testLogId, input.firstPanorama)),
  };
}
