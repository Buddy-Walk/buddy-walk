import axios from "axios";
import OpenAI from "openai";
import {
  textRequestBody,
  history,
  AIPrompt,
  AppContext,
  openAITools,
  nearbyPlacesPrompt,
  entrancePrompt,
  directionsPrompt,
  imagePrompt,
  videoPrompt,
  crossStreetsPrompt,
  trainPrompt,
} from "../types";
import dotenv from "dotenv";
import {
  ChatCompletionContentPartImage,
  ChatCompletionContentPartText,
} from "openai/resources";
import { addPanoramaDescription, getPanoramaData } from "./doorfront";
import { aiRequestLogService } from "./aiRequestLog";
import { lastMileTestLogService } from "./lastMileTestLog";
import { getSubwayArrivals } from "./mta";
import { extractTrainLineFromText } from "../../src/utils/trainLine";
import { getNearbyFeatures } from "./features";
import {
  treeInterface,
  sidewalkMaterialInterface,
  pedestrianRampInterface,
} from "../database/models/features";
import sharp from "sharp";
import {
  appendConversationHistory,
  formatHistoryForPrompt,
  getConversationHistory,
} from "../utils/conversationHistory";
import {
  buildAlignedHeadingInstruction,
  buildBesideBuildingInstruction,
  buildClosedNowNotice,
  buildCloseRangeNoTurnInstruction,
  buildLastMileApproachInstruction,
  buildLastMileDistanceSentence,
  buildLastMileSourceNote,
  buildLastMileTurnInstruction,
  calculateLastMileConfidence,
  formatLastMileDistance,
  isDestinationBearingReliable,
  isLastMileHeadingAligned,
  lastMileHeadingDifference,
  LAST_METERS_EXACT_RADIUS_METERS,
  resolveExactModeGate,
  snapLastMileHeading,
} from "../utils/lastMileNavigation";
import type { LastMileTestScenario } from "../utils/lastMileNavigation";
import {
  describeNearbyPlaceCandidates,
  extractNearbyPlaceQuery,
  isNearbyPlaceCandidateRelevant,
  looksLikeBareDestinationQuery,
  MAX_LOCAL_PLACE_DISTANCE_METERS,
  mergeNearbyPlaceCandidates,
  normalizeNearbyPlaceQuery,
  selectNearbyPlaceCandidate,
  selectNearbyPlaceCandidates,
  summarizePlaceCandidates,
} from "../utils/nearbyPlaces";
import type {
  NearbyPlaceCandidate,
  NearbyPlaceSelection,
  PlaceCandidateLog,
} from "../utils/nearbyPlaces";
import {
  isBesideBuilding,
  parseBuildingGeometry,
  selectNearestEntrance,
  usesBuildingEntrances,
} from "../utils/buildingEntrances";
import type { BuildingGeometry } from "../utils/buildingEntrances";
import { describeOpeningStatus, placeHoursFromDetails } from "../utils/openingHours";
import { parseLastMetersInput } from "../../src/utils/lastMetersInput";
dotenv.config();

function getGoogleMapsApiKey(): string {
  const apiKey =
    process.env.GOOGLE_MAPS_API_KEY?.trim() ||
    process.env.GOOGLE_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("Google Maps API key is not configured on the server.");
  }
  return apiKey;
}

