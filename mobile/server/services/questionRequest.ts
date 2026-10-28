import type { textRequestBody } from "../types";
import { extractNearbyPlaceQuery, looksLikeBareDestinationQuery } from "../utils/nearbyPlaces";

/** Locations reported less accurately than this are not trusted for nearby directions. */
const MAX_TRUSTED_ACCURACY_METERS = 1000;

/** What a Question's request decides before any outside call. */
export interface QuestionRequest {
  /** Whether the request's location can be trusted for nearby directions. */
  location: "trusted" | "inaccurate" | "missing";
  /** Where the data sources search from: the request's location, or 0,0 when it has none. */
  coords: { latitude: number; longitude: number };
  /** The place the Question asks to find or reach nearby, when one can be read from it. */
  nearbyQuery: string | null;
  /** Directions Questions and nearby-place Questions are answered only from a Verified destination. */
  needsVerifiedNearbyAnswer: boolean;
  /** Attached frames that are not empty. */
  frameCount: number;
  /** Set for a photo or video Question with frames attached, which is answered from the frames alone. */
  visual: "photo" | "video" | null;
}

/** Reads a Question's request. Makes no outside calls. */
export function readQuestionRequest(content: textRequestBody): QuestionRequest {
  const feature = content.analytics?.feature;
  const frameCount = Array.isArray(content.image) ? content.image.filter((frame) => frame).length : 0;
  const isDirections = feature === "directions";
  const nearbyQuery = extractNearbyPlaceQuery(
    content.text,
    isDirections || looksLikeBareDestinationQuery(content.text),
  );
  return {
    location: locationTrust(content.coords),
    coords: content.coords
      ? { latitude: content.coords.latitude, longitude: content.coords.longitude }
      : { latitude: 0, longitude: 0 },
    nearbyQuery,
    needsVerifiedNearbyAnswer: isDirections || nearbyQuery !== null,
    frameCount,
    visual:
      frameCount === 0 ? null
      : feature === "photo_qa" ? "photo"
      : feature === "video_qa" ? "video"
      : null,
  };
}

function locationTrust(coords: textRequestBody["coords"]): QuestionRequest["location"] {
  if (!coords) return "missing";
  const { accuracy } = coords;
  return typeof accuracy !== "number" || accuracy <= MAX_TRUSTED_ACCURACY_METERS
    ? "trusted"
    : "inaccurate";
}
