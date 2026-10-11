import axios from "axios";
import OpenAI from "openai";
import { textRequestBody, history, AIPrompt, AppContext, openAITools, nearbyPlacesPrompt, entrancePrompt, directionsPrompt, imagePrompt, videoPrompt, crossStreetsPrompt } from "../types";
import dotenv from "dotenv";
import { ChatCompletionContentPartImage, ChatCompletionContentPartText } from "openai/resources";
import GtfsRealtimeBindings from "gtfs-realtime-bindings";
import fetch from "node-fetch";
import { addPanoramaDescription, getPanoramaData } from "./doorfront";
import { aiRequestLogService } from "./aiRequestLog";
import { getNearbyFeatures } from "./features";
import { treeInterface, sidewalkMaterialInterface, pedestrianRampInterface } from "../database/models/features";
import fs from "fs";
import path from "path";
import { json } from "stream/consumers";

dotenv.config();

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

function writeFile(data: any) {
  fs.writeFile('route.json', JSON.stringify(data), (err) => {
    if (err) {
      console.error('Error writing file:', err);
    } else {
      console.log('File written successfully');
    }
  });
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
      const error = new Error(`${response.url}: ${response.status} ${response.statusText}`);
      throw error;
      process.exit(1);
    }
    const buffer = await response.arrayBuffer();
    const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(
      new Uint8Array(buffer)
    );
    //console.log(feed.entity[0].tripUpdate)
    feed.entity.forEach((entity) => {
      // console.log(entity);  
      // if (entity.vehicle?.stopId) {
      //   console.log(entity.vehicle.stopId);
      // }
      // if(entity.tripUpdate?.trip) {
      //   // console.log(entity.tripUpdate.trip);
      //   if(entity.tripUpdate.trip.routeId === "A") {
      //     console.log(entity.tripUpdate.trip.routeId);
      //   }
      // }
    });
  }
  catch (error) {
    console.log(error);
    process.exit(1);
  }
}

const tools = openAITools

const openAIHistory: history[] = []

