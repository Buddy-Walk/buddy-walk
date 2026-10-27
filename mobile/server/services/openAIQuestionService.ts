import axios from "axios";
import {
  textRequestBody,
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
import { getOpenAIClient } from "./openAIClient";
import { getSubwayArrivals } from "./mta";
import { extractTrainLineFromText } from "../../src/utils/trainLine";
import { getNearbyFeatures } from "./features";
import {
  treeInterface,
  sidewalkMaterialInterface,
  pedestrianRampInterface,
} from "../database/models/features";
import {
  appendConversationHistory,
  formatHistoryForPrompt,
  getConversationHistory,
} from "../utils/conversationHistory";
import {
  extractNearbyPlaceQuery,
  isNearbyPlaceCandidateRelevant,
  looksLikeBareDestinationQuery,
  MAX_LOCAL_PLACE_DISTANCE_METERS,
  normalizeNearbyPlaceQuery,
  selectNearbyPlaceCandidate,
} from "../utils/nearbyPlaces";
import { describeOpeningStatus, placeHoursFromDetails } from "../utils/openingHours";
import {
  geocodeCoordinates,
  getGoogleMapsApiKey,
  getStreetViewWithHeading,
} from "./googleMaps";
import {
  getVerifiedNearbyWalkingDirections,
  type VerifiedWalkingDirections,
  type VerifiedWalkingRoute,
} from "./verifiedDestination";
dotenv.config();

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

/**
 * Answers a Question for /api/text, picks a tool for /api/parseRequest, and
 * reads text aloud for /api/audio.
 * Each public request method sends its answer through ctx.res; callers ignore the result.
 */
export class OpenAIQuestionService {
  /** Tool-routing call used by /api/text. Returns undefined on failure instead of ending the response. */
  async parseUserRequestInternal(
    text: string,
    lat: number,
    lng: number,
  ) {
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

    let systemContent = "";
    let completeAIPrompt = AIPrompt;
    let relevantData = "";
    let panoramaId = "";
    const userContent: [
      ChatCompletionContentPartText | ChatCompletionContentPartImage,
    ] = [{ type: "text", text: content.text }];
    if (
      Array.isArray(content.image) &&
      content.image.length > 0 &&
      content.image[0] !== null
    ) {
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
              systemContent += `\nNearby Places in order of nearest distance: ${relevantData}`;
            }
            //if its giving back a specific place link
            else if (places.data.candidates) {
              completeAIPrompt += nearbyPlacesPrompt;
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
            //if its giving back distance matrix link
            else if (places.data.rows) {
                relevantData =
                  "distance: " +
                  places.data.rows[0].elements[0].distance.value +
                  ", duration: " +
                  places.data.rows[0].elements[0].duration.text;
                systemContent += `Distance in miles: ${places.data.rows[0].elements[0].distance.value * 0.00062137}, How long it will take to walk: ${places.data.rows[0].elements[0].duration.text}`;
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
            const reqlink =
              `https://maps.googleapis.com/maps/api/place/findplacefromtext/json?location=
            ${content.coords.latitude},${content.coords.longitude}&fields=formatted_address%2Cname%2Cgeometry&inputtype=textquery&input=${address.replace(/\s+/g, "%2C")}` +
              `&key=${getGoogleMapsApiKey()}`;
            console.log(reqlink);
          const location: any = await axios.get(reqlink);
          // remove st, nd, rd, th from address for better matching
            const cleanAddress = location.data.candidates[0].name.replace(
              /(\d+)(st|nd|rd|th)\b/gi,
              "$1",
            );
          const panoramaData = await getPanoramaData(ctx, cleanAddress);
          if (panoramaData) {
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
              const streetViewURL = await getStreetViewWithHeading(
                location.data.candidates[0].formatted_address,
              );
            console.log("getting sv with proper heading... ", streetViewURL);
              if (streetViewURL)
                userContent.push({
                  type: "image_url",
                image_url: {
                  url: streetViewURL,
                    detail: "high",
                  },
              });
            relevantData = `Data on this address has not been collected yet by volunteers. Use the street view image to describe the entrance features visible from street view. Let the user know this data is not validated by real users and may not be correct.
             When describing this image, provide a confidence level (1 to 5) for your description of the entrance based on how clear the image is.`;
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
          // Define colors for each sidewalk material type
          const materialColors: Record<string, string> = {
            tactile: "yellow",
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
                console.log(
                  "getting sv with proper heading... ",
                  getStreetViewWithHeading(formattedAddress),
                );
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
    } catch (error) {
      console.error(
        "Error including api information in OpenAI request:",
        error,
      );
    }

    // openAI separate text request
    try {
      console.log("system prompt: ", systemContent);
      systemContent += `\nCurrent Date and Time (Eastern): ${new Date().toLocaleString("en-US", { timeZone: "America/New_York" })}`;
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
      const chatCompletion = await getOpenAIClient().chat.completions.create({
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
    try {
      const mp3 = await getOpenAIClient().audio.speech.create({
        model: "tts-1",
        voice: "echo",
        input: text,
      });
      const buffer = Buffer.from(await mp3.arrayBuffer());

      res.contentType("audio/mpeg");
      res.status(200).send(buffer);
    } catch (e) {
      console.error(e);
    }
  }
}
