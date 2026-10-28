import axios from "axios";
import {
  crossStreetsPrompt,
  entrancePrompt,
  imagePrompt,
  nearbyPlacesPrompt,
  openAITools,
  trainPrompt,
  videoPrompt,
} from "../types";
import { extractTrainLineFromText } from "../../src/utils/trainLine";
import { describeOpeningStatus, placeHoursFromDetails } from "../utils/openingHours";
import { getPanoramaData } from "./doorfront";
import { getNearbyFeatures } from "./features";
import { getGoogleMapsApiKey, getStreetViewWithHeading } from "./googleMaps";
import { getOpenAIClient } from "./openAIClient";
import { getSubwayArrivals } from "./mta";
import { isReply, verifiedWalkingDirections, type Evidence } from "./questionEvidence";
import type { QuestionReply, QuestionResult } from "./questionReply";
import type { QuestionRequest } from "./questionRequest";

/** A tool call as the routing call returns it, with its arguments still JSON. */
export interface ToolCall {
  name: string;
  arguments: string;
}

/** What a routed tool needs from the Question. */
export interface ToolContext {
  text: string;
  request: QuestionRequest;
  reply: QuestionReply;
}

interface RoutedTool {
  /** Added to the prompt even when the tool's lookup fails. */
  prompt?: string;
  lookup?: (args: any, context: ToolContext) => Promise<Evidence | QuestionResult>;
}

/** The routed tools that add data, by name. Any other tool only names itself in the log row. */
const ROUTED_TOOLS: Record<string, RoutedTool> = {
  generateGoogleAPILinkNonSpecificLocation: { lookup: placesLinkEvidence },
  generateGooglePlacesApiLinkSpecificLocation: { lookup: placesLinkEvidence },
  generateGoogleDistanceMatrixAPILink: { lookup: placesLinkEvidence },
  getCrossStreets: { lookup: crossStreetsEvidence },
  useDoorfrontAPI: { prompt: entrancePrompt, lookup: entranceEvidence },
  getNearbyFeatures: { lookup: nearbyFeaturesEvidence },
  generateTrainInformation: { prompt: trainPrompt, lookup: trainEvidence },
  generateGoogleDirectionAPILink: {
    lookup: ({ destination }: { destination?: unknown }, { request, reply }) =>
      verifiedWalkingDirections({
        lookup: "after routing",
        destination: String(destination || "").trim(),
        request,
        reply,
      }),
  },
  imageDescription: { prompt: imagePrompt },
  videoDescription: { prompt: videoPrompt },
};

/**
 * The tool-routing call: asks the model which tool, if any, fits the Question.
 * Returns undefined when the call fails.
 */
export async function routeQuestion(text: string, lat: number, lng: number) {
  try {
    const openAiResponse = await getOpenAIClient().chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "user", content: text },
        {
          role: "system",
          content: `decide the appropriate link to return from function options. If none fit the user query, return 'none'. The latitude is ${lat} and the longitude is ${lng}.  If no type is specified, leave this part out: &type=type.
            Use the chat history to find names of locations, types of locations that the user has asked about, the ratings of locations user has asked about, or the latitude and longitude of relevant locations.
            If no tool is appropriate, do not return any link. Use the image and video tool calls when the user wants description of an image or a video.`,
        },
      ],
      tools: openAITools,
      tool_choice: "auto",
    });
    console.log("token usage " + openAiResponse.usage?.total_tokens);
    return openAiResponse;
  } catch (e) {
    console.warn("parseUserRequest failed; continuing without tools:", e);
    return undefined;
  }
}

/**
 * Gives the model the data from the tool the routing call picks. A Question
 * the routing call picks no tool for, or whose tool fails, is answered without
 * tool data.
 */
export async function routedEvidence(context: ToolContext): Promise<Evidence | QuestionResult> {
  const { latitude, longitude } = context.request.coords;
  const routing = await routeQuestion(context.text, latitude, longitude);
  const toolCall = routing?.choices[0]?.message.tool_calls?.[0];
  if (!toolCall) {
    console.log("No tool calls found in OpenAI response");
    return {};
  }
  return toolEvidence(toolCall.function, context);
}

/**
 * Runs the routed tool `call` names. A tool that fails gives no data, but its
 * name is still logged.
 */
