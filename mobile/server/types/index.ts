import {Request, Response} from "express";

export interface AppContext {
  req: Request;
  res: Response;
}

export interface textRequestBody {
  text: string;
  // image?: string;
  image?: string[];  // Changed from string to an array to support mulitpl video frames
  coords: {
    latitude: number;
    longitude: number,
    accuracy?: number | null,
    heading?: number | null,
    orientation?: { alpha: number | null, beta: number | null, gamma: number | null }
  } | null;
  /** Anonymous client metadata for internal analytics (no PII). */
  analytics?: {
    requestId?: string;
    installId?: string;
    sessionId?: string;
    conversationId?: string;
    resetHistory?: boolean;
    platform?: string;
    appVersion?: string;
    feature?: string;
  };
}

export interface parseRequestBody{
  text:string,
  lat: number,
  lng: number
}

export interface history{
  input: string,
  output: string,
  data: string
}

export const AIPrompt = `You are an assistant for a blind or low-vision person. Answers are read aloud — keep them SHORT and SPECIFIC.

Rules:
- Answer only what was asked. No greetings, disclaimers, or "let me know if you need help".
- Default to 1-3 short sentences. Use a short list only when the user asked for options.
- When listing places or options, give at most 2 unless the user asked for more. Closest first.
- Use provided geolocation, image, and database data only. Do not invent details.
- Do not give latitude/longitude — use address or place names.
- Do not state the user's current address unless they asked where they are.
- Do not mention ratings unless asked.
- Spell out street types for TTS: avenue, street, boulevard (not ave, st, blvd).
- For directions, use contextual left/right/straight from the user's heading, not compass north/south.
- Heading: 0=north, 90=east, 180=south, 270=west.

Source and confidence:
- Name the source for each claim (Google Maps, Street View, phone GPS/compass, AI image comparison, AI storefront recognition).
- Include a 0-100% confidence for AI judgments. Below 70% is uncertain — say so and ask for another photo or confirmation.
`;

export const imagePrompt = `Image questions: answer in 1-3 sentences from the attached image only. If no image attached, say "There is no image attached, please try again." Label visual judgments as AI image recognition with a 0-100% confidence score; below 70% is uncertain.`
export const videoPrompt = `Video questions: describe what happens in 2-4 short sentences using the frames in order. Never say "frame". If no frames, say "There is no video attached, please try again." Label visual judgments as AI recognition with a 0-100% confidence score; below 70% is uncertain.`

export const nearbyPlacesPrompt = `For nearby places or transit: closest option first. At most 2 results unless the user asked for more.`

export const trainPrompt = `Subway arrivals: use ONLY the provided live MTA data for the line the user asked about.
Format: nearest station, then each direction with minutes only (e.g. "Uptown: 4 minutes, Downtown: 7 minutes").
Max 2 upcoming trains per direction. No other lines. No invented times.`

export const entrancePrompt = `Entrances: only use provided doorfront data and images. 2-4 short sentences max.
Describe knob location, door type, stairs/ramps. No raw bounding-box data.
If no data: say entrance info is unavailable at doorfront.org.
Label storefront/entrance recognition as AI storefront recognition with 0-100% confidence; below 70% is uncertain.`

export const directionsPrompt = 
`Directions: 3-5 short steps max. Total walk time first if known.
Use map landmarks briefly. Do not read every Google step verbatim.
If no photo or video is attached: use the map route and location data only.
If a photo or video frames are attached: CRITICAL — analyze the visual input and merge it with the map route for last-meters navigation. Do not ignore the image/video. Tell the user which visible entrance, door, storefront, sign, or landmark to move toward relative to their current view.
If no data, say directions are unavailable.
Identify Google Maps directions as Google Maps data, phone heading as GPS/compass data, and visual interpretation as AI recognition with 0-100% confidence.`

export const crossStreetsPrompt = `Cross streets: name the 2 nearest intersecting streets only. Identify the map as the source; visual street-name guesses need an AI recognition label and confidence score.`

