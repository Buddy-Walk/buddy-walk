import axios from "axios";
import { LAST_METERS_EXACT_RADIUS_METERS } from "../utils/lastMileNavigation";
import {
  describeNearbyPlaceCandidates,
  isNearbyPlaceCandidateRelevant,
  MAX_LOCAL_PLACE_DISTANCE_METERS,
  mergeNearbyPlaceCandidates,
  normalizeNearbyPlaceQuery,
  selectNearbyPlaceCandidates,
  summarizePlaceCandidates,
} from "../utils/nearbyPlaces";
import type {
  NearbyPlaceCandidate,
  NearbyPlaceSelection,
  PlaceCandidateLog,
} from "../utils/nearbyPlaces";
import { getGoogleMapsApiKey, type LatLng } from "./googleMaps";

export interface VerifiedNearbyDestination {
  placeId: string;
  placeName: string;
  placeAddress: string;
  types: string[];
  location: LatLng;
  distanceMeters: number;
  /** Ranked relevant candidates and which searches ran, for the trial log. */
  candidateSummary: string;
  placeCandidates: PlaceCandidateLog[];
  placesSearches: string[];
  openNow?: boolean;
  businessStatus?: string;
}

/** Carries what Google returned so a failed lookup can still be diagnosed. */
export class DestinationNotVerifiedError extends Error {
  constructor(
    message: string,
    readonly placeCandidates: PlaceCandidateLog[],
    readonly placesSearches: string[],
  ) {
    super(message);
    this.name = "DestinationNotVerifiedError";
  }
}

function tagSearchSource(
  results: NearbyPlaceCandidate[] | undefined,
  source: string,
): NearbyPlaceCandidate[] {
  return (results ?? []).map((result) => ({
    ...result,
    searchSources: [source],
  }));
}

export async function getVerifiedNearbyDestination(
  lat: number,
  lng: number,
  destination: string,
  maxDistanceMeters = MAX_LOCAL_PLACE_DISTANCE_METERS,
): Promise<VerifiedNearbyDestination> {
  const nearbyQuery = normalizeNearbyPlaceQuery(destination);
  if (!nearbyQuery) {
    throw new DestinationNotVerifiedError(
      "Destination name was empty after normalization.",
      [],
      [],
    );
  }

  const locationResponse = await axios.get(
    "https://maps.googleapis.com/maps/api/place/nearbysearch/json",
    {
      params: {
        location: `${lat},${lng}`,
        rankby: "distance",
        keyword: nearbyQuery,
        key: getGoogleMapsApiKey(),
      },
      timeout: 20_000,
    },
  );
  if (!["OK", "ZERO_RESULTS"].includes(locationResponse.data.status)) {
    throw new Error(`Nearby Places returned ${locationResponse.data.status}.`);
  }

  let candidates = tagSearchSource(locationResponse.data.results, "nearby");
  const rankRelevant = (): NearbyPlaceSelection[] =>
    selectNearbyPlaceCandidates(
      candidates.filter((candidate) =>
        isNearbyPlaceCandidateRelevant(candidate, nearbyQuery),
      ),
      { lat, lng },
      maxDistanceMeters,
    );
  let ranked = rankRelevant();
  let nearbyPlace: NearbyPlaceSelection | undefined = ranked[0];
  const searchesUsed = ["nearby"];

  // Nearby Search can miss valid businesses when the user provides a full
  // store name or address, and its keyword match can skip a closer branch of
  // a chain. Text Search supplies a second local candidate set whenever the
  // best Nearby result would push the user out of exact mode; distance
  // filtering still prevents an out-of-state result.
  if (
    !nearbyPlace ||
    nearbyPlace.distanceMeters > LAST_METERS_EXACT_RADIUS_METERS
  ) {
    searchesUsed.push("text");
    try {
      const textResponse = await axios.get(
        "https://maps.googleapis.com/maps/api/place/textsearch/json",
        {
          params: {
            query: nearbyQuery,
            location: `${lat},${lng}`,
            radius: maxDistanceMeters,
            key: getGoogleMapsApiKey(),
          },
          timeout: 20_000,
        },
      );
      if (textResponse.data.status === "OK") {
        candidates = mergeNearbyPlaceCandidates(
          candidates,
          tagSearchSource(textResponse.data.results, "text"),
        );
      } else if (textResponse.data.status !== "ZERO_RESULTS") {
        console.warn(
          `[Last Meters] Text Search fallback unavailable: ${textResponse.data.status}`,
        );
      }
    } catch (error) {
      console.warn("[Last Meters] Text Search fallback request failed:", error);
    }
    ranked = rankRelevant();
    nearbyPlace = ranked[0];
  }
  const placeCandidates = summarizePlaceCandidates(
    candidates,
    { lat, lng },
    nearbyQuery,
  );
  const placeLocation = nearbyPlace?.geometry?.location;
  if (
    !nearbyPlace?.place_id ||
    typeof placeLocation?.lat !== "number" ||
    typeof placeLocation.lng !== "number"
  ) {
    throw new DestinationNotVerifiedError(
      `No verified ${nearbyQuery} was found within ${Math.round(maxDistanceMeters / 1_000)} kilometers.`,
      placeCandidates,
      searchesUsed,
    );
  }

  return {
    placeId: nearbyPlace.place_id,
    placeName: nearbyPlace.name || nearbyQuery,
    placeAddress:
      nearbyPlace.vicinity ||
      nearbyPlace.formatted_address ||
      nearbyPlace.name ||
      nearbyQuery,
    types: nearbyPlace.types ?? [],
    location: { lat: placeLocation.lat, lng: placeLocation.lng },
    distanceMeters: nearbyPlace.distanceMeters,
    candidateSummary:
      `Searches: ${searchesUsed.join(" + ")}; ${candidates.length} raw results\n` +
      describeNearbyPlaceCandidates(ranked),
    placeCandidates,
    placesSearches: searchesUsed,
    openNow: nearbyPlace.opening_hours?.open_now,
    businessStatus: nearbyPlace.business_status,
  };
}