export async function toolEvidence(call: ToolCall, context: ToolContext): Promise<Evidence | QuestionResult> {
  const toolUsed = call.name;
  console.log("Calling routed tool:", toolUsed);
  let args: any;
  try {
    args = JSON.parse(call.arguments);
  } catch (error) {
    console.error("Routed tool arguments were not JSON:", error);
    return { toolUsed };
  }
  const tool = ROUTED_TOOLS[toolUsed];
  const kept: Evidence = tool?.prompt === undefined ? { toolUsed } : { prompt: tool.prompt, toolUsed };
  if (!tool?.lookup) return kept;
  try {
    const found = await tool.lookup(args, context);
    return isReply(found) ? found : { ...kept, ...found };
  } catch (error) {
    console.error("Error including api information in OpenAI request:", error);
    return kept;
  }
}

/** A static map of the user's corner, for the model to read the street names from. */
async function crossStreetsEvidence({ link }: { link?: string }): Promise<Evidence> {
  if (link === undefined) return {};
  return {
    prompt: crossStreetsPrompt,
    images: [{ type: "image_url", image_url: { url: link + `&key=${getGoogleMapsApiKey()}`, detail: "low" } }],
  };
}

interface EntranceLabel {
  label: string;
  subtype: number;
  box: { x: number; y: number; width: number; height: number };
}

/**
 * What Doorfront knows about the entrance at `address`: its panorama and labels
 * for the model to describe, or the description it already has. An address
 * Doorfront has no data for gets a Street View image instead.
 */
async function entranceEvidence({ address }: { address: string }, { request }: ToolContext): Promise<Evidence> {
  const { latitude, longitude } = request.coords;
  // The line break and spaces after location= have always been sent.
  const location: any = await axios.get(
    "https://maps.googleapis.com/maps/api/place/findplacefromtext/json?location=\n            " +
      `${latitude},${longitude}&fields=formatted_address%2Cname%2Cgeometry&inputtype=textquery` +
      `&input=${address.replace(/\s+/g, "%2C")}&key=${getGoogleMapsApiKey()}`,
  );
  const place = location.data.candidates[0];
  // Doorfront addresses have no ordinal suffixes.
  const panorama = await getPanoramaData(place.name.replace(/(\d+)(st|nd|rd|th)\b/gi, "$1"));
  if (!panorama) {
    console.error("No panorama data found for this address.");
    const streetViewURL = await getStreetViewWithHeading(place.formatted_address);
    const data =
      "Data on this address has not been collected yet by volunteers. Use the street view image to describe the " +
      "entrance features visible from street view. Let the user know this data is not validated by real users and " +
      "may not be correct.\n             When describing this image, provide a confidence level (1 to 5) for your " +
      "description of the entrance based on how clear the image is.";
    return {
      relevantData: `\n${data}`,
      data,
      ...(streetViewURL && { images: [{ type: "image_url", image_url: { url: streetViewURL, detail: "high" } }] }),
    };
  }
  if (panorama.url && panorama.image_description === undefined) {
    const data =
      `Entrance Information and Features for ${place.formatted_address}:` +
      panorama.human_labels[0].labels
        .map(
          ({ label, subtype, box }: EntranceLabel) =>
            `\n${label} (${subtype ? subtype : "exists"}), Bounding Box: x = ${box.x}, y = ${box.y}, width: ${box.width}, height: ${box.height}`,
        )
        .join("; ");
    return {
      relevantData: `\n${data}`,
      data,
      images: [{ type: "image_url", image_url: { url: panorama.url, detail: "high" } }],
      panoramaId: panorama._id.toString(),
    };
  }
  const data = `Image Description: ${panorama.image_description}`;
  return { relevantData: `\n${data}`, data };
}

/** How many trees, sidewalk materials, and pedestrian ramps are around the user. */
async function nearbyFeaturesEvidence(_args: unknown, { request }: ToolContext): Promise<Evidence> {
  const { latitude, longitude } = request.coords;
  const { trees, sidewalkMaterials, pedestrianRamps } = await getNearbyFeatures(latitude, longitude, 0.06);
  const data =
    `Nearby Features for location (${latitude}, ${longitude}):\n` +
    `Trees: ${trees.length}, Sidewalk Materials: ${sidewalkMaterials.length}, Pedestrian Ramps: ${pedestrianRamps.length}`;
  return { relevantData: `\n${data}`, data };
}

