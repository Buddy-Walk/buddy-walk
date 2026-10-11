import axios from "axios";
import { outdoorPanoramaRejection } from "../utils/outdoorPanorama";
import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold, Part, FunctionDeclaration, Tool } from "@google/generative-ai";
import { textRequestBody, history, AIPrompt, AppContext, openAITools, nearbyPlacesPrompt, entrancePrompt, directionsPrompt, imagePrompt, videoPrompt, crossStreetsPrompt } from "../types";
import {
  appendConversationHistory,
  formatHistoryForPrompt,
  getConversationHistory,
} from "../utils/conversationHistory";
import dotenv from "dotenv";
import GtfsRealtimeBindings from "gtfs-realtime-bindings";
import fetch from "node-fetch";
import { getPanoramaData } from "./doorfront";
import { getNearbyFeatures } from "./features";
import { treeInterface, sidewalkMaterialInterface, pedestrianRampInterface } from "../database/models/features";
import { describeOpeningStatus, placeHoursFromDetails } from "../utils/openingHours";

dotenv.config();

// --- Helper for Gemini Image Inputs ---
// Gemini requires images to be base64 encoded inline data, not just public URLs
async function urlToGenerativePart(url: string, mimeType: string = "image/jpeg"): Promise<Part> {
  const response = await fetch(url);
  const buffer = await response.arrayBuffer();
  return {
    inlineData: {
      data: Buffer.from(buffer).toString("base64"),
      mimeType
    },
  };
}

async function geocodeCoordinates(latitude: number, longitude: number) {
  const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${latitude},${longitude}&key=${process.env.GOOGLE_API_KEY}`;
  try {
    const response = await axios.get(url);
    //console.log('Google Geocoding API response:', response.data);
    return response.data.results;
  } catch (error) {
    console.error('Error fetching nearby places:', error);
    throw error;
  }
}


// streetview-heading.ts

// --- 1. Type Definitions ---

interface LatLng {
  lat: number;
  lng: number;
}

interface GeocodeResponse {
  status: string;
  results: {
    geometry: {
      location: LatLng;
    };
  }[];
}

interface StreetViewMetadataResponse {
  status: string;
  pano_id?: string;
  copyright?: string;
  location?: LatLng; // 'location' is the car's position
}


// --- 3. The Math Helper ---
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

// --- 4. Main Logic ---
async function getStreetViewWithHeading(address: string): Promise<string | null> {
  try {
    console.log(`\n1. Geocoding address: "${address}"...`);

    // Step A: Geocode Address (Find the House)
    const geoUrl = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(
      address
    )}&key=${process.env.GOOGLE_API_KEY}`;

    const geoRes = await fetch(geoUrl);
    const geoData = (await geoRes.json()) as GeocodeResponse;

    if (geoData.status !== 'OK' || !geoData.results.length) {
      throw new Error(`Geocoding failed: ${geoData.status}`);
    }

    const houseLoc: LatLng = geoData.results[0].geometry.location;
    console.log(`   House found at: ${houseLoc.lat}, ${houseLoc.lng}`);

    // Step B: Find Nearest Panorama (Find the Car)
    // The Metadata API returns the specific lat/lng where the car was standing
    const metaUrl = `https://maps.googleapis.com/maps/api/streetview/metadata?location=${houseLoc.lat},${houseLoc.lng}&source=outdoor&key=${process.env.GOOGLE_API_KEY}`;

    const metaRes = await fetch(metaUrl);
    const metaData = (await metaRes.json()) as StreetViewMetadataResponse;

    if (outdoorPanoramaRejection(metaData) || !metaData.location) {
      throw new Error(`No Street View found nearby: ${metaData.status}`);
    }

    const carLoc: LatLng = metaData.location;
    console.log(`   Car found at:   ${carLoc.lat}, ${carLoc.lng}`);

    // Step C: Calculate Heading
    const heading = calculateHeading(carLoc, houseLoc);
    console.log(`   Calculated Heading: ${heading.toFixed(2)}°`);

    // Step D: Construct Final URL
    const finalUrl = `https://maps.googleapis.com/maps/api/streetview?size=640x480&pano=${encodeURIComponent(metaData.pano_id!)}&heading=${heading.toFixed(2)}&fov=80&pitch=0&source=outdoor&return_error_code=true&key=${process.env.GOOGLE_API_KEY}`;

    console.log(`\n✅ Street View image URL constructed for: ${address}`);
    return finalUrl;

  } catch (error) {
    if (error instanceof Error) {
      console.error('Error:', error.message);
    } else {
      console.error('An unknown error occurred');
    }
    return null;
  }
}