async function geocodeCoordinates(latitude: number, longitude: number) {
  const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${latitude},${longitude}&key=${getGoogleMapsApiKey()}`;
  try {
    const response = await axios.get(url);
    //console.log('Google Geocoding API response:', response.data);
    return response.data.results;
  } catch (error) {
    console.error("Error fetching nearby places:", error);
    throw error;
  }
}

interface LatLng {
  lat: number;
  lng: number;
}

function calculateHeading(from: LatLng, to: LatLng): number {
  const toRad = (deg: number): number => (deg * Math.PI) / 180;
  const toDeg = (rad: number): number => (rad * 180) / Math.PI;

  const phi1 = toRad(from.lat);
  const phi2 = toRad(to.lat);
  const deltaLambda = toRad(to.lng - from.lng);

  const y = Math.sin(deltaLambda) * Math.cos(phi2);
  const x =
    Math.cos(phi1) * Math.sin(phi2) -
    Math.sin(phi1) * Math.cos(phi2) * Math.cos(deltaLambda);

  const theta = Math.atan2(y, x);
  const heading = toDeg(theta);

  // Normalize to 0-360
  return (heading + 360) % 360;
}

interface VerifiedNearbyDestination {
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
class DestinationNotVerifiedError extends Error {
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

async function getVerifiedNearbyDestination(
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

  // if the name or type matcher rejects the result because the user entered
  // an acronym, abbreviation, etc e.g. USPS, use google's best result
  // if (!nearbyPlace && candidates.length > 0) {
  //   const googleFallback = selectNearbyPlaceCandidate(
  //     [candidates[0]],
  //     { lat, lng },
  //     maxDistanceMeters,
  //   );

  //   if (googleFallback) {
  //     console.log(
  //       `[Last Meters] Google Places fallback: "${nearbyQuery}" -> "${googleFallback.name}" (${Math.round(
  //         googleFallback.distanceMeters,
  //       )} m)`,
  //     );

  //     nearbyPlace = googleFallback;
  //   }
  // }

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

interface VerifiedWalkingDirections {
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

interface VerifiedWalkingRoute {
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

async function getVerifiedNearbyWalkingDirections(
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

// --- 4. Main Logic ---

async function resizeDataUrlImage(
  dataUrl: string,
  maxWidth: number,
  quality: number,
): Promise<string> {
  try {
    const base64Data = dataUrl.replace(/^data:image\/\w+;base64,/, "");
    const outputBuffer = await sharp(Buffer.from(base64Data, "base64"))
      .rotate()
      .resize({ width: maxWidth, withoutEnlargement: true })
      .jpeg({ quality })
      .toBuffer();
    return `data:image/jpeg;base64,${outputBuffer.toString("base64")}`;
  } catch (error) {
    console.error(
      "[LastMileTestLog] failed to compress user photo for storage:",
      error,
    );
    return dataUrl;
  }
}

const tools = openAITools;

function maxTokensForFeature(feature?: string): number {
  switch (feature) {
    case "mta":
      return 100;
    case "location_qa":
      return 80;
    case "directions":
      return 280;
    case "photo_qa":
    case "video_qa":
      return 150;
    default:
      return 120;
  }
}

export class OpenAIService {
  private _client: OpenAI | null = null;

  private get client(): OpenAI {
    if (!this._client) {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        throw new Error("OPENAI_API_KEY is not configured on the server");
      }
      this._client = new OpenAI({ apiKey });
    }
    return this._client;
  }

  /** Tool-routing call used by /api/text. Returns undefined on failure instead of ending the response. */
  async parseUserRequestInternal(
    text: string,
    lat: number,
    lng: number,
  ) {
    try {
      const openAiResponse = await this.client.chat.completions.create({
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
        tools: tools,
        tool_choice: "auto",
      });
      console.log("token usage " + openAiResponse.usage?.total_tokens);
      return openAiResponse;
    } catch (e) {
      console.warn("parseUserRequest failed; continuing without tools:", e);
      return undefined;
    }
  }

  async parseUserRequest(
    ctx: AppContext,
    text: string,
    lat: number,
    lng: number,
  ) {
    const { res } = ctx;
    const openAiResponse = await this.parseUserRequestInternal(text, lat, lng);
    if (!openAiResponse) {
      res.status(500).json({ error: "Error processing your request" });
      return;
    }
    res.status(200).json(openAiResponse);
  }

  // --- LAST METERS NAVIGATION PIPELINE ---
  async lastMileRequest(
    ctx: AppContext,
    lat: number,
    lng: number,
    image: string,
    destination: string,
    deviceHeading?: number,
    gpsAccuracyMeters?: number,
    compassAccuracyLevel?: number,
  ) {
    const { res } = ctx;
    const startedAt = Date.now();
    let activeStage = "destination proximity check";
    let navigationMode: "approach" | "exact" | "aligned" | undefined;
    let testScenario: LastMileTestScenario | undefined;
    let destinationDistanceMeters: number | undefined;
    let destinationBearing: number | undefined;
    let headingDifferenceDegrees: number | undefined;
    let headingAligned: boolean | undefined;
    let compassHeading: number | undefined;
    let panoramaMatchedHeading: number | undefined;
    let headingComparisonDifference: number | undefined;
    let headingComparisonAgrees: boolean | undefined;
    let confidenceScore: number | undefined;
    let confidenceLevel: "high" | "medium" | "low" | undefined;
    let confidenceReasons: string[] | undefined;
    let currentHeading: number | undefined;
    let verifiedDestination: VerifiedNearbyDestination | undefined;
    let panoramaPhoto: string | undefined;
    let panoramaDate: string | undefined;
    let panoramaStatus: string | undefined;
    let panoramaHeadings: number[] = [];
    let destinationPhoto: string | undefined;
    let destinationPhotoDate: string | undefined;
    let destinationPhotoStatus: string | undefined;
    let destinationPlaceName: string | undefined;
    let destinationPlaceAddress: string | undefined;
    let destinationTypes: string[] = [];
    let destinationReferenceUsed = false;
    let destinationQuery = destination;
    let placeCandidates: PlaceCandidateLog[] | undefined;
    let placesSearches: string[] | undefined;
    let gpsAllowanceMeters: number | undefined;
    let exactGateWidened: boolean | undefined;
    let panoId: string | undefined;
    let panoramaCopyright: string | undefined;
    let panoramaAgeYears: number | undefined;
    let entranceSource: "places_pin" | "geocoding_entrance" | undefined;
    let entranceLocation: LatLng | undefined;
    let besideBuilding: boolean | undefined;
    let signText: string | undefined;
    let signTextMatched: boolean | undefined;
    const dataSources = new Set<string>();
    const testSteps: {
      name: string;
      prompt: string;
      response?: string;
      parsedHeading?: number;
      model: string;
      success: boolean;
      error?: string;
      tokenCount?: number;
    }[] = [];

    const trialContext = () => ({
      destination,
      destinationQuery,
      lat,
      lng,
      panoramaPhoto,
      panoramaDate,
      panoramaStatus,
      panoramaSource: panoramaPhoto ? ("pipeline" as const) : undefined,
      panoId,
      panoramaCopyright,
      panoramaAgeYears,
      panoramaHeadings,
      placeCandidates,
      placesSearches,
      gpsAllowanceMeters,
      exactGateWidened,
      entranceSource,
      entranceLat: entranceLocation?.lat,
      entranceLng: entranceLocation?.lng,
      besideBuilding,
      destinationOpenNow: verifiedDestination?.openNow,
      destinationBusinessStatus: verifiedDestination?.businessStatus,
      signText,
      signTextMatched,
      dataSources: [...dataSources],
      destinationPhoto,
      destinationPhotoDate,
      destinationPhotoStatus,
      destinationPlaceName,
      destinationPlaceAddress,
      destinationTypes,
      destinationDistanceMeters,
      gpsAccuracyMeters,
      compassAccuracyLevel,
      destinationBearing,
      deviceHeading,
      headingDifferenceDegrees,
      headingAligned,
      compassHeading,
      panoramaMatchedHeading,
      headingComparisonDifference,
      headingComparisonAgrees,
      confidenceScore,
      confidenceLevel,
      confidenceReasons,
      destinationReferenceUsed,
      navigationMode,
      testScenario,
      currentHeading,
      steps: testSteps,
      latencyMs: Date.now() - startedAt,
    });
    const recordTrial = async (outcome: {
      finalOutput?: string;
      success: boolean;
      error?: string;
      targetHeading?: number;
      turnInstruction?: string;
    }) =>
      lastMileTestLogService.record({
        ...trialContext(),
        userPhoto: await resizeDataUrlImage(image, 1024, 76),
        ...outcome,
      });

    console.log("\n==================================================");
    console.log("📥 [BACKEND] HIT RECEIVED ON /api/last-mile route!");
    console.log(`[BACKEND] Destination requested: "${destination}"`);
    console.log(`[BACKEND] Coordinates: lat=${lat}, lng=${lng}`);
    console.log(
      `[BACKEND] Image payload received (Base64 length): ${image?.length}`,
    );
    console.log("==================================================");

    const parsedInput = parseLastMetersInput(destination);
    if (parsedInput.kind === "question") {
      // Older app builds send questions here; answer them like the main
      // question box would instead of searching for a place named "When is...".
      testScenario = "question_routed";
      testSteps.push({
        name: "input_classification",
        prompt:
          "Decide whether the Last Meters input names a place or asks a question.",
        response: `QUESTION (${parsedInput.reason}): sent to the question answering flow`,
        model: "deterministic-parser",
        success: true,
      });
      await recordTrial({
        finalOutput: "Answered by the question answering flow.",
        success: true,
      });
      const asksAboutSurroundings =
        parsedInput.reason === "question" &&
        /\b(?:in front of me|around me|describe|what do you see|this)\b/i.test(
          destination,
        );
      return this.textRequest(ctx, {
        text: destination,
        image: asksAboutSurroundings && image ? [image] : undefined,
        coords: {
          latitude: lat,
          longitude: lng,
          accuracy: gpsAccuracyMeters ?? null,
          heading: deviceHeading ?? null,
        },
        analytics: {
          feature:
            parsedInput.reason === "transit"
              ? "mta"
              : asksAboutSurroundings
                ? "photo_qa"
                : undefined,
        },
      });
    }
    destinationQuery = parsedInput.destination;
    testSteps.push({
      name: "input_classification",
      prompt:
        "Decide whether the Last Meters input names a place or asks a question.",
      response:
        `DESTINATION: "${destinationQuery}"` +
        (parsedInput.strippedLeadIn ? " (question lead-in removed)" : ""),
      model: "deterministic-parser",
      success: true,
    });

    try {
      const proximityPrompt =
        `Resolve "${destinationQuery}" near the user's coordinates and use close-range ` +
        `compass guidance only within ${LAST_METERS_EXACT_RADIUS_METERS} meters ` +
        "plus the phone's reported GPS error.";
      try {
        verifiedDestination = await getVerifiedNearbyDestination(
          lat,
          lng,
          destinationQuery,
        );
        dataSources.add("google_places");
        destinationDistanceMeters = verifiedDestination.distanceMeters;
        destinationPlaceName = verifiedDestination.placeName;
        destinationPlaceAddress = verifiedDestination.placeAddress;
        destinationTypes = verifiedDestination.types;
        placeCandidates = verifiedDestination.placeCandidates;
        placesSearches = verifiedDestination.placesSearches;
        testSteps.push({
          name: "destination_candidates",
          prompt:
            "Rank relevant Google Places candidates by distance from the user.",
          response: verifiedDestination.candidateSummary,
          model: "google-places",
          success: true,
        });
      } catch (proximityError) {
        testScenario = "destination_unverified";
        if (proximityError instanceof DestinationNotVerifiedError) {
          placeCandidates = proximityError.placeCandidates;
          placesSearches = proximityError.placesSearches;
          dataSources.add("google_places");
        }
        const message =
          proximityError instanceof Error
            ? proximityError.message
            : "Destination proximity lookup failed.";
        testSteps.push({
          name: "proximity_gate",
          prompt: proximityPrompt,
          response: "DESTINATION_NOT_VERIFIED",
          model: "google-places",
          success: false,
          error: message,
        });
        const finalOutput =
          `I could not verify a nearby ${destinationQuery} from your current location. ` +
          "Try a more specific name or street address." +
          buildLastMileSourceNote(null);
        const testLogId = await recordTrial({
          finalOutput,
          success: false,
          error: "destination_not_verified",
        });
        res.status(200).json({
          output: finalOutput,
          testLogId,
          testScenario,
          warning: "destination_not_verified",
        });
        return;
      }

      let targetLocation: LatLng = verifiedDestination.location;
      entranceSource = "places_pin";
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
        besideBuilding = isBesideBuilding(
          { lat, lng },
          buildingGeometry.outlines,
          gpsAccuracyMeters,
        );
        const nearestEntrance = selectNearestEntrance(
          { lat, lng },
          buildingGeometry.entrances,
        );
        if (nearestEntrance) {
          targetLocation = nearestEntrance.entrance.location;
          entranceLocation = targetLocation;
          entranceSource = "geocoding_entrance";
          destinationDistanceMeters = nearestEntrance.distanceMeters;
        }
        dataSources.add("google_building_entrances");
        testSteps.push({
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

      const closedNotice =
        verifiedDestination.businessStatus === "CLOSED_TEMPORARILY"
          ? buildClosedNowNotice(verifiedDestination.placeName, true)
          : verifiedDestination.openNow === false
            ? buildClosedNowNotice(verifiedDestination.placeName)
            : "";

      destinationBearing = calculateHeading({ lat, lng }, targetLocation);
      if (typeof deviceHeading === "number") {
        headingDifferenceDegrees = lastMileHeadingDifference(
          deviceHeading,
          destinationBearing,
        );
        headingAligned = isLastMileHeadingAligned(
          deviceHeading,
          destinationBearing,
        );
        testSteps.push({
          name: "heading_alignment",
          prompt:
            "Compare the phone compass heading with the verified destination bearing.",
          response:
            `${headingAligned ? "ALIGNED" : "MISALIGNED"}: phone ` +
            `${deviceHeading.toFixed(1)} degrees, destination ` +
            `${destinationBearing.toFixed(1)} degrees, difference ` +
            `${headingDifferenceDegrees.toFixed(1)} degrees`,
          model: "deterministic-compass",
          success: true,
        });
      }

      dataSources.add("phone_gps");
      if (typeof deviceHeading === "number") dataSources.add("phone_compass");

      if (
        !verifiedDestination ||
        destinationDistanceMeters === undefined ||
        destinationBearing === undefined
      ) {
        throw new Error("Destination verification did not produce a location.");
      }

      // Constants so the fallback closure below keeps the narrowed types.
      const place = verifiedDestination;
      const distanceMeters = destinationDistanceMeters;
      const bearing = destinationBearing;
      const gate = resolveExactModeGate(distanceMeters, gpsAccuracyMeters);
      gpsAllowanceMeters = gate.allowanceMeters;
      exactGateWidened = gate.widened;

      if (headingAligned && !gate.exact) {
        navigationMode = "aligned";
        testScenario = "heading_aligned";
        testSteps.push({
          name: "proximity_gate",
          prompt: proximityPrompt,
          response: `APPROACH_ONLY: ${Math.round(distanceMeters)} meters`,
          model: "google-places",
          success: true,
        });
        const finalOutput =
          buildAlignedHeadingInstruction(
            place.placeName,
            distanceMeters,
            place.placeAddress,
          ) +
          closedNotice +
          buildLastMileSourceNote(null);
        const testLogId = await recordTrial({ finalOutput, success: true });
        res.status(200).json({
          output: finalOutput,
          testLogId,
          mode: navigationMode,
          testScenario,
          warning: "heading_already_aligned",
        });
        return;
      }

      if (!gate.exact) {
        navigationMode = "approach";
        testScenario = "test_b_approach";
        const finalOutput =
          buildLastMileApproachInstruction(
            place.placeName,
            distanceMeters,
            bearing,
            place.placeAddress,
          ) +
          closedNotice +
          buildLastMileSourceNote(null);
        testSteps.push({
          name: "proximity_gate",
          prompt: proximityPrompt,
          response:
            `APPROACH_ONLY: ${Math.round(distanceMeters)} meters, ` +
            `${bearing.toFixed(1)} degrees`,
          model: "google-places",
          success: true,
        });
        const testLogId = await recordTrial({ finalOutput, success: true });
        res.status(200).json({
          output: finalOutput,
          testLogId,
          mode: navigationMode,
          testScenario,
          warning: "destination_too_far",
        });
        return;
      }

      navigationMode = "exact";
      testSteps.push({
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

      if (typeof deviceHeading !== "number" || !Number.isFinite(deviceHeading)) {
        const finalOutput =
          "Your phone compass was unavailable or not calibrated, so I will not calculate a turn. " +
          "Stay where you are, move the phone in a slow figure eight to recalibrate the compass, then take a new photo.";
        const testLogId = await recordTrial({
          finalOutput,
          success: false,
          error: "compass_heading_unavailable",
        });
        res.status(200).json({
          output: finalOutput,
          testLogId,
          mode: navigationMode,
          testScenario,
          warning: "compass_heading_unavailable",
        });
        return;
      }

      compassHeading = snapLastMileHeading(deviceHeading);
      currentHeading = deviceHeading;
      testSteps.push({
        name: "compass_current_heading",
        prompt:
          "Record the phone compass heading. This is the only source used for turn direction.",
        response: `${compassHeading} DEG`,
        parsedHeading: compassHeading,
        model: "device-compass",
        success: true,
      });

      const bearingReliable = isDestinationBearingReliable(
        distanceMeters,
        gpsAccuracyMeters,
      );
      let targetHeading: number | undefined;
      let turnInstruction: string;
      if (!bearingReliable) {
        testScenario = "test_b_approach";
        turnInstruction = besideBuilding
          ? buildBesideBuildingInstruction(
              place.placeName,
              distanceMeters,
              bearing,
            )
          : buildCloseRangeNoTurnInstruction(place.placeName, distanceMeters);
      } else {
        testScenario = "test_a_visible";
        targetHeading = snapLastMileHeading(bearing);
        turnInstruction = buildLastMileTurnInstruction(deviceHeading, bearing);
      }

      const confidence = calculateLastMileConfidence({
        gpsAccuracyMeters,
        compassAccuracyLevel,
      });
      confidenceScore = confidence.score;
      confidenceLevel = confidence.level;
      confidenceReasons = confidence.reasons;
      testSteps.push({
        name: "confidence_fusion",
        prompt:
          "Combine GPS accuracy and compass calibration after Google Places verified the destination.",
        response: `${confidence.level.toUpperCase()}: ${Math.round(confidence.score * 100)}%`,
        model: "deterministic-confidence",
        success: confidence.level !== "low",
        error:
          confidence.level === "low" ? confidence.reasons.join(" ") : undefined,
      });

      const distanceSentence = bearingReliable
        ? buildLastMileDistanceSentence(
            place.placeName,
            distanceMeters,
            !turnInstruction.startsWith("No turn"),
          )
        : "";

      activeStage = "accessible guidance";
      console.log("   ➤ Generating landmarks from the user photo...");
      const step3Prompt = `You are an orientation assistant for a blind pedestrian.
The validated instruction is: "${turnInstruction}"
Describe at most two stable physical landmarks from the user's current photo that help while turning in place.
Only mention stable, cane-detectable or tactile features such as a wall edge, curb, doorway recess, railing, or steps.
Do not name, describe, or direct the user toward any business other than "${destinationPlaceName || destination}".
Never invent an object. Never say "look", "see", "watch", "keep an eye out", or promise that a path is clear.
Do not instruct the user to walk forward or cross a street. If no reliable landmark is visible, reply exactly: NO_RELIABLE_LANDMARKS.
Keep the response to two short sentences and do not repeat the turn instruction.`;
      const step3Response = await this.client.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: step3Prompt },
          {
            role: "user",
            content: [
              { type: "text", text: "--- USER'S CURRENT PHOTO ---" },
              { type: "image_url", image_url: { url: image, detail: "high" } },
            ],
          },
        ],
        temperature: 0.1,
        max_tokens: 100,
      });

      const step3Text = step3Response.choices[0].message.content?.trim() || "";
      const landmarksGuidance =
        !step3Text || /\bNO_RELIABLE_LANDMARKS\b/i.test(step3Text)
          ? "No reliable physical landmark was identified. Turn in place without moving forward, then confirm your orientation before continuing."
          : step3Text;
      testSteps.push({
        name: "accessible_guidance",
        prompt: step3Prompt,
        response: step3Text,
        model: "gpt-4o-mini",
        success: !!step3Text && !/\bNO_RELIABLE_LANDMARKS\b/i.test(step3Text),
        error:
          !step3Text || /\bNO_RELIABLE_LANDMARKS\b/i.test(step3Text)
            ? "No reliable physical landmark was identified."
            : undefined,
        tokenCount: step3Response.usage?.total_tokens,
      });

      console.log("\n💬 Last Meters output (Places + compass):");
      console.log(`- Compass heading: ${currentHeading}°.`);
      console.log(`- Map bearing: ${bearing.toFixed(1)}°.`);
      console.log(`- Guidance: ${turnInstruction} ${landmarksGuidance}`);
      console.log("=========================================\n");

      const confidenceNotice =
        confidence.level === "low"
          ? " Confidence is low. Stop safely after turning and take another photo to confirm before moving forward."
          : "";
      const finalOutput =
        `${turnInstruction} ${distanceSentence} Landmarks: ${landmarksGuidance}${confidenceNotice}` +
        closedNotice +
        buildLastMileSourceNote();
      const testLogId = await recordTrial({
        finalOutput,
        success: true,
        targetHeading,
        turnInstruction,
      });
      res.status(200).json({
        output: finalOutput,
        testLogId,
        mode: navigationMode,
        testScenario,
        currentHeading,
        targetHeading,
        confidenceLevel,
        confidenceScore,
      });
    } catch (error: any) {
      const upstreamStatus = error?.status ?? error?.response?.status;
      const failureReason =
        typeof upstreamStatus === "number"
          ? `upstream returned HTTP ${upstreamStatus}`
          : typeof error?.code === "string"
            ? error.code
            : "unexpected backend error";
      const clientError = `Last Meters failed during ${activeStage}: ${failureReason}.`;
      console.error("❌ Last Meters request failed:", {
        stage: activeStage,
        status: upstreamStatus,
        code: error?.code,
        message: error?.message,
      });
      await recordTrial({
        success: false,
        error: error?.message ?? "Last meters calculation failed.",
      });
      if (!res.headersSent) res.status(502).json({ error: clientError });
    }
  }

  async textRequest(ctx: AppContext, content: textRequestBody) {
    const { res } = ctx;
    const startedAt = Date.now();
    let toolUsed: string | undefined;
    const analytics = content.analytics;
    const requestHadCoords = !!content.coords;
    const requestAccuracy = content.coords?.accuracy;
    const requestHadReliableCoords =
      requestHadCoords &&
      (typeof requestAccuracy !== "number" ||
        requestAccuracy === 0 ||
        requestAccuracy <= 1000);
    const allowBareDestination =
      analytics?.feature === "directions" ||
      looksLikeBareDestinationQuery(content.text);
    const requestedNearbyQuery = extractNearbyPlaceQuery(
      content.text,
      allowBareDestination,
    );
    const requiresVerifiedNearbyAnswer =
      analytics?.feature === "directions" || requestedNearbyQuery !== null;
    let verifiedNearbyAnswer = false;
    let structuredRoute: VerifiedWalkingRoute | null = null;
    const imageCount = Array.isArray(content.image)
      ? content.image.filter((img) => img).length
      : 0;
    const isDirectVisualRequest =
      imageCount > 0 &&
      (analytics?.feature === "photo_qa" || analytics?.feature === "video_qa");

    const recordAiRequest = async (
      success: boolean,
      extra?: {
        outputLength?: number;
        tokenCount?: number;
        errorCode?: string;
      },
    ) => {
      await aiRequestLogService.record({
        requestId: analytics?.requestId,
        installId: analytics?.installId,
        sessionId: analytics?.sessionId,
        platform: analytics?.platform,
        appVersion: analytics?.appVersion,
        feature: analytics?.feature,
        toolUsed,
        inputLength: content.text?.length ?? 0,
        hasImage: imageCount > 0,
        imageCount,
        hasCoords: !!content.coords,
        success,
        errorCode: extra?.errorCode,
        latencyMs: Date.now() - startedAt,
        outputLength: extra?.outputLength,
        tokenCount: extra?.tokenCount,
      });
    };

    const respondWithUnverifiedNearbyLocation = async (
      destinationLabel: string,
    ) => {
      const safeOutput =
        `I could not verify a nearby ${destinationLabel} from your current location. ` +
        "Try a more specific name or street address.";
      const updatedHistory = appendConversationHistory(content.analytics, {
        input: content.text,
        output: safeOutput,
        data: "Nearby destination lookup failed; no unverified location was used.",
      });
      await recordAiRequest(false, {
        outputLength: safeOutput.length,
        errorCode: "nearby_destination_not_verified",
      });
      res
        .status(200)
        .json({ output: safeOutput, history: updatedHistory, route: null });
    };

    const respondWithVerifiedWalkingDirections = async (
      verified: VerifiedWalkingDirections,
    ) => {
      const output =
        `${verified.directionsText}\n` +
        `Destination: ${verified.placeName}, ${verified.placeAddress}.`;
      const updatedHistory = appendConversationHistory(content.analytics, {
        input: content.text,
        output,
        data: `Verified local route to ${verified.placeName}.`,
      });
      await recordAiRequest(true, { outputLength: output.length });
      res.status(200).json({
        output,
        history: updatedHistory,
        route: verified.route,
      });
    };

    if (requiresVerifiedNearbyAnswer && !requestHadReliableCoords) {
      const safeOutput = requestHadCoords
        ? "Your location is not accurate enough for nearby directions. Enable precise location and try again."
        : "I could not determine your current location, so I will not guess at nearby directions. Check location access and try again.";
      const updatedHistory = appendConversationHistory(content.analytics, {
        input: content.text,
        output: safeOutput,
        data: "Current location was unavailable; no place lookup was attempted.",
      });
      await recordAiRequest(false, {
        outputLength: safeOutput.length,
        errorCode: "current_location_unavailable",
      });
      res
        .status(200)
        .json({ output: safeOutput, history: updatedHistory, route: null });
      return;
    }

    // console.log("hello world!!!")
    let systemContent = "";
    let completeAIPrompt = AIPrompt;
    let relevantData = "";
    let panoramaId = "";
    const userContent: [
      ChatCompletionContentPartText | ChatCompletionContentPartImage,
    ] = [{ type: "text", text: content.text }];
    //updated userContent to take array of images instead of a singe string image
    if (
      Array.isArray(content.image) &&
      content.image.length > 0 &&
      content.image[0] !== null
    ) {
      // console.log(content)
      content.image.forEach((image) => {
        userContent.push({
          type: "image_url",
          image_url: {
            url: image,
            detail: "auto",
          },
        });
      });
    }
    // console.log(userContent)
    if (
      content.coords &&
      !requiresVerifiedNearbyAnswer &&
      !isDirectVisualRequest
    ) {
      const geocodedCoords = await geocodeCoordinates(
        content.coords.latitude,
        content.coords.longitude,
      );
      systemContent += `Current Address: ${geocodedCoords[0].formatted_address} `;
    }
    if (content.coords?.heading !== undefined) {
        systemContent += `, Heading (Compass Direction): ${content.coords.heading}`;
      }
    if (content.coords?.orientation) {
        systemContent += `, Orientation - Alpha: ${content.coords.orientation.alpha}, Beta: ${content.coords.orientation.beta}, Gamma: ${content.coords.orientation.gamma}`;
      }
    if (!content.coords) content.coords = { latitude: 0, longitude: 0 };

    if (requiresVerifiedNearbyAnswer) {
      const nearbyQuery = requestedNearbyQuery;
      if (!nearbyQuery) {
        await respondWithUnverifiedNearbyLocation("destination");
        return;
      }
      try {
        const verifiedDirections = await getVerifiedNearbyWalkingDirections(
          content.coords.latitude,
          content.coords.longitude,
          nearbyQuery,
        );
        toolUsed = "verifiedNearbyWalkingDirections";
        verifiedNearbyAnswer = true;
        structuredRoute = verifiedDirections.route;
        if (imageCount === 0) {
          await respondWithVerifiedWalkingDirections(verifiedDirections);
          return;
        }
        completeAIPrompt += directionsPrompt;
        relevantData = `Directions:\n${verifiedDirections.directionsText}`;
        systemContent +=
          `\nVerified nearby destination: ${verifiedDirections.placeName}, ` +
          `${verifiedDirections.placeAddress}, approximately ` +
          `${Math.round(verifiedDirections.distanceMeters)} meters away.\n` +
          relevantData;
      } catch (error) {
        console.error("Verified nearby directions lookup failed:", error);
        await respondWithUnverifiedNearbyLocation(nearbyQuery);
        return;
      }
    }

    try {
      if (verifiedNearbyAnswer) {
        console.log("Using deterministic nearby walking directions.");
      } else if (isDirectVisualRequest) {
        toolUsed =
          analytics?.feature === "video_qa"
            ? "videoDescription"
            : "imageDescription";
        completeAIPrompt +=
          analytics?.feature === "video_qa" ? videoPrompt : imagePrompt;
      } else {
        const parsedRequest = await this.parseUserRequestInternal(
          content.text,
          content.coords.latitude,
          content.coords.longitude,
        );
      // console.log("parsedRequest: ", parsedRequest)
        console.log(parsedRequest?.choices[0].message);
      //determine if chat gpt is returning an api link
        if (
          parsedRequest &&
          parsedRequest.choices.length > 0 &&
          parsedRequest.choices[0].message.tool_calls &&
          parsedRequest.choices[0].message.tool_calls!.length > 0
        ) {
          console.log(
            parsedRequest?.choices[0].message.tool_calls![0].function.name,
          );
          toolUsed =
            parsedRequest.choices[0].message.tool_calls![0].function.name;

          const parsedArgs = JSON.parse(
            parsedRequest.choices[0].message.tool_calls![0].function.arguments,
          );
        //get link
        const { link } = parsedArgs;
          console.log(
            "Calling Google Maps tool:",
            parsedRequest.choices[0].message.tool_calls![0].function.name,
          );
          if (
            toolUsed === "generateGoogleDirectionAPILink" &&
            !verifiedNearbyAnswer
          ) {
            const fallbackDestination = String(
              parsedArgs.destination || "",
            ).trim();
            if (!requestHadCoords || !fallbackDestination) {
              await respondWithUnverifiedNearbyLocation(
                fallbackDestination || "destination",
              );
              return;
            }
            try {
              const verifiedDirections =
                await getVerifiedNearbyWalkingDirections(
                  content.coords.latitude,
                  content.coords.longitude,
                  fallbackDestination,
                );
              verifiedNearbyAnswer = true;
              structuredRoute = verifiedDirections.route;
              if (imageCount === 0) {
                await respondWithVerifiedWalkingDirections(verifiedDirections);
                return;
              }
              completeAIPrompt += directionsPrompt;
              relevantData = `Directions:\n${verifiedDirections.directionsText}`;
              systemContent +=
                `\nVerified nearby destination: ${verifiedDirections.placeName}, ` +
                `${verifiedDirections.placeAddress}, approximately ` +
                `${Math.round(verifiedDirections.distanceMeters)} meters away.\n` +
                relevantData;
            } catch (error) {
              console.error(
                "Fallback verified directions lookup failed:",
                error,
              );
              await respondWithUnverifiedNearbyLocation(fallbackDestination);
              return;
            }
          }
        // console.log("parsedArgs", parsedArgs);  
          if (
            link !== undefined &&
            parsedRequest.choices[0].message.tool_calls![0].function.name !==
              "generateTrainInformation"
          ) {
          //use link
            if (
              parsedRequest.choices[0].message.tool_calls![0].function.name ===
              "getCrossStreets"
            ) {
            completeAIPrompt += crossStreetsPrompt;
              const completeLink = link + `&key=${getGoogleMapsApiKey()}`;
            userContent.push({
                type: "image_url",
              image_url: {
                url: completeLink,
                  detail: "low",
                },
            });
            // console.log(userContent);
            } else {
              // A model-built Find Place link without a bias can resolve to a
              // same-named branch anywhere; keep it near the user.
              const biasedLink =
                content.coords &&
                /findplacefromtext/i.test(link) &&
                !/locationbias=/i.test(link)
                  ? `${link}&locationbias=circle:5000@${content.coords.latitude},${content.coords.longitude}`
                  : link;
              const places: any = await axios.get(
                biasedLink + `&key=${getGoogleMapsApiKey()}`,
              );
            //if its giving back a nearby places link
            if (places.data.results) {
              completeAIPrompt += nearbyPlacesPrompt;
              // console.log(places.data.results)
                relevantData = places.data.results
                  .map(
                    (place: {
                      name: string;
                      geometry: { location: { lat: number; lng: number } };
                      rating: number;
                      vicinity: string;
                      opening_hours?: { open_now?: boolean };
                    }) =>
                      `\n{name: ${place.name}, location(lat,lng): ${place.geometry.location.lat},${place.geometry.location.lng}, address: ${place.vicinity}, rating: ${place.rating} stars` +
                      (place.opening_hours?.open_now === true
                        ? ", Google Maps lists it as open now"
                        : place.opening_hours?.open_now === false
                          ? ", Google Maps lists it as closed now"
                          : "") +
                      "}",
                  )
                  .join(", ");
              //console.log(relevantData)
              systemContent += `\nNearby Places in order of nearest distance: ${relevantData}`;
              //console.log(systemContent)
            }
            //if its giving back a specific place link
            else if (places.data.candidates) {
              completeAIPrompt += nearbyPlacesPrompt;
              //console.log(places.data.candidates[0])
              //relevantData = `name: ${places.data.candidates[0].name}, address: ${places.data.candidates[0].formatted_address}`
              //console.log(relevantData)
                const candidate = places.data.candidates[0];
                // Open/closed and the next change are computed here; the model
                // has misread weekday_text against the clock before.
                let openingStatus: string | null = null;
                if (candidate?.place_id) {
                  try {
                    const placeInformation = await axios.get(
                      "https://maps.googleapis.com/maps/api/place/details/json",
                      {
                        params: {
                          place_id: candidate.place_id,
                          fields:
                            "name,business_status,opening_hours,current_opening_hours,utc_offset",
                          key: getGoogleMapsApiKey(),
                        },
                        timeout: 20_000,
                      },
                    );
                    openingStatus = describeOpeningStatus(
                      placeHoursFromDetails(
                        placeInformation.data.result,
                        candidate.name ?? "This place",
                      ),
                    );
                  } catch (hoursError) {
                    console.warn("Place hours lookup failed:", hoursError);
                  }
                }
                systemContent += `Relevant Place Information: ${JSON.stringify(candidate ?? null, null, 2)}\n`;
                systemContent += openingStatus
                  ? "Opening status computed from Google Maps hours. Repeat it as written and " +
                    `do not recalculate open or closed yourself: ${openingStatus}\n`
                  : "Operating Hours: Not available\n";
            }
            //if its giving back directions link

            // else if (places.data.routes) {
            //   console.log(places.data.routes[0].legs[0])
            //   relevantData = "Directions:\n"
            //   for (let i = 0; i < places.data.routes[0].legs[0].steps.length; i++) {
            //     relevantData += `Step ${i + 1}) ${places.data.routes[0].legs[0].steps[i].html_instructions} \n`
            //   }
            //   systemContent += relevantData
            //   const routePoints: { lat: number, lng: number  }[] = [{lat:places.data.routes[0].legs[0].steps[0].start_location.lat, lng:places.data.routes[0].legs[0].steps[0].start_location.lng}]
            //   routePoints.push(...places.data.routes[0].legs[0].steps.map((step: { start_location: { lat: number, lng: number }, end_location: { lat: number, lng: number } }) => ({
            //     lat: step.end_location.lat, lng: step.end_location.lng
            //   })));
            //   let staticMapUrl = `https://maps.googleapis.com/maps/api/staticmap?&size=640x640&maptype=roadmap&path=color:0x0000ff|weight:5|`;
            //   staticMapUrl += routePoints.map(point => `${point.lat},${point.lng}`).join('|');
            //   staticMapUrl += `&key=${process.env.GOOGLE_API_KEY}`;
            //   console.log(staticMapUrl)
            // }

            //if its giving back distance matrix link
            else if (places.data.rows) {
                relevantData =
                  "distance: " +
                  places.data.rows[0].elements[0].distance.value +
                  ", duration: " +
                  places.data.rows[0].elements[0].duration.text;
                systemContent += `Distance in miles: ${places.data.rows[0].elements[0].distance.value * 0.00062137}, How long it will take to walk: ${places.data.rows[0].elements[0].duration.text}`;
              //console.log(systemContent)
            }
          }
        }
        //if its using doorfront api
          else if (
            parsedRequest.choices[0].message.tool_calls![0].function.name ===
            "useDoorfrontAPI"
          ) {
          //use doorfront api
          completeAIPrompt += entrancePrompt;
            const parsedArgs = JSON.parse(
              parsedRequest.choices[0].message.tool_calls![0].function
                .arguments,
            );
          //get link
          const { address } = parsedArgs;
          // console.log(address)
            const reqlink =
              `https://maps.googleapis.com/maps/api/place/findplacefromtext/json?location=
            ${content.coords.latitude},${content.coords.longitude}&fields=formatted_address%2Cname%2Cgeometry&inputtype=textquery&input=${address.replace(/\s+/g, "%2C")}` +
              `&key=${getGoogleMapsApiKey()}`;
            console.log(reqlink);
          const location: any = await axios.get(reqlink);
          // console.log(location)
          // console.log(geocodedCoords[0].formatted_address)
          // remove st, nd, rd, th from address for better matching
            const cleanAddress = location.data.candidates[0].name.replace(
              /(\d+)(st|nd|rd|th)\b/gi,
              "$1",
            );
          const panoramaData = await getPanoramaData(ctx, cleanAddress);
          if (panoramaData) {
            //console.log(panoramaData.human_labels[0].labels);
            console.log(panoramaData.image_description);
              if (
                panoramaData.url &&
                panoramaData.image_description === undefined
              ) {
              userContent.push({
                  type: "image_url",
                image_url: {
                  url: panoramaData.url,
                    detail: "high",
                  },
              });
              panoramaId = panoramaData._id.toString();
                relevantData = `Entrance Information and Features for ${location.data.candidates[0].formatted_address}:`;
                relevantData += panoramaData.human_labels[0].labels
                  .map(
                    (label: {
                      label: string;
                      subtype: number;
                      box: {
                        x: number;
                        y: number;
                        width: number;
                        height: number;
                      };
                    }) =>
                      `\n${label.label} (${label.subtype ? label.subtype : "exists"}), Bounding Box: x = ${label.box.x}, y = ${label.box.y}, width: ${label.box.width}, height: ${label.box.height}`,
                  )
                  .join("; ");
              console.log(relevantData);
            } else {
              relevantData += `Image Description: ${panoramaData.image_description}`;
            }
          } else {
              console.error("No panorama data found for this address.");
            relevantData = `Data on this address has not been collected yet by volunteers. Tell the user entrance details from doorfront.org are unavailable. Do not invent an entrance description from imagery.`;
          }
          systemContent += `\n${relevantData}`;
          } else if (
            parsedRequest.choices[0].message.tool_calls![0].function.name ===
            "getNearbyFeatures"
          ) {
            const parsedArgs = JSON.parse(
              parsedRequest.choices[0].message.tool_calls![0].function
                .arguments,
            );
          if (parsedArgs.address) {
            console.log(parsedArgs.address);
            }
            const features = await getNearbyFeatures(
              content.coords.latitude,
              content.coords.longitude,
              0.06,
            );
          // console.log(features);
          const trees: treeInterface[] = features.trees;
            const sidewalkMaterials: sidewalkMaterialInterface[] =
              features.sidewalkMaterials;
            const pedestrianRamps: pedestrianRampInterface[] =
              features.pedestrianRamps;
          relevantData = `Nearby Features for location (${content.coords.latitude}, ${content.coords.longitude}):\n`;
          relevantData += `Trees: ${trees.length}, Sidewalk Materials: ${sidewalkMaterials.length}, Pedestrian Ramps: ${pedestrianRamps.length}`;
          systemContent += `\n${relevantData}`;
          let staticMapUrl = `https://maps.googleapis.com/maps/api/staticmap?&zoom=18&size=640x640&maptype=roadmap`;
          // Add user location marker
          staticMapUrl += `&markers=color:blue%7Clabel:U%7C${content.coords.latitude},${content.coords.longitude}`;
            staticMapUrl += `&markers=color:green%7Clabel:T%7C${trees.map((tree) => `${tree.location.coordinates[1]},${tree.location.coordinates[0]}`).join("%7C")}`;
          // staticMapUrl += `&markers=color:yellow%7Clabel:S%7C${sidewalkMaterials.map(material => `${material.location.coordinates[1]},${material.location.coordinates[0]}`).join('%7C')}`;
          // Define colors for each sidewalk material type
          const materialColors: Record<string, string> = {
            tactile: "yellow",
            //concrete: "gray",
            manhole: "black",
            "cellar door": "brown",
            "subway grate": "orange",
              other: "white",
          };

          // Add a marker for each material type
          Object.entries(materialColors).forEach(([material, color]) => {
            const locations = sidewalkMaterials
                .filter((m) => m.material.toLowerCase() === material)
                .map(
                  (m) =>
                    `${m.location.coordinates[1]},${m.location.coordinates[0]}`,
                );
            if (locations.length > 0) {
                staticMapUrl += `&markers=color:${color}%7Clabel:S%7C${locations.join("%7C")}`;
              }
            });
            staticMapUrl += `&markers=color:purple%7Clabel:R%7C${pedestrianRamps
              .map(
                (ramp) =>
                  `${ramp.location.coordinates[1]},${ramp.location.coordinates[0]}`,
              )
              .join("%7C")}`;
          // Add the API key to the static map URL
            staticMapUrl += `&key=${getGoogleMapsApiKey()}`;

          console.log(staticMapUrl);
        }
        // Directions with static map, doorfront, and features
          else if (
            parsedRequest.choices[0].message.tool_calls![0].function.name ===
              "generateGoogleDirectionAPILink" &&
            !verifiedNearbyAnswer
          ) {
            try {
              completeAIPrompt += directionsPrompt;
              let formattedAddress = "";
              let nearbyPlaceId: string | undefined;
              console.log("Generating Google Direction API Link");
            console.log(parsedArgs);
            // step 1: if destination is a store name, get the formatted address
            let cleanAddress;
            if (!parsedArgs.address) {
                const nearbyQuery = normalizeNearbyPlaceQuery(
                  String(parsedArgs.destination || ""),
                );
                if (!nearbyQuery) {
                  throw new Error(
                    "Destination name was empty after normalization.",
                  );
                }
                const location = await axios.get(
                  "https://maps.googleapis.com/maps/api/place/nearbysearch/json",
                  {
                    params: {
                      location: `${content.coords.latitude},${content.coords.longitude}`,
                      rankby: "distance",
                      keyword: nearbyQuery,
                      key: getGoogleMapsApiKey(),
                    },
                    timeout: 20_000,
                  },
                );
                if (!["OK", "ZERO_RESULTS"].includes(location.data.status)) {
                  throw new Error(
                    `Nearby Places returned ${location.data.status}.`,
                  );
                }
                const nearbyPlace = selectNearbyPlaceCandidate(
                  (location.data.results ?? []).filter((candidate: any) =>
                    isNearbyPlaceCandidateRelevant(candidate, nearbyQuery),
                  ),
                  {
                    lat: content.coords.latitude,
                    lng: content.coords.longitude,
                  },
                );
                if (!nearbyPlace?.place_id) {
                  throw new Error(
                    `No nearby ${nearbyQuery} was found within ` +
                      `${MAX_LOCAL_PLACE_DISTANCE_METERS / 1_000} kilometers.`,
                  );
                }

                nearbyPlaceId = nearbyPlace.place_id;
                formattedAddress =
                  nearbyPlace.vicinity || nearbyPlace.name || nearbyQuery;
                cleanAddress = nearbyPlace.name?.replace(
                  /(\d+)(st|nd|rd|th)\b/gi,
                  "$1",
                );
                systemContent +=
                  `Resolved nearby destination: ${nearbyPlace.name || nearbyQuery}, ` +
                  `${formattedAddress}, approximately ${Math.round(nearbyPlace.distanceMeters)} meters away.\n`;
              } else {
                const location = await axios.get(
                  "https://maps.googleapis.com/maps/api/place/findplacefromtext/json",
                  {
                    params: {
                      fields: "formatted_address,name,place_id",
                      inputtype: "textquery",
                      input: parsedArgs.destination,
                      locationbias: `circle:50000@${content.coords.latitude},${content.coords.longitude}`,
                      key: getGoogleMapsApiKey(),
                    },
                    timeout: 20_000,
                  },
                );
                if (
                  location.data.status !== "OK" ||
                  !location.data.candidates?.[0]
                ) {
                  throw new Error(
                    `Address lookup returned ${location.data.status}.`,
                  );
                }
                formattedAddress =
                  location.data.candidates[0].formatted_address;
                cleanAddress = location.data.candidates[0].name.replace(
                  /(\d+)(st|nd|rd|th)\b/gi,
                  "$1",
                );
                nearbyPlaceId = location.data.candidates[0].place_id;
            }
            console.log(formattedAddress);

            // step 2: get doorfront data if it exists for the formatted address
            const panoramaData = await getPanoramaData(ctx, cleanAddress);
              let doorfrontData = "";
              let doorLocation:
                | { lat: number; lng: number }
                | undefined
                | string = undefined;
              if (
                panoramaData &&
                panoramaData.human_labels &&
                panoramaData.human_labels.length > 0
              ) {
                console.log(
                  "Panorama data found for address:",
                  formattedAddress,
                );
              // doorfrontData += panoramaData.human_labels[0].labels.map(
              //   (label: { label: string, subtype: string, box: { x: number, y: number, width: number, height: number } }) =>
              //     `\n${label.label} (${label.subtype ? label.subtype : 'exists'}), Bounding Box: x = ${label.box.x}, y = ${label.box.y}, width: ${label.box.width}, height: ${label.box.height}`
              // ).join('; ');
              for (const label of panoramaData.human_labels[0].labels) {
                  if (label.label === "door") {
                  doorLocation = `${label.exactCoordinates?.lat}, ${label.exactCoordinates?.lng}`;
                  break;
                }
              }
              if (doorLocation === undefined) {
                doorLocation = `${panoramaData.location.lat}, ${panoramaData.location.lng}`;
              }
            } else {
                console.log("No panorama data found for this address.");
            }
            // step 3: get route from starting location to destination (doorfront location if it exists)
            if (!doorLocation) {
                doorLocation = nearbyPlaceId
                  ? `place_id:${nearbyPlaceId}`
                  : formattedAddress;
              }
              const route = await axios.get(
                "https://maps.googleapis.com/maps/api/directions/json",
                {
                  params: {
                    mode: "walking",
                    origin: `${content.coords.latitude},${content.coords.longitude}`,
                    destination: doorLocation,
                    key: getGoogleMapsApiKey(),
                  },
                  timeout: 20_000,
                },
              );
              if (
                route.data.status !== "OK" ||
                !route.data.routes?.[0]?.legs?.[0]
              ) {
                throw new Error(`Directions returned ${route.data.status}.`);
              }
              relevantData = "Directions:\n";
              for (
                let i = 0;
                i < route.data.routes[0].legs[0].steps.length;
                i++
              ) {
                relevantData += `Step ${i + 1}) ${route.data.routes[0].legs[0].steps[i].html_instructions} for ${route.data.routes[0].legs[0].steps[i].distance.text} \n`;
              }
              systemContent += relevantData;
            // // step 4: Take each lat/lng from each point in route --> can just use encoded polyline
            // const polyline = route.data.routes[0].overview_polyline.points;
            // const routePoints: { lat: number, lng: number  }[] = [{lat:route.data.routes[0].legs[0].steps[0].start_location.lat, lng:route.data.routes[0].legs[0].steps[0].start_location.lng}]
            // routePoints.push(...route.data.routes[0].legs[0].steps.map((step: { start_location: { lat: number, lng: number }, end_location: { lat: number, lng: number } }) => ({
            //   lat: step.end_location.lat, lng: step.end_location.lng
            // })));
            // // step 5: For each point in route, get features in a certain radius around that point
            // const features = await Promise.all(routePoints.map(async (point) => {
            //   const nearbyFeatures = await getNearbyFeatures(point.lat, point.lng, 0.03);
            //   return nearbyFeatures;
            // }));
            // const mergedFeatures = {
            //   trees: features.flatMap(f => f.trees),
            //   sidewalkMaterials: features.flatMap(f => f.sidewalkMaterials),
            //   pedestrianRamps: features.flatMap(f => f.pedestrianRamps),
            // };
            // // console.log(features)
            // // step 6: Add the route line and all features to the static map along with starting and ending position
            // // let staticMapUrl = `https://maps.googleapis.com/maps/api/staticmap?&size=640x640&maptype=roadmap&path=color:0x0000ff|weight:7|enc:${polyline}`;
            // let staticMapUrl = `https://maps.googleapis.com/maps/api/staticmap?center=${routePoints[routePoints.length-1].lat},${routePoints[routePoints.length-1].lng}&zoom=19&size=640x640&maptype=roadmap&path=color:0x0000ff|weight:7|enc:${polyline}`;
            // const trees: treeInterface[] = mergedFeatures.trees;
            // const sidewalkMaterials: sidewalkMaterialInterface[] = mergedFeatures.sidewalkMaterials;
            // const pedestrianRamps: pedestrianRampInterface[] = mergedFeatures.pedestrianRamps;
            // staticMapUrl += `&markers=color:blue%7Clabel:U%7C${content.coords.latitude},${content.coords.longitude}`;
            // staticMapUrl += `&markers=color:red%7Clabel:D%7C${routePoints[routePoints.length-1].lat},${routePoints[routePoints.length-1].lng}`;
            // staticMapUrl += `&markers=color:green%7Clabel:T%7C${trees.map(tree => `${tree.location.coordinates[1]},${tree.location.coordinates[0]}`).join('%7C')}`;
            // systemContent += `Feature Locations: Trees: ${trees.map(tree => `(${tree.location.coordinates[1]},${tree.location.coordinates[0]})`).join(', ')} \n 
            // Sidewalk Materials: ${sidewalkMaterials.map(material => `${material.material} at (${material.location.coordinates[1]},${material.location.coordinates[0]})`).join(', ')} \n 
            // Pedestrian Ramps: ${pedestrianRamps.map(ramp => `(${ramp.location.coordinates[1]},${ramp.location.coordinates[0]})`).join(', ')}`;
            // // staticMapUrl += `&markers=color:yellow%7Clabel:S%7C${sidewalkMaterials.map(material => `${material.location.coordinates[1]},${material.location.coordinates[0]}`).join('%7C')}`;
            // // Define colors for each sidewalk material type
            // const materialColors: Record<string, string> = {
            //   // tactile: "yellow",
            //   //concrete: "gray",
            //   // manhole: "black",
            //   // "cellar door": "brown",
            //   "subway grate": "orange",
            //   // other: "white"
            // };

            // // Add a marker for each material type
            // Object.entries(materialColors).forEach(([material, color]) => {
            //   const locations = sidewalkMaterials
            //     .filter(m => m.material.toLowerCase() === material)
            //     .map(m => `${m.location.coordinates[1]},${m.location.coordinates[0]}`);
            //   if (locations.length > 0) {
            //     staticMapUrl += `&markers=color:${color}%7Clabel:S%7C${locations.join('%7C')}`;
            //   }
            // });
            // staticMapUrl += `&markers=color:red%7Clabel:R%7C${pedestrianRamps.map(
            //   ramp => `${ramp.location.coordinates[1]},${ramp.location.coordinates[0]}`).join('%7C')}`;
            // // Add the API key to the static map URL
            // staticMapUrl += `&key=${process.env.GOOGLE_API_KEY}`;
            // console.log(staticMapUrl);
            //   // step 7: give populated static map to gpt
            // userContent.push({
            //   type: 'image_url',
            //   image_url: {
            //     url: staticMapUrl,
            //     detail: 'high',
            //   }
            // });
            // const fullRouteData = {
            //   route: routePoints,
            //   features: mergedFeatures,
            //   doorfront: doorfrontData,
            // }
            // console.log(JSON.stringify(fullRouteData))
          } catch (error) {
              console.error("Nearby directions lookup failed:", error);
              const failedDestination = String(
                parsedArgs.destination || "that destination",
              );
              const safeOutput =
                `I could not verify a nearby ${failedDestination} from your current location. ` +
                "Try a more specific name or street address.";
              const updatedHistory = appendConversationHistory(
                content.analytics,
                {
                  input: content.text,
                  output: safeOutput,
                  data: "Nearby destination lookup failed; no unverified location was used.",
                },
              );
              await recordAiRequest(false, {
                outputLength: safeOutput.length,
                errorCode: "nearby_destination_not_verified",
              });
              res.status(200).json({
                output: safeOutput,
                history: updatedHistory,
                route: null,
              });
              return;
            }
          } else if (
            parsedRequest.choices[0].message.tool_calls![0].function.name ===
            "generateTrainInformation"
          ) {
          completeAIPrompt += trainPrompt;
            const parsedArgs = JSON.parse(
              parsedRequest.choices[0].message.tool_calls![0].function
                .arguments,
            );
          const extractedRoute = extractTrainLineFromText(content.text);
            const route =
              extractedRoute ?? (parsedArgs.routeId?.toUpperCase() || "A");
          console.log(`[MTA] AI requested data for the ${route} train.`);

          const trainData = await getSubwayArrivals(
            route,
            content.coords.latitude,
              content.coords.longitude,
          );

          relevantData = `Live MTA Transit Information for line ${route}: ${trainData}`;
          systemContent += `\n${relevantData}`;
          } else if (
            parsedRequest.choices[0].message.tool_calls![0].function.name ===
            "imageDescription"
          ) {
          completeAIPrompt += imagePrompt;
          } else if (
            parsedRequest.choices[0].message.tool_calls![0].function.name ===
            "videoDescription"
          ) {
          completeAIPrompt += videoPrompt;
        }
      } else console.log("No tool calls found in OpenAI response");
      }
      // const places = await fetchNearbyPlaces(content.coords.latitude, content.coords.longitude);
      // nearbyPlaces = places.map((place: { name: string }) => place.name).join(', ');
      // systemContent += ` Nearby Places: ${nearbyPlaces}`;
    } catch (error) {
      console.error(
        "Error including api information in OpenAI request:",
        error,
      );
    }

    // console.log(systemContent)
    // openAI separate text request
    try {
      //  console.log("user prompt: ", userContent)
      console.log("system prompt: ", systemContent);
      // console.log("openAI history: ", openAIHistory)
      systemContent += `\nCurrent Date and Time (Eastern): ${new Date().toLocaleString("en-US", { timeZone: "America/New_York" })}`;
      // console.log("prompt: ", completeAIPrompt)
      const priorHistory = getConversationHistory(analytics);
      const recentHistory = priorHistory.slice(-3);
      if (
        toolUsed === "generateGoogleDirectionAPILink" &&
        content.image &&
        content.image[0] !== null
      ) {
        completeAIPrompt +=
          "\n\nCRITICAL INSTRUCTION: The user attached an image/video of their surroundings for 'Last Meters' navigation. DO NOT just read the GPS directions. You MUST analyze the image and use it to guide the user exactly to the physical door or entrance relative to their current view.";
      }
      const combinedSystemMessage =
        completeAIPrompt +
        "\n\nRelevant data: " +
        systemContent +
        "\n\nChat history: " +
        formatHistoryForPrompt(recentHistory);
      const chatCompletion = await this.client.chat.completions.create({
        messages: [
          { role: "system", content: combinedSystemMessage },
          { role: "user", content: userContent },
        ],
        model: "gpt-4o-mini",
        temperature: 0.2,
        max_tokens: maxTokensForFeature(analytics?.feature),
      });
      console.log("OpenAI API response:", chatCompletion.usage?.total_tokens);
      const outputText = chatCompletion.choices[0].message.content as string;
      const updatedHistory = appendConversationHistory(analytics, {
        input: content.text,
        output: outputText,
        data: relevantData,
      });

      // 3. Only update if both conditions are met AND we have a valid ID
      if (panoramaId) {
          console.log("Generating new description for DF database...");
          
          // We pass the panorama _id and the AI's generated output
        await addPanoramaDescription(panoramaId, outputText);
      }
      await recordAiRequest(true, {
        outputLength: outputText?.length ?? 0,
        tokenCount: chatCompletion.usage?.total_tokens,
      });
      res.status(200).json({
        output: outputText,
        history: updatedHistory,
        route: structuredRoute,
      });
    } catch (e: any) {
      console.error("Error with OpenAI API request:", e);
      await recordAiRequest(false, { errorCode: "openai_error" });
      res
        .status(500)
        .json({ error: "Error processing your request: " + e.message });
    }
  }
  // ----------------------------------------------------------------------------------------------------------------
  //* OpenAI Audio API
  async audioRequest(ctx: AppContext, text: string) {
    const { res } = ctx;
    // const speechFile = path.resolve("./speech.mp3");
    //console.log(text)
    try {
      const mp3 = await this.client.audio.speech.create({
        model: "tts-1",
        voice: "echo",
        input: text,
      });
      const buffer = Buffer.from(await mp3.arrayBuffer());
      // await fs.promises.writeFile(speechFile, buffer);

      res.contentType("audio/mpeg");
      res.status(200).send(buffer);
    } catch (e) {
      console.error(e);
    }
  }
}