/** Live arrivals for the line the Question names, or else the line the routing call picked. */
async function trainEvidence({ routeId }: { routeId?: string }, { text, request }: ToolContext): Promise<Evidence> {
  const route = extractTrainLineFromText(text) ?? (routeId?.toUpperCase() || "A");
  console.log(`[MTA] AI requested data for the ${route} train.`);
  const trainData = await getSubwayArrivals(route, request.coords.latitude, request.coords.longitude);
  const data = `Live MTA Transit Information for line ${route}: ${trainData}`;
  return { relevantData: `\n${data}`, data };
}

/**
 * Fetches the Places link the routing call built and reads it by what Google
 * sends back: a list of nearby places, one place, or a walking distance.
 */
async function placesLinkEvidence({ link }: { link?: string }, { request }: ToolContext): Promise<Evidence> {
  if (link === undefined) return {};
  const { latitude, longitude } = request.coords;
  // A model-built Find Place link without a bias can resolve to a same-named
  // branch anywhere; keep it near the user.
  const biasedLink =
    /findplacefromtext/i.test(link) && !/locationbias=/i.test(link)
      ? `${link}&locationbias=circle:5000@${latitude},${longitude}`
      : link;
  const places: any = await axios.get(biasedLink + `&key=${getGoogleMapsApiKey()}`);
  if (places.data.results) return nearbyPlacesEvidence(places.data.results);
  if (places.data.candidates) return placeEvidence(places.data.candidates[0]);
  if (places.data.rows) return distanceEvidence(places.data.rows[0].elements[0]);
  return {};
}

interface NearbyPlace {
  name: string;
  geometry: { location: { lat: number; lng: number } };
  rating: number;
  vicinity: string;
  opening_hours?: { open_now?: boolean };
}

function nearbyPlacesEvidence(results: NearbyPlace[]): Evidence {
  const data = results
    .map(
      (place) =>
        `\n{name: ${place.name}, location(lat,lng): ${place.geometry.location.lat},${place.geometry.location.lng}, address: ${place.vicinity}, rating: ${place.rating} stars` +
        (place.opening_hours?.open_now === true
          ? ", Google Maps lists it as open now"
          : place.opening_hours?.open_now === false
            ? ", Google Maps lists it as closed now"
            : "") +
        "}",
    )
    .join(", ");
  return {
    prompt: nearbyPlacesPrompt,
    relevantData: `\nNearby Places in order of nearest distance: ${data}`,
    data,
  };
}

/**
 * One place, with whether it is open. Open or closed and the next change are
 * computed here; the model has misread weekday_text against the clock before.
 */
async function placeEvidence(candidate: { place_id?: string; name?: string } | undefined): Promise<Evidence> {
  let openingStatus: string | null = null;
  if (candidate?.place_id) {
    try {
      const placeInformation = await axios.get(
        "https://maps.googleapis.com/maps/api/place/details/json",
        {
          params: {
            place_id: candidate.place_id,
            fields: "name,business_status,opening_hours,current_opening_hours,utc_offset",
            key: getGoogleMapsApiKey(),
          },
          timeout: 20_000,
        },
      );
      openingStatus = describeOpeningStatus(
        placeHoursFromDetails(placeInformation.data.result, candidate.name ?? "This place"),
      );
    } catch (hoursError) {
      console.warn("Place hours lookup failed:", hoursError);
    }
  }
  return {
    prompt: nearbyPlacesPrompt,
    relevantData:
      `Relevant Place Information: ${JSON.stringify(candidate ?? null, null, 2)}\n` +
      (openingStatus
        ? "Opening status computed from Google Maps hours. Repeat it as written and " +
          `do not recalculate open or closed yourself: ${openingStatus}\n`
        : "Operating Hours: Not available\n"),
  };
}

function distanceEvidence({ distance, duration }: { distance: { value: number }; duration: { text: string } }): Evidence {
  return {
    relevantData: `Distance in miles: ${distance.value * 0.00062137}, How long it will take to walk: ${duration.text}`,
    data: `distance: ${distance.value}, duration: ${duration.text}`,
  };
}
