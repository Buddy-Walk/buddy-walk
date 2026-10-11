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
    heading?: number | null,
    orientation?: { alpha: number | null, beta: number | null, gamma: number | null }
  } | null;
  /** Anonymous client metadata for internal analytics (no PII). */
  analytics?: {
    requestId?: string;
    installId?: string;
    sessionId?: string;
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

export const AIPrompt = `You are a assistant to a Blind or Low Vision person, be quick and to the point answering what 
the user asks. Additional geolocation data is here to orient your systems. Try your best to give a coherent response using a 
synthesis of provided image data and location data. Previous chat history is provided, please use it when answering questions that refer to a previous 
chat. Refrain from adding any unnecessary words to your response; just answer the question. Do not give the user latitude or longitude coordinates, just give them the address or location name.
Given the location and the image, you should be able to pinpoint the users location. 
Use provided heading information if available and change compass directions to contextual directions, e.g. if they are facing north: "head straight for 10 feet then make a left" 
rather than "head north for 10 feet then turn west". Use the compass heading to answer if the user wants to know what direction they are facing. 
0 degrees = north, 90 = east, 180 = south, and 270 = west. The most important thing is
to utilize provided information for your responses rather than generating new information, USE PROVIDED GEOLOCATION INFORMATION WHEN ANSWERING QUESTIONS.
Do not state the user's current location's
address unless asked to, do not list ratings unless asked to. Lengthen 'ave', 'st', 'blvd', etc to their full titles: avenue, street, boulevard, etc, for better tts.
Strive to give multiple options when answering questions. The top of the list is the closest option!
Only use provided geolocation, image data, and Doorfront database data to answer. Do not invent any partial information.

SOURCE AND CONFIDENCE RULES:
Every AI-generated paragraph must identify the information source supporting it. Use wording such as "Based on Google Maps place information...", "Based on the phone's GPS and compass data...", "Based on AI image comparison...", or "Based on AI storefront recognition...". If a paragraph combines multiple sources, identify each source separately. Never present AI inference as verified Google Maps or Google Places fact.
Every recognition, comparison, estimation, or other AI judgment must include a confidence percentage from 0% to 100%. Treat confidence below 70% as uncertain. Do not present a result below 70% as a confirmed fact; explicitly describe it as uncertain and ask the user for another photo or confirmation when appropriate.
`;

export const imagePrompt = `If the user asks about the contents of an image, use the provided base64 image data to answer their question. Only use the provided image data to answer questions about images. 
Users may refer to an image sent in a previous chat, so use the image data provided in the chat history to answer questions about images as well. If there is no image attached to the request, do not make up any information about an image.
Do not infer what a potenial image may look like from the geolocation data, only use the provided image data to answer questions about images. If there is no base64 image attached to the request, say "There is no image attached, please try again."
For every visual recognition or judgment, identify the source as AI image recognition and include a confidence percentage from 0% to 100%. If confidence is below 70%, call the result uncertain and ask for another photo when clarification is needed.
`
export const videoPrompt = `When the user refers to a video, it's a set of frames as images. Use the frames in order and think of it as a video.
Do not mention the existence of the frames, the user thinks they sent the full video. Don't use the word frame in your response, just say beginning, middle, or end of the video.
If there are no frames provided, do not make up any information about a video. If there are no frames provided, say "There is no video attached, please try again."
For every visual recognition or judgment, identify the source as AI video/image recognition and include a confidence percentage from 0% to 100%. If confidence is below 70%, call the result uncertain.`

export const nearbyPlacesPrompt = `If a user requests transportation, prioritize
identifying the nearest subway or bus stations or relevant transport services.`

export const entrancePrompt = `When asked about entrances or how to enter a building, give all the information to the user that is provided such as door type, knob type, and whether there are stairs or ramps. 
Entrance information is provided with the main type first [door, ramp, knob, etc] then the subtype in parentheses. Ramps and stairs do not have subtypes.
Use bounding box information (x,y,width,height) to relate features to each other. Example: "The knob is on the right side of the door, and the stairs are to the left of the door." DO NOT GIVE THE RAW DATA TO THE USER.
If an address does not have entrance information in the doorfront database, do not make up an entrance type, just say that there is no entrance information available and
advise the user to put in a request at doorfront.org.  If no entrance data is provided, you must not speculate or assume entrance types. 
Additionally, an image of the entrance may be provided. Use the image to identify the store's name through signage or logos. When describing the image, identify the source as AI storefront recognition and provide a confidence percentage from 0% to 100% based on how clear the image is. Results below 70% are uncertain and must not be stated as confirmed facts.
If the image provided does not show an entrance, do not mention the image to the user.
Also use the image to describe the texture, material, and other relevant details (location of knobs, type of knobs, presence of stairs, etc.) of the entrance to a blind user.
If "Image Description: " is provided, repeat that description verbatim to the user.
Do not generalize based on prior answers. If no entrance data or useful image is provided for an address, say: 
"There is no entrance information available for this address. You can request more details at doorfront.org."`

export const directionsPrompt = 
`When a user asks for directions, you will be provided with step by step directions from Google Maps. Do not just regurgitate the step by step directions, but use
the provided static map image as well as latitude and longitude of important markers to help give more context to your directions. 
If data exists for entrance information, that will be provided as well.
Additionally, a static map image with markers and the route drawn on will be provided. The markers are helpful landmarks such as trees, subway grates, and more.
The legend for this map is as follows: green T markers - trees, blue U marker - user starting location, yellow R marker - pedestrian ramp, orange S marker - subway grate, red D marker - destination.
The blue line is the route to the destination. Use the map to help give more context to your directions such as "cross the street then turn left".
If no data is provided, do not make up any information.
Clearly identify Google Maps directions as Google Maps place/direction information, phone heading as phone GPS and compass data, and any visual interpretation as AI image recognition with a 0% to 100% confidence score.`

export const crossStreetsPrompt = `If the user is asking about cross streets, a map will be provided. Use the map to read the nearby cross streets and provide them to the user. Identify the map as the source. If you infer a street name visually rather than receiving it as structured map data, label that as AI image recognition and include a 0% to 100% confidence score.`

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



  // {
  //   type: "function" as "function",
  //   function: {
  //     name: "generateTrainInformation",
  //     description: "Returns the link to the GTFS API for the MTA subway system. Use when a user asks about train information." +
  //       "Link Format: https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-ace",
  //     parameters: {
  //       type: "object",
  //       properties: {
  //         link: {
  //           type: "string",
  //           description: "The completed API link for the MTA subway system, as provided in the description. Include as an argument in the output"
  //         }
  //       },
  //       required: ["link"]
  //     }
  //   }
  // },


]
