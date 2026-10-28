import type { textRequestBody } from "../types";
import { geocodeCoordinates } from "./googleMaps";
import type { QuestionRequest } from "./questionRequest";

/**
 * Where the user is, as the start of the system message's relevant data: the
 * street address, compass heading, and orientation. Each part is joined as it
 * is, so the separators are part of it.
 */
export async function describeLocation(content: textRequestBody, request: QuestionRequest): Promise<string> {
  let location = "";
  if (content.coords && !request.needsVerifiedNearbyAnswer && !request.visual) {
    const geocodedCoords = await geocodeCoordinates(content.coords.latitude, content.coords.longitude);
    location += `Current Address: ${geocodedCoords[0].formatted_address} `;
  }
  if (content.coords?.heading !== undefined) {
    location += `, Heading (Compass Direction): ${content.coords.heading}`;
  }
  if (content.coords?.orientation) {
    const { alpha, beta, gamma } = content.coords.orientation;
    location += `, Orientation - Alpha: ${alpha}, Beta: ${beta}, Gamma: ${gamma}`;
  }
  return location;
}