export interface VerifiedWalkingDirections {
  placeName: string;
  placeAddress: string;
  distanceMeters: number;
  directionsText: string;
  route: VerifiedWalkingRoute;
}

interface VerifiedWalkingRouteStep {
  index: number;
  instruction: string;
  distance: { text: string; value: number };
  duration: { text: string; value: number };
  maneuver: string;
  startLocation: LatLng;
  endLocation: LatLng;
  travelMode?: string;
}

export interface VerifiedWalkingRoute {
  destination: { name?: string; address?: string } & LatLng;
  origin: LatLng;
  totalDistance: { text: string; value: number };
  totalDuration: { text: string; value: number };
  steps: VerifiedWalkingRouteStep[];
  polyline?: string;
  travelMode: string;
}

function plainGoogleInstruction(value: string): string {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim();
}

export async function getVerifiedNearbyWalkingDirections(
  lat: number,
  lng: number,
  destination: string,
): Promise<VerifiedWalkingDirections> {
  const nearbyPlace = await getVerifiedNearbyDestination(lat, lng, destination);

  const routeResponse = await axios.get(
    "https://maps.googleapis.com/maps/api/directions/json",
    {
      params: {
        mode: "walking",
        origin: `${lat},${lng}`,
        destination: `place_id:${nearbyPlace.placeId}`,
        key: getGoogleMapsApiKey(),
      },
      timeout: 20_000,
    },
  );
  const routeLeg = routeResponse.data.routes?.[0]?.legs?.[0];
  if (routeResponse.data.status !== "OK" || !routeLeg) {
    throw new Error(`Directions returned ${routeResponse.data.status}.`);
  }

  const routeDistanceMeters = Number(routeLeg.distance?.value ?? 0);
  if (
    !Number.isFinite(routeDistanceMeters) ||
    routeDistanceMeters <= 0 ||
    routeDistanceMeters > MAX_LOCAL_PLACE_DISTANCE_METERS
  ) {
    throw new Error(
      "Verified walking route is outside the local distance limit.",
    );
  }

  const routeSteps: VerifiedWalkingRouteStep[] = (routeLeg.steps ?? []).map(
    (step: any, index: number) => ({
      index,
      instruction: plainGoogleInstruction(step.html_instructions || ""),
      distance: step.distance,
      duration: step.duration,
      maneuver: step.maneuver || "",
      startLocation: step.start_location,
      endLocation: step.end_location,
      travelMode: step.travel_mode,
    }),
  );
  const directionsText = routeSteps
    .map(
      (step, index) =>
        `Step ${index + 1}) ${step.instruction} for ${step.distance.text}`,
    )
    .join("\n");

  return {
    placeName: nearbyPlace.placeName,
    placeAddress: nearbyPlace.placeAddress,
    distanceMeters: nearbyPlace.distanceMeters,
    directionsText,
    route: {
      destination: {
        name: nearbyPlace.placeName,
        address: nearbyPlace.placeAddress,
        lat: nearbyPlace.location.lat,
        lng: nearbyPlace.location.lng,
      },
      origin: { lat, lng },
      totalDistance: routeLeg.distance,
      totalDuration: routeLeg.duration,
      steps: routeSteps,
      polyline: routeResponse.data.routes[0].overview_polyline?.points,
      travelMode: "WALKING",
    },
  };
}
