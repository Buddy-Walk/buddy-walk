import axios from "axios";
import {
  buildClosedNowNotice,
  buildLastMetersSourceNote,
  LAST_METERS_EXACT_RADIUS_METERS,
} from "../utils/lastMetersNavigation";
import type { LastMetersRequestInput } from "../utils/lastMetersReplay";
import {
  isBesideBuilding,
  parseBuildingGeometry,
  selectNearestEntrance,
  usesBuildingEntrances,
  type BuildingGeometry,
} from "../utils/buildingEntrances";
import { getGoogleMapsApiKey } from "./googleMaps";
import {
  DestinationNotVerifiedError,
  getVerifiedNearbyDestination,
  type VerifiedNearbyDestination,
} from "./verifiedDestination";
import type { GuidanceTarget, LastMetersTrial, StepResult } from "./lastMetersTrial";

/** Where the user stood when the photo was taken. */
type UserPosition = Pick<LastMetersRequestInput, "lat" | "lng" | "gpsAccuracyMeters">;

/** The prompt logged with every proximity_gate step. */
export function proximityGatePrompt(destinationQuery: string): string {
  return (
    `Resolve "${destinationQuery}" near the user's coordinates and use exact ` +
    `panorama matching only within ${LAST_METERS_EXACT_RADIUS_METERS} meters ` +
    "plus the phone's reported GPS error."
  );
}

/** Finds the Verified destination near the user, or ends the run when none is verified. */
export async function verifyDestination(
  trial: LastMetersTrial,
  request: UserPosition,
  destinationQuery: string,
): Promise<StepResult<VerifiedNearbyDestination>> {
  const { lat, lng, gpsAccuracyMeters } = request;
  let verifiedDestination: VerifiedNearbyDestination;
  try {
    verifiedDestination = await getVerifiedNearbyDestination(lat, lng, destinationQuery);
    trial.source("google_places");
    trial.note({ verifiedDestination });
    trial.step({
      name: "destination_candidates",
      prompt: "Rank relevant Google Places candidates by distance from the user.",
      response: verifiedDestination.candidateSummary,
      model: "google-places",
      success: true,
    });
  } catch (proximityError) {
    trial.note({ testScenario: "destination_unverified" });
    if (proximityError instanceof DestinationNotVerifiedError) {
      trial.note({ destinationNotVerified: proximityError });
      trial.source("google_places");
    }
    const message =
      proximityError instanceof Error
        ? proximityError.message
        : "Destination proximity lookup failed.";
    trial.step({
      name: "proximity_gate",
      prompt: proximityGatePrompt(destinationQuery),
      response: "DESTINATION_NOT_VERIFIED",
      model: "google-places",
      success: false,
      error: message,
    });
    const finalOutput =
      `I could not verify a nearby ${destinationQuery} from your current location. ` +
      "Try a more specific name or street address." +
      buildLastMetersSourceNote(null);
    return {
      kind: "exit",
      result: await trial.answer({ warning: "destination_not_verified" }, {
        finalOutput,
        success: false,
        error: "destination_not_verified",
      }),
    };
  }

  const ambiguity = (verifiedDestination.placeCandidates || []).filter(candidate => candidate.relevant &&
    candidate.placeId !== verifiedDestination.placeId && candidate.businessStatus !== "CLOSED_PERMANENTLY" &&
    candidate.distanceMeters <= verifiedDestination.distanceMeters + Math.max(20, gpsAccuracyMeters ?? 20));
  if (ambiguity.length) {
    return {
      kind: "exit",
      result: await trial.withhold(["destination_branch_ambiguous"], `I found more than one nearby ${destinationQuery}. Please specify the street address: ${verifiedDestination.placeAddress} or ${ambiguity.slice(0, 2).map(c => c.address).join(" or ")}.`),
    };
  }
  return { kind: "ok", value: verifiedDestination };
}

/**
 * Building outline and entrance points from Geocoding. Optional data: any
 * failure means the trial falls back to the single Places pin.
 */
async function getBuildingGeometry(
  placeId: string,
): Promise<BuildingGeometry | null> {
  try {
    const response = await axios.get(
      "https://maps.googleapis.com/maps/api/geocode/json",
      {
        params: {
          place_id: placeId,
          extra_computations: "BUILDING_AND_ENTRANCES",
          key: getGoogleMapsApiKey(),
        },
        timeout: 8_000,
      },
    );
    if (response.data.status !== "OK" || !response.data.results?.[0]) {
      return null;
    }
    return parseBuildingGeometry(response.data.results[0]);
  } catch (error) {
    console.warn("[Last Meters] Building entrance lookup failed:", error);
    return null;
  }
}

/**
 * Where to aim for the Verified destination: its nearest listed building
 * entrance, or else its map pin, plus a notice when Google lists it as closed.
 */
export async function findEntrance(
  trial: LastMetersTrial,
  request: UserPosition,
  verifiedDestination: VerifiedNearbyDestination,
): Promise<{ entrance: GuidanceTarget; closedNotice: string }> {
  const { lat, lng, gpsAccuracyMeters } = request;
  let entrance: GuidanceTarget = {
    source: "places_pin",
    location: verifiedDestination.location,
    distanceMeters: verifiedDestination.distanceMeters,
  };
  const buildingGeometry = await getBuildingGeometry(
    verifiedDestination.placeId,
  );
  if (
    buildingGeometry &&
    usesBuildingEntrances(
      verifiedDestination.placeId,
      verifiedDestination.types,
      buildingGeometry,
    )
  ) {
    const besideBuilding = isBesideBuilding(
      { lat, lng },
      buildingGeometry.outlines,
      gpsAccuracyMeters,
    );
    const nearestEntrance = selectNearestEntrance(
      { lat, lng },
      buildingGeometry.entrances,
    );
    entrance = nearestEntrance
      ? {
          source: "geocoding_entrance",
          location: nearestEntrance.entrance.location,
          distanceMeters: nearestEntrance.distanceMeters,
          besideBuilding,
        }
      : { ...entrance, besideBuilding };
    trial.source("google_building_entrances");
    trial.step({
      name: "building_entrances",
      prompt:
        "Use the Google Geocoding building entrance nearest the user instead of the single map pin.",
      response:
        (nearestEntrance
          ? `NEAREST_ENTRANCE: ${Math.round(nearestEntrance.distanceMeters)} meters ` +
            `(${buildingGeometry.entrances.length} listed)`
          : "NO_ENTRANCES_LISTED") +
        (besideBuilding ? "; USER_BESIDE_BUILDING" : ""),
      model: "google-geocoding",
      success: nearestEntrance !== null,
    });
  }
  trial.note({ entrance });

  const closedNotice =
    verifiedDestination.businessStatus === "CLOSED_TEMPORARILY"
      ? buildClosedNowNotice(verifiedDestination.placeName, true)
      : verifiedDestination.openNow === false
        ? buildClosedNowNotice(verifiedDestination.placeName)
        : "";
  return { entrance, closedNotice };
}