export const openAITools= [
  {
    type: "function" as "function",
    function: {
      name: "generateGoogleAPILinkNonSpecificLocation",
      description: "Generates a Google Nearby Places API link based on user location. Use when user wants to find areas based on type, not specific name. Also use if user asks about where they are so you can geolocate them better." +
      "Type only returns esthablishments that match(i.e. supermarket, library, restaurant, subway_station[use for subway, usually what people want if they say 'train' in New York City], transit_station[use for bus],"+
      +"train_station[use for railroad trains], food, pharmacy), keyword is the relevant search term (i.e. mexican vs japanese food when type is restaurant, pizza,)"+
      "Format: https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${latitude},${longitude}&rankby=distance&type=${type}&keyword=${keyword}",
      parameters: {
        type: "object",
        properties: {
          link: {
            type: "string",
            description: "The completed Google Distance Matrix API link."
          }
        },
        required: ["link"]
      }
    }
  },
  {
    type: "function" as "function",
    function: {
      name: "generateGooglePlacesApiLinkSpecificLocation",
      description: "Generates a Google Place From Text API link using user's current location as a starting point and the user's input as the destination."+
        "Use when a user wants details on a specific location (not when asking about a buildings entrance). If there are spaces in user request, replace with {%20}" +
        "Link Format: https://maps.googleapis.com/maps/api/place/findplacefromtext/json?location=${latitude},${longitude}&fields=place_id%2Cformatted_address%2Cname%2Ctype%2Copening_hours%2Crating&inputtype=textquery&input={USER_REQUEST}",
      parameters: {
        type: "object",
        properties: {
          link: {
            type: "string",
            description: "The completed Google Places From Text API link."
          },
          operatingHours: {
            type: "boolean",
            description: "Indicates if user wants operating hours included in the response. Default is false."
          }
        },
        required: ["link", "operatingHours"]
      }
    }
  },
  // {
  //   type: "function" as "function",
  //   function: {
  //     name: "generateGoogleDirectionAPILink",
  //     description: `Generates a Google Directions API link based on user location. Use when a user asks for a direction to a location. 
  //     If no city is provided, add "New York" by default. If there are spaces in user request, replace with {%20}. If the destination is a store/establishment name,
  //     add 
  //       Link Format: https://maps.googleapis.com/maps/api/directions/json?destination={USER_REQUEST}&mode=walking&origin={LAT,LNG}`,
  //     parameters: {
  //       type: "object",
  //       properties: {
  //         link: {
  //           type: "string",
  //           description: "The completed Google Directions API link."
  //         }
  //       },
  //       required: ["link"]
  //     }
  //   }
  // },
    {
    type: "function" as "function",
    function: {
      name: "generateGoogleDirectionAPILink",
      description: "Extracts destination from user query to generate a Google Directions API link. Use when a user asks for directions to a location. The user may provide an address or a store/establishment name. Either can be used as the destination.",
      parameters: {
        type: "object",
        properties: {
          destination: {
            type: "string",
            description: "The user's requested destination for directions. This can be an address or a store/establishment name."
          },
          address:{
            type: "boolean",
            description: "Indicates if the destination is an address. If true, the destination is treated as a full address; if false, it is treated as a store/establishment name."
          }
        },
        required: ["destination", "address"]
      }
    }
  },
  {
    type: "function" as "function",
    function: {
      name: "generateGoogleDistanceMatrixAPILink",
      description: "Generates a Google Distance Matrix API link based on user location. Use when a user asks to know how far they are from a specific location."
        + "If there are spaces in user request, replace with {%20}. USE LAT and LNG over the name of the place is both provided" +
        "Link Format: https://maps.googleapis.com/maps/api/distancematrix/json?departure_time=now&destinations={USER_REQUEST}&origins={LAT,LNG}&mode=walking",
      parameters: {
        type: "object",
        properties: {
          link: {
            type: "string",
            description: "The completed Google Distance Matrix API link."
          }
        },
        required: ["link"]
      }
    }
  },
  {
    type: "function" as "function",
    function: {
      name: "useDoorfrontAPI",
      description: "Fetches panorama data from the Doorfront API based on user location. Use when a user asks where is a locations entrance or wants to know what to expect when they arrive at a location." ,
      parameters: {
        type: "object",
        properties: {
          address: {
            type: "string",
            description: "The provided address the user is asking about."
          }
        },
        required: ["address"]
      }
    }
  },
    {
    type: "function" as "function",
    function: {
      name: "getNearbyFeatures",
      description: "Fetches nearby geographic features based on user location. Use when a user asks about geographic features (sidewalk materials, trees, or pedestrian ramps)." +
      "Return the address the user wants the features for. If they ask for features near them, provide the user's current location.",
      parameters: {
        type: "object",
        properties: {
          address: {
            type: "string",
            description: "The provided address the user is asking about. If users asks for features near them, leave this blank."
          }
        }
      }
    }
  },
  {
    type: "function" as "function",
    function: {
      name: "getCrossStreets",
      description: "Parses the user input to extract the address. Return the completed Google Static Map API link following this format: " +
        "https://maps.googleapis.com/maps/api/staticmap?center={address}&zoom=18&size=640x640" +
        "User may provide an address or a store/establishment name. Either can be used as the center property. If there are spaces in user inputted address or store name, replace with {%20}" +
        "If they ask for nearby cross streets, use their current location.",
      parameters: {
        type: "object",
        properties: {
          link: {
            type: "string",
            description: "The completed Google Static Map API link for the address or location provided by the user. "
          }
        }, 
        required: ["link"]
      }
    }
  },
  {
    type: "function" as "function",
    function: {
      name: "imageDescription",
      description: "Return if user wants a description of an image.",
    }
  },
  {
    type: "function" as "function",
    function: {
      name: "videoDescription",
      description: "Return if user wants a description of a video.",
    }
  },
  {
    type: "function" as "function",
    function: {
      name: "historyQuery",
      description: "Return if user wants information about their chat history.  ",
    }
  },



  {
    type: "function" as "function",
    function: {
      name: "generateTrainInformation",
      description: "Gets real-time arrival data for a specific MTA subway line. Use when a user asks when their train is arriving.",
      parameters: {
        type: "object",
        properties: {
          routeId: {
            type: "string",
            description: "The specific subway line requested by the user, formatted as a single uppercase letter or number (e.g., 'A', 'R', '7', '6')."
          }
        },
        required: ["routeId"]
      }
    }
  },


]