async function getTrainInfo(url: string) {
  try {
    const response = await fetch("https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-ace"
      //   , {
      //   headers: {
      //     "x-api-key": "<redacted>",
      //     // replace with your GTFS-realtime source's auth token
      //     // e.g. x-api-key is the header value used for NY's MTA GTFS APIs
      //   },
      // }
    );
    if (!response.ok) {
      throw new Error(`${response.url}: ${response.status} ${response.statusText}`);
    }
    const buffer = await response.arrayBuffer();
    const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(
      new Uint8Array(buffer)
    );
    feed.entity.forEach((_entity) => {
      // reserved for future entity processing
    });
  }
  catch (error) {
    console.error(error);
  }
}

// Convert OpenAI tool definitions to Gemini FunctionDeclarations
// Assuming openAITools follows standard OpenAI tool schema { type: 'function', function: { ... } }
const geminiTools: Tool[] = [
  {
    functionDeclarations: openAITools.map((tool: any) => {
      // If the tool object has a 'function' property (OpenAI style), use that.
      // Otherwise assume it might already be the function definition.
      return tool.function ? tool.function : tool;
    })
  }
];

export class GeminiService {
  genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY || "");
  model = this.genAI.getGenerativeModel({
    model: "gemini-2.5-flash", // or "gemini-1.5-pro"
  });

  async parseUserRequest(ctx: AppContext, text: string, lat: number, lng: number) {
    const { res } = ctx
    try {
      const systemInstruction = `decide the appropriate link to return from function options. If none fit the user query, return 'none'. The latitude is ${lat} and the longitude is ${lng}.  If no type is specified, leave this part out: &type=type.
            Use the chat history to find names of locations, types of locations that the user has asked about, the ratings of locations user has asked about, or the latitude and longitude of relevant locations.
            If no tool is appropriate, do not return any link. Use the image and video tool calls when the user wants description of an image or a video.`;

      const result = await this.model.generateContent({
        contents: [{ role: "user", parts: [{ text: systemInstruction + "\n\nUser Query: " + text }] }],
        tools: geminiTools,
      });

      const response = result.response;
      console.log("token usage (metadata not always avail in gemini node sdk same way): ", response.usageMetadata?.totalTokenCount);

      return response;

    } catch (e) {
      console.log(e)
      res.status(500).json({ error: 'Error processing your request' });
    }
  }

  async textRequest(ctx: AppContext, content: textRequestBody) {
    const { res } = ctx;

    let systemContent = '';
    let completeAIPrompt = AIPrompt
    let relevantData = '';

    // Build User Content for Gemini (Text + Images)
    const userParts: Part[] = [{ text: content.text }];

    // Handle Images: Convert URLs to Base64 Parts for Gemini
    if (Array.isArray(content.image) && content.image.length > 0 && content.image[0] !== null) {
      for (const imageUrl of content.image) {
        if (imageUrl) {
            try {
                const imagePart = await urlToGenerativePart(imageUrl);
                userParts.push(imagePart);
            } catch (err) {
                console.error("Failed to fetch image for Gemini:", imageUrl, err);
            }
        }
      }
    }

    if (content.coords) {
      const geocodedCoords = await geocodeCoordinates(content.coords.latitude, content.coords.longitude)
      systemContent += `Current Address: ${geocodedCoords[0].formatted_address} `;

      if (content.coords.heading !== undefined) {
        systemContent += `, Heading (Compass Direction): ${content.coords.heading}`;
      }

      if (content.coords.orientation) {
        systemContent += `, Orientation - Alpha: ${content.coords.orientation.alpha}, Beta: ${content.coords.orientation.beta}, Gamma: ${content.coords.orientation.gamma}`;
      }
    }
    else content.coords = { latitude: 0, longitude: 0 }

    try {
      const geminiResponse = await this.parseUserRequest(ctx, content.text, content.coords.latitude, content.coords.longitude)

      // Determine if Gemini is returning a function call
      // Gemini structure: response.candidates[0].content.parts[0].functionCall
      const firstPart = geminiResponse?.candidates?.[0]?.content?.parts?.[0];
      const functionCall = firstPart?.functionCall;

      if (functionCall) {
        console.log("Tool call:", functionCall.name);
        // Gemini args are already an object, no need to JSON.parse usually, but depends on strict typing.
        // The SDK returns it as a plain object.
        const parsedArgs = functionCall.args as any;

        //get link (common arg in your tools)
        const { link } = parsedArgs;

        if (link) {
             console.log("Tool resolved API link:", link);
        }

        if (link !== undefined && functionCall.name !== "generateTrainInformation") {
          //use link
          if (functionCall.name === "getCrossStreets") {
            completeAIPrompt += crossStreetsPrompt;
            const completeLink = link + `&key=${process.env.GOOGLE_API_KEY}`;
            // Add image to user parts
            try {
                userParts.push(await urlToGenerativePart(completeLink));
            } catch (e) { console.error("Error fetching cross street image", e); }
          }

          else {
            const places: any = await axios.get(link + `&key=${process.env.GOOGLE_API_KEY}`);
            //if its giving back a nearby places link
            if (places.data.results) {
              completeAIPrompt += nearbyPlacesPrompt;
              relevantData = places.data.results.map(
                (place: { name: string, geometry: { location: { lat: number, lng: number } }, rating: number, vicinity: string }) =>
                  `\n{name: ${place.name}, location(lat,lng): ${place.geometry.location.lat},${place.geometry.location.lng}, address: ${place.vicinity}, rating: ${place.rating} stars}`).join(', ');
              systemContent += `\nNearby Places in order of nearest distance: ${relevantData}`;
            }
            //if its giving back a specific place link
            else if (places.data.candidates) {
              completeAIPrompt += nearbyPlacesPrompt;
              const candidate = places.data.candidates[0];
              let openingStatus: string | null = null;
              if (candidate?.place_id) {
                try {
                  const placeInformation = await axios.get("https://maps.googleapis.com/maps/api/place/details/json", {
                    params: {
                      place_id: candidate.place_id,
                      fields: "name,business_status,opening_hours,current_opening_hours,utc_offset",
                      key: process.env.GOOGLE_API_KEY,
                    },
                    timeout: 20_000,
                  });
                  openingStatus = describeOpeningStatus(
                    placeHoursFromDetails(placeInformation.data.result, candidate.name ?? "This place")
                  );
                } catch (hoursError) {
                  console.warn("Place hours lookup failed:", hoursError);
                }
              }
              systemContent += `Relevant Place Information: ${JSON.stringify(candidate ?? null, null, 2)}\n`;
              systemContent += openingStatus
                ? `Opening status computed from Google Maps hours. Repeat it as written and do not recalculate open or closed yourself: ${openingStatus}\n`
                : "Operating Hours: Not available\n";
            }

            //if its giving back distance matrix link
            else if (places.data.rows) {
              relevantData = "distance: " + places.data.rows[0].elements[0].distance.value + ", duration: " + places.data.rows[0].elements[0].duration.text
              systemContent += `Distance in miles: ${places.data.rows[0].elements[0].distance.value * 0.00062137}, How long it will take to walk: ${places.data.rows[0].elements[0].duration.text}`
            }
          }
        }
        //if its using doorfront api
        else if (functionCall.name === "useDoorfrontAPI") {
          //use doorfront api
          completeAIPrompt += entrancePrompt;
          const { address } = parsedArgs;

          const reqlink = `https://maps.googleapis.com/maps/api/place/findplacefromtext/json?location=
            ${content.coords.latitude},${content.coords.longitude}&fields=formatted_address%2Cname%2Cgeometry&inputtype=textquery&input=${address.replace(/\s+/g, '%2C')}` + `&key=${process.env.GOOGLE_API_KEY}`;
          console.log(reqlink)
          const location: any = await axios.get(reqlink);

          // remove st, nd, rd, th from address for better matching
          const cleanAddress = location.data.candidates[0].name.replace(/(\d+)(st|nd|rd|th)\b/gi, '$1');
          const panoramaData = await getPanoramaData(ctx, cleanAddress);

          if (panoramaData) {
            if (panoramaData.url) {
                try {
                    userParts.push(await urlToGenerativePart(panoramaData.url));
                } catch(e) { console.error("Error fetching panorama image", e); }
            }
            relevantData = `Entrance Information and Features for ${location.data.candidates[0].formatted_address}:`
            relevantData += panoramaData.human_labels[0].labels.map(
              (label: { label: string, subtype: number, box: { x: number, y: number, width: number, height: number } }) =>
                `\n${label.label} (${label.subtype ? label.subtype : 'exists'}), Bounding Box: x = ${label.box.x}, y = ${label.box.y}, width: ${label.box.width}, height: ${label.box.height}`
            ).join('; ');
            console.log(relevantData);
            systemContent += `\n${relevantData}`;
          } else {
            console.error('No panorama data found for this address.');
            const streetViewURL = await getStreetViewWithHeading(location.data.candidates[0].formatted_address);
            console.log("getting sv with proper heading... ", streetViewURL);
            if (streetViewURL) {
                try {
                    userParts.push(await urlToGenerativePart(streetViewURL));
                } catch(e) { console.error("Error fetching streetview image", e); }
            }
            relevantData = 'Data on this address has not been collected yet by volunteers. Use the street view image to describe the entrance features visible from street view. Let the user know this data is not validated by real users and may not be correct.';
          }
        }
        else if (functionCall.name === "getNearbyFeatures") {
          const { address } = parsedArgs;
          if (address) {
            console.log(address);
          }
          const features = await getNearbyFeatures(content.coords.latitude, content.coords.longitude, 0.06);

          const trees: treeInterface[] = features.trees;
          const sidewalkMaterials: sidewalkMaterialInterface[] = features.sidewalkMaterials;
          const pedestrianRamps: pedestrianRampInterface[] = features.pedestrianRamps;
          relevantData = `Nearby Features for location (${content.coords.latitude}, ${content.coords.longitude}):\n`;
          relevantData += `Trees: ${trees.length}, Sidewalk Materials: ${sidewalkMaterials.length}, Pedestrian Ramps: ${pedestrianRamps.length}`;
          systemContent += `\n${relevantData}`;

          let staticMapUrl = `https://maps.googleapis.com/maps/api/staticmap?&zoom=18&size=640x640&maptype=roadmap`;
          staticMapUrl += `&markers=color:blue%7Clabel:U%7C${content.coords.latitude},${content.coords.longitude}`;
          staticMapUrl += `&markers=color:green%7Clabel:T%7C${trees.map(tree => `${tree.location.coordinates[1]},${tree.location.coordinates[0]}`).join('%7C')}`;

          const materialColors: Record<string, string> = {
            tactile: "yellow",
            manhole: "black",
            "cellar door": "brown",
            "subway grate": "orange",
            other: "white"
          };

          Object.entries(materialColors).forEach(([material, color]) => {
            const locations = sidewalkMaterials
              .filter(m => m.material.toLowerCase() === material)
              .map(m => `${m.location.coordinates[1]},${m.location.coordinates[0]}`);
            if (locations.length > 0) {
              staticMapUrl += `&markers=color:${color}%7Clabel:S%7C${locations.join('%7C')}`;
            }
          });
          staticMapUrl += `&markers=color:purple%7Clabel:R%7C${pedestrianRamps.map(
            ramp => `${ramp.location.coordinates[1]},${ramp.location.coordinates[0]}`).join('%7C')}`;

          staticMapUrl += `&key=${process.env.GOOGLE_API_KEY}`;
          console.log(staticMapUrl);
        }
        // Directions with static map, doorfront, and features
        else if (functionCall.name === "generateGoogleDirectionAPILink") {
          try {
            completeAIPrompt += directionsPrompt
            let formattedAddress = '';
            console.log("Generating Google Direction API Link")
            console.log(parsedArgs);

            // step 1: if destination is a store name, get the formatted address
            let cleanAddress;
            if (!parsedArgs.address) {
              const reqlink = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${content.coords.latitude},${content.coords.longitude}&rankby=distance&keyword=${parsedArgs.destination.replace(/\s+/g, '%20')}&key=${process.env.GOOGLE_API_KEY}`;
              const location: any = await axios.get(reqlink);
              formattedAddress = location.data.results[0].vicinity;
            }
            else {
              const reqlink = `https://maps.googleapis.com/maps/api/place/findplacefromtext/json?location=
                ${content.coords.latitude},${content.coords.longitude}&fields=formatted_address%2Cname&inputtype=textquery&input=${parsedArgs.destination.replace(/\s+/g, '%2C')}` + `&key=${process.env.GOOGLE_API_KEY}`;
              const location: any = await axios.get(reqlink);
              formattedAddress = location.data.candidates[0].formatted_address;
              cleanAddress = location.data.candidates[0].name.replace(/(\d+)(st|nd|rd|th)\b/gi, '$1');
            }
            console.log(formattedAddress);


            // step 2: get doorfront data
            const panoramaData = await getPanoramaData(ctx, cleanAddress);
            let doorLocation: { lat: number, lng: number } | undefined | string = undefined;
            if (panoramaData && panoramaData.human_labels && panoramaData.human_labels.length > 0) {
              console.log("Panorama data found for address:", formattedAddress);
              for (const label of panoramaData.human_labels[0].labels) {
                if (label.label === 'door') {
                  doorLocation = `${label.exactCoordinates?.lat}, ${label.exactCoordinates?.lng}`;
                  break;
                }
              }
              if (doorLocation === undefined) {
                doorLocation = `${panoramaData.location.lat}, ${panoramaData.location.lng}`;
              }
            } else {
              console.log('No panorama data found for this address.');
              // Note: We don't necessarily need to fetch the image here if we are just doing logic, but if we wanted to display it we would push to userParts
            }
            // step 3: get route
            if (!doorLocation) {
              doorLocation = formattedAddress;
            }
            const route = await axios.get(`https://maps.googleapis.com/maps/api/directions/json?mode=walking&origin=${content.coords.latitude},${content.coords.longitude}&destination=${doorLocation}&key=${process.env.GOOGLE_API_KEY}`);
            relevantData = "Directions:\n"
            for (let i = 0; i < route.data.routes[0].legs[0].steps.length; i++) {
              relevantData += `Step ${i + 1}) ${route.data.routes[0].legs[0].steps[i].html_instructions} for ${route.data.routes[0].legs[0].steps[i].distance.text} \n`
            }
            systemContent += relevantData

          } catch (error) {
            systemContent += 'Sorry, I could not generate directions to that location. Please try another destination.'
          }
        }
        else if (functionCall.name === "imageDescription") {
          completeAIPrompt += imagePrompt;
        }
        else if (functionCall.name === "videoDescription") {
          completeAIPrompt += videoPrompt;
        }

      } else console.log("No tool calls found in Gemini response");

    } catch (error) {
      console.error('Error including api information in Gemini request:', error);
    }

    // Final Gemini Text Request
    try {
      systemContent += `\nCurrent Date and Time (Eastern): ${new Date().toLocaleString("en-US", { timeZone: "America/New_York" })}`;

      const priorHistory = getConversationHistory(content.analytics);
      const combinedSystemMessage = completeAIPrompt
        + "\n\nRelevant data: "
        + systemContent
        + "\n\nChat history: "
        + formatHistoryForPrompt(priorHistory);

      // We pass the System Instruction and then the User parts (Text + Images)
      const finalResult = await this.model.generateContent({
        systemInstruction: combinedSystemMessage,
        contents: [{ role: "user", parts: userParts }],
        // config: { temperature: 0.7, maxOutputTokens: 1000}
      });

      const responseText = finalResult.response.text();
      console.log('Gemini API response token count (approx):', finalResult.response.usageMetadata?.totalTokenCount);

      const updatedHistory = appendConversationHistory(content.analytics, {
        input: content.text,
        output: responseText,
        data: relevantData,
      });
      res.status(200).json({ output: responseText, history: updatedHistory });
    }
    catch (e: any) {
      console.error('Error with Gemini API request:', e);
      res.status(500).json({ error: 'Error processing your request: ' + e.message });
    }
  }

  // ----------------------------------------------------------------------------------------------------------------
  //* Audio API
  async audioRequest(ctx: AppContext, text: string) {
    const { res } = ctx;
    // Note: Gemini's Generative AI API (gemini-1.5-flash) does not currently have a direct text-to-MP3 endpoint
    // equivalent to OpenAI's 'audio/speech' in this SDK.
    // You should use the Google Cloud Text-to-Speech API for this functionality.

    console.warn("Audio request received, but Gemini Text-to-Speech requires Google Cloud TTS integration.");
    res.status(501).json({ error: "Text-to-Speech via Gemini SDK not directly supported. Use Google Cloud TTS." });
  }

}