export class OpenAIService {
  client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });

  async parseUserRequest(ctx: AppContext, text: string, lat: number, lng: number) {
    //console.log(openAIHistory[openAIHistory.length - 1].data)
    const { res } = ctx
    //try function?
    try {
      const openAiResponse = await this.client.chat.completions.create({
        model: "gpt-4.1-mini",
        messages: [
          { role: "user", content: text },
          {
            role: "system",
            content: `decide the appropriate link to return from function options. If none fit the user query, return 'none'. The latitude is ${lat} and the longitude is ${lng}.  If no type is specified, leave this part out: &type=type.
            Use the chat history to find names of locations, types of locations that the user has asked about, the ratings of locations user has asked about, or the latitude and longitude of relevant locations.
            If no tool is appropriate, do not return any link. Use the image and video tool calls when the user wants description of an image or a video.`
          },
        ],
        tools: tools,
        tool_choice: "auto"
      });
      // console.log(openAIHistory)
      console.log("token usage " + openAiResponse.usage?.total_tokens)
      return openAiResponse
      // res.status(200).json(openAiResponse);
    } catch (e) {
      console.log(e)
      res.status(500).json({ error: 'Error processing your request' });
    }
  }

  // --- LAST METERS NAVIGATION PIPELINE ---
  async lastMileRequest(ctx: AppContext, lat: number, lng: number, image: string, destination: string) {
    const { res } = ctx;

    console.log("\n==================================================");
    console.log("📥 [BACKEND] HIT RECEIVED ON /api/last-mile route!");
    console.log(`[BACKEND] Destination requested: "${destination}"`);
    console.log(`[BACKEND] Coordinates: lat=${lat}, lng=${lng}`);
    console.log(`[BACKEND] Image payload received (Base64 length): ${image?.length}`);
    console.log("==================================================");

    try {
      const debugPhotoPath = path.resolve(__dirname, "../../debug-user-photo.jpg");
      const base64Data = image.replace(/^data:image\/\w+;base64,/, "");
      fs.writeFileSync(debugPhotoPath, base64Data, 'base64');
      console.log(`📸 User photo saved to: ${debugPhotoPath}`);
    } catch (err) {
      console.error("Error saving debug photo:", err);
    }

    try {
      console.log(`\n🤖 Last Meters landmarks from the user photo for: [${destination}]...`);
      const step3Response = await this.client.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: `You are an orientation assistant for the blind.
          Look at the user's current photo and describe physical, tactile landmarks near "${destination}".
          Rule 1: Double-check Left vs Right in the photo.
          Rule 2: Mention physical objects like trash cans, steps, or building corners. Do NOT mention elevated text signs.
          Rule 3: Keep it conversational but concise.
          Do not invent entrance details that are not visible in the photo.` },
          { role: "user", content: [{ type: "image_url", image_url: { url: image } }] }
        ],
        temperature: 0.1
      });

      const landmarksGuidance = step3Response.choices[0].message.content;
      res.status(200).json({ output: landmarksGuidance });

    } catch (error: any) {
      console.error("❌ OpenAI Request failed:", error.message);
      res.status(500).json({ error: "Last meters calculation failed." });
    }
  }

  async textRequest(ctx: AppContext, content: textRequestBody) {
    const { res } = ctx;
    const startedAt = Date.now();
    let toolUsed: string | undefined;
    const analytics = content.analytics;
    const imageCount = Array.isArray(content.image)
      ? content.image.filter((img) => img).length
      : 0;

    const recordAiRequest = async (
      success: boolean,
      extra?: { outputLength?: number; tokenCount?: number; errorCode?: string }
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

    // console.log("hello world!!!")
    let systemContent = '';
    let completeAIPrompt = AIPrompt
    let relevantData = '';
    let panoramaId = '';
    const userContent: [ChatCompletionContentPartText | ChatCompletionContentPartImage] = [
      { type: 'text', text: content.text }
    ]
    //updated userContent to take array of images instead of a singe string image
    if (Array.isArray(content.image) && content.image.length > 0 && content.image[0] !== null) {
      // console.log(content)
      content.image.forEach(image => {
        userContent.push({
          type: 'image_url',
          image_url: {
            url: image,
            detail: 'low',
          },
        });
      });
    }
    // console.log(userContent)
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
      const parsedRequest = await this.parseUserRequest(ctx, content.text, content.coords.latitude, content.coords.longitude)
      // console.log("parsedRequest: ", parsedRequest)
      console.log(parsedRequest?.choices[0].message)
      //determine if chat gpt is returning an api link
      if (parsedRequest && parsedRequest.choices.length > 0 && parsedRequest.choices[0].message.tool_calls && parsedRequest.choices[0].message.tool_calls!.length > 0) {
        console.log(parsedRequest?.choices[0].message.tool_calls![0].function.name)
        toolUsed = parsedRequest.choices[0].message.tool_calls![0].function.name;

        const parsedArgs = JSON.parse(parsedRequest.choices[0].message.tool_calls![0].function.arguments)
        //get link
        const { link } = parsedArgs;
        console.log(link + `&key=${process.env.GOOGLE_API_KEY}`)
        // console.log("parsedArgs", parsedArgs);  
        if (link !== undefined && parsedRequest.choices[0].message.tool_calls![0].function.name !== "generateTrainInformation") {
          //use link
          if (parsedRequest.choices[0].message.tool_calls![0].function.name === "getCrossStreets") {
            completeAIPrompt += crossStreetsPrompt;
            const completeLink = link + `&key=${process.env.GOOGLE_API_KEY}`;
            userContent.push({
              type: 'image_url',
              image_url: {
                url: completeLink,
                detail: 'low',
              }
            });
            // console.log(userContent);
          }

          else {
            const places: any = await axios.get(link + `&key=${process.env.GOOGLE_API_KEY}`);
            //if its giving back a nearby places link
            if (places.data.results) {
              completeAIPrompt += nearbyPlacesPrompt;
              // console.log(places.data.results)
              relevantData = places.data.results.map(
                (place: { name: string, geometry: { location: { lat: number, lng: number } }, rating: number, vicinity: string }) =>
                  `\n{name: ${place.name}, location(lat,lng): ${place.geometry.location.lat},${place.geometry.location.lng}, address: ${place.vicinity}, rating: ${place.rating} stars}`).join(', ');
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
              let operatingHours = '';
              if (places.data.candidates[0].opening_hours) {
                //console.log("user wants operating hours")
                const placeInformation = await axios.get(`https://maps.googleapis.com/maps/api/place/details/json?place_id=${places.data.candidates[0].place_id}&fields=opening_hours&key=${process.env.GOOGLE_API_KEY}`);
                operatingHours = placeInformation.data.result.opening_hours.weekday_text
              }
              systemContent += `Relevant Place Information: ${JSON.stringify(places.data.candidates[0], null, 2)}`
              systemContent += `Operating Hours: ${operatingHours.length > 0 ? operatingHours : 'Not available'}`;
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
              relevantData = "distance: " + places.data.rows[0].elements[0].distance.value + ", duration: " + places.data.rows[0].elements[0].duration.text
              systemContent += `Distance in miles: ${places.data.rows[0].elements[0].distance.value * 0.00062137}, How long it will take to walk: ${places.data.rows[0].elements[0].duration.text}`
              //console.log(systemContent)
            }
          }
        }
        //if its using doorfront api
        else if (parsedRequest.choices[0].message.tool_calls![0].function.name === "useDoorfrontAPI") {
          //use doorfront api
          completeAIPrompt += entrancePrompt;
          const parsedArgs = JSON.parse(parsedRequest.choices[0].message.tool_calls![0].function.arguments)
          //get link
          const { address } = parsedArgs;
          // console.log(address)
          const reqlink = `https://maps.googleapis.com/maps/api/place/findplacefromtext/json?location=
            ${content.coords.latitude},${content.coords.longitude}&fields=formatted_address%2Cname%2Cgeometry&inputtype=textquery&input=${address.replace(/\s+/g, '%2C')}` + `&key=${process.env.GOOGLE_API_KEY}`;
          console.log(reqlink)
          const location: any = await axios.get(reqlink);
          // console.log(location)
          // console.log(geocodedCoords[0].formatted_address)
          // remove st, nd, rd, th from address for better matching
          const cleanAddress = location.data.candidates[0].name.replace(/(\d+)(st|nd|rd|th)\b/gi, '$1');
          const panoramaData = await getPanoramaData(ctx, cleanAddress);
          if (panoramaData) {
            //console.log(panoramaData.human_labels[0].labels);
            console.log(panoramaData.image_description);
            if (panoramaData.url && panoramaData.image_description === undefined) {
              userContent.push({
                type: 'image_url',
                image_url: {
                  url: panoramaData.url,
                  detail: 'high',
                }
              });
              panoramaId = panoramaData._id.toString();
              relevantData = `Entrance Information and Features for ${location.data.candidates[0].formatted_address}:`
              relevantData += panoramaData.human_labels[0].labels.map(
                (label: { label: string, subtype: number, box: { x: number, y: number, width: number, height: number } }) =>
                  `\n${label.label} (${label.subtype ? label.subtype : 'exists'}), Bounding Box: x = ${label.box.x}, y = ${label.box.y}, width: ${label.box.width}, height: ${label.box.height}`
              ).join('; ');
              console.log(relevantData);
            } else {
              relevantData += `Image Description: ${panoramaData.image_description}`;
            }
          } else {
            console.error('No panorama data found for this address.');
            relevantData = `Data on this address has not been collected yet by volunteers. Tell the user entrance details from doorfront.org are unavailable. Do not invent an entrance description from imagery.`;
          }
          systemContent += `\n${relevantData}`;
        }
        else if (parsedRequest.choices[0].message.tool_calls![0].function.name === "getNearbyFeatures") {
          const parsedArgs = JSON.parse(parsedRequest.choices[0].message.tool_calls![0].function.arguments);
          if (parsedArgs.address) {
            console.log(parsedArgs.address);

          }
          const features = await getNearbyFeatures(content.coords.latitude, content.coords.longitude, 0.06);
          // console.log(features);
          const trees: treeInterface[] = features.trees;
          const sidewalkMaterials: sidewalkMaterialInterface[] = features.sidewalkMaterials;
          const pedestrianRamps: pedestrianRampInterface[] = features.pedestrianRamps;
          relevantData = `Nearby Features for location (${content.coords.latitude}, ${content.coords.longitude}):\n`;
          relevantData += `Trees: ${trees.length}, Sidewalk Materials: ${sidewalkMaterials.length}, Pedestrian Ramps: ${pedestrianRamps.length}`;
          systemContent += `\n${relevantData}`;
          let staticMapUrl = `https://maps.googleapis.com/maps/api/staticmap?&zoom=18&size=640x640&maptype=roadmap`;
          // Add user location marker
          staticMapUrl += `&markers=color:blue%7Clabel:U%7C${content.coords.latitude},${content.coords.longitude}`;
          staticMapUrl += `&markers=color:green%7Clabel:T%7C${trees.map(tree => `${tree.location.coordinates[1]},${tree.location.coordinates[0]}`).join('%7C')}`;
          // staticMapUrl += `&markers=color:yellow%7Clabel:S%7C${sidewalkMaterials.map(material => `${material.location.coordinates[1]},${material.location.coordinates[0]}`).join('%7C')}`;
          // Define colors for each sidewalk material type
          const materialColors: Record<string, string> = {
            tactile: "yellow",
            //concrete: "gray",
            manhole: "black",
            "cellar door": "brown",
            "subway grate": "orange",
            other: "white"
          };

          // Add a marker for each material type
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
          // Add the API key to the static map URL
          staticMapUrl += `&key=${process.env.GOOGLE_API_KEY}`;

          console.log(staticMapUrl);
        }
        // Directions with static map, doorfront, and features
        else if (parsedRequest.choices[0].message.tool_calls![0].function.name === "generateGoogleDirectionAPILink") {
          try {
            completeAIPrompt += directionsPrompt
            let formattedAddress = '';
            console.log("Generating Google Direction API Link")
            console.log(parsedArgs);
            // step 1: if destination is a store name, get the formatted address
            let cleanAddress;
            if (!parsedArgs.address) {
              const reqlink = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${content.coords.latitude},${content.coords.longitude}&rankby=distance&keyword=${parsedArgs.destination.replace(/\s+/g, '%20')}&key=${process.env.GOOGLE_API_KEY}`;
              console.log(reqlink)
              const location: any = await axios.get(reqlink);
              // console.log(location)
              console.log(reqlink)
              // const placeInformation = await axios.get(`https://maps.googleapis.com/maps/api/place/details/json?place_id=${location.data.results[0].place_id}&fields=formatted_address&key=${process.env.GOOGLE_API_KEY}`);
              // console.log(`https://maps.googleapis.com/maps/api/place/details/json?place_id=${location.data.results[0].place_id}&fields=formatted_address&key=${process.env.GOOGLE_API_KEY}`)
              formattedAddress = location.data.results[0].vicinity;
              // console.log(`Formatted Address: ${formattedAddress}`);
              // console.log("placeID call ",placeInformation.data.result.formatted_address);
            }
            else {
              const reqlink = `https://maps.googleapis.com/maps/api/place/findplacefromtext/json?location=
                ${content.coords.latitude},${content.coords.longitude}&fields=formatted_address%2Cname&inputtype=textquery&input=${parsedArgs.destination.replace(/\s+/g, '%2C')}` + `&key=${process.env.GOOGLE_API_KEY}`;
              const location: any = await axios.get(reqlink);
              // console.log(location)
              formattedAddress = location.data.candidates[0].formatted_address;
              cleanAddress = location.data.candidates[0].name.replace(/(\d+)(st|nd|rd|th)\b/gi, '$1');
            }
            console.log(formattedAddress);
            

            // step 2: get doorfront data if it exists for the formatted address
            const panoramaData = await getPanoramaData(ctx, cleanAddress);
            let doorfrontData = '';
            let doorLocation: { lat: number, lng: number } | undefined | string = undefined;
            if (panoramaData && panoramaData.human_labels && panoramaData.human_labels.length > 0) {
              console.log("Panorama data found for address:", formattedAddress);
              // doorfrontData += panoramaData.human_labels[0].labels.map(
              //   (label: { label: string, subtype: string, box: { x: number, y: number, width: number, height: number } }) =>
              //     `\n${label.label} (${label.subtype ? label.subtype : 'exists'}), Bounding Box: x = ${label.box.x}, y = ${label.box.y}, width: ${label.box.width}, height: ${label.box.height}`
              // ).join('; ');
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
            }
            // step 3: get route from starting location to destination (doorfront location if it exists)
            if (!doorLocation) {
              doorLocation = formattedAddress;
            }
            const route = await axios.get(`https://maps.googleapis.com/maps/api/directions/json?mode=walking&origin=${content.coords.latitude},${content.coords.longitude}&destination=${doorLocation}&key=${process.env.GOOGLE_API_KEY}`);
            relevantData = "Directions:\n"
            for (let i = 0; i < route.data.routes[0].legs[0].steps.length; i++) {
              relevantData += `Step ${i + 1}) ${route.data.routes[0].legs[0].steps[i].html_instructions} for ${route.data.routes[0].legs[0].steps[i].distance.text} \n`
            }
            console.log(`https://maps.googleapis.com/maps/api/directions/json?mode=walking&origin=${content.coords.latitude},${content.coords.longitude}&destination=${doorLocation}&key=${process.env.GOOGLE_API_KEY}`)
            systemContent += relevantData
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
            systemContent += 'Sorry, I could not generate directions to that location. Please try another destination.'
          }
        }
        else if (parsedRequest.choices[0].message.tool_calls![0].function.name === "imageDescription") {
          completeAIPrompt += imagePrompt;
        }
        else if (parsedRequest.choices[0].message.tool_calls![0].function.name === "videoDescription") {
          completeAIPrompt += videoPrompt;
        }

      } else console.log("No tool calls found in OpenAI response");
      // const places = await fetchNearbyPlaces(content.coords.latitude, content.coords.longitude);
      // nearbyPlaces = places.map((place: { name: string }) => place.name).join(', ');
      // systemContent += ` Nearby Places: ${nearbyPlaces}`;
    } catch (error) {
      console.error('Error including api information in OpenAI request:', error);
    }

    // console.log(systemContent)
    // openAI separate text request
    try {
      //  console.log("user prompt: ", userContent)
        console.log("system prompt: ", systemContent)
      // console.log("openAI history: ", openAIHistory)
      systemContent += `Current Date and Time: ${new Date().toLocaleString()}`;
      // console.log("prompt: ", completeAIPrompt)
      const combinedSystemMessage = completeAIPrompt
        + "\n\nRelevant data: "
        + systemContent
        + "\n\nChat history: "
        + openAIHistory.map(history => `User Input: ${history.input}, Open AI Output: ${history.output}, Data Used: ${history.data}`).join('\n');
      const chatCompletion = await this.client.chat.completions.create({
        messages: [
          { role: 'system', content: combinedSystemMessage },
          { role: 'user', content: userContent }
        ],
        model: 'gpt-4.1-mini',
        temperature: 0.3
      });
      console.log('OpenAI API response:', chatCompletion.usage?.total_tokens);
      openAIHistory.push({ input: content.text, output: chatCompletion.choices[0].message.content as string, data: relevantData });

      // 3. Only update if both conditions are met AND we have a valid ID
      if (panoramaId) {
          console.log("Generating new description for DF database...");
          
          // We pass the panorama _id and the AI's generated output
          await addPanoramaDescription(panoramaId, chatCompletion.choices[0].message.content as string);
      }
      const outputText = chatCompletion.choices[0].message.content as string;
      await recordAiRequest(true, {
        outputLength: outputText?.length ?? 0,
        tokenCount: chatCompletion.usage?.total_tokens,
      });
      res.status(200).json({ output: outputText, history: openAIHistory });
    }
    catch (e: any) {
      console.error('Error with OpenAI API request:', e);
      await recordAiRequest(false, { errorCode: 'openai_error' });
      res.status(500).json({ error: 'Error processing your request: ' + e.message });
    }
  }
  // ----------------------------------------------------------------------------------------------------------------
  //* OpenAI Audio API
  async audioRequest(ctx: AppContext, text: string) {
    const { res } = ctx
    // const speechFile = path.resolve("./speech.mp3");
    //console.log(text)
    try {
      const mp3 = await this.client.audio.speech.create({
        model: "tts-1",
        voice: "echo",
        input: text
      })
      const buffer = Buffer.from(await mp3.arrayBuffer());
      // await fs.promises.writeFile(speechFile, buffer);

      res.contentType("audio/mpeg")
      res.status(200).send(buffer)
    } catch (e) {
      console.error(e)
    }
  }

}
