import "./doorfrontUri";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import axios from "axios";
import { MongoClient, ObjectId } from "mongodb";
import OpenAI from "openai";
import { routedEvidence, toolEvidence } from "../../server/services/questionTools";
import { QuestionReply } from "../../server/services/questionReply";
import { readQuestionRequest } from "../../server/services/questionRequest";
import { aiRequestLogService } from "../../server/services/aiRequestLog";
import { PedestrianRampModel, SidewalkMaterialModel, TreeModel } from "../../server/database/models/features";
import {
  crossStreetsPrompt,
  directionsPrompt,
  entrancePrompt,
  imagePrompt,
  nearbyPlacesPrompt,
  trainPrompt,
  videoPrompt,
  type textRequestBody,
} from "../../server/types";
import { setTestEnv } from "./testEnv";

const GOOGLE_KEY = "tools-test-google";
const TIMES_SQUARE = { latitude: 40.7559, longitude: -73.9871, accuracy: 10 };
let installCounter = 0;

/**
 * Fake Google over axios. `replies` answers by endpoint, the path segment before
 * "/json"; an Error rejects the request. Returns every request made, with its
 * params when axios got them separately.
 */
function fakeGoogle(t: TestContext, replies: Record<string, unknown>) {
  setTestEnv(t, { GOOGLE_MAPS_API_KEY: GOOGLE_KEY });
  const requests: object[] = [];
  t.mock.method(axios, "get", async (url: string, options?: any) => {
    requests.push(options ? { url, params: options.params } : { url });
    const endpoint = new URL(url).pathname.split("/").at(-2)!;
    if (!(endpoint in replies)) throw new Error(`Unexpected request: ${url}`);
    const reply = replies[endpoint];
    if (reply instanceof Error) throw reply;
    return { data: reply };
  });
  return requests;
}

/** What a routed tool is given for a Question asking `text` from Times Square. */
function toolContext(t: TestContext, text: string, content: Partial<textRequestBody> = {}) {
  t.mock.method(aiRequestLogService, "record", async () => {});
  installCounter++;
  const body: textRequestBody = {
    text,
    coords: TIMES_SQUARE,
    analytics: { installId: `tools-test-${installCounter}` },
    ...content,
  };
  const request = readQuestionRequest(body);
  return { text, request, reply: new QuestionReply(body, request) };
}

/** A tool call as the routing call returns it. */
function call(name: string, args: object = {}) {
  return { name, arguments: JSON.stringify(args) };
}

test("the train tool gives the model live arrivals for the line the Question names", async (t) => {
  const fetches: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string) => {
    fetches.push(String(url));
    return { ok: false } as Response;
  });
  const context = toolContext(t, "When is the next Q train?");

  const evidence = await toolEvidence(call("generateTrainInformation", { routeId: "a" }), context);

  const data =
    "Live MTA Transit Information for line Q: " +
    "Could not connect to the MTA real-time feed right now. Please try again in a moment.";
  assert.deepEqual(evidence, { prompt: trainPrompt, relevantData: `\n${data}`, data, toolUsed: "generateTrainInformation" });
  assert.equal(fetches.length, 1);
});

const PHARMACY_LINK =
  "https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=40.7559,-73.9871&rankby=distance&type=pharmacy";

test("a nearby places link gives the model Google's list, with open-now text", async (t) => {
  const requests = fakeGoogle(t, { nearbysearch: { status: "OK", results: [
    { name: "Duane Reade", geometry: { location: { lat: 40.7565, lng: -73.9866 } }, rating: 4.1, vicinity: "1627 Broadway", opening_hours: { open_now: true } },
    { name: "CVS Pharmacy", geometry: { location: { lat: 40.757, lng: -73.986 } }, rating: 3.8, vicinity: "1633 Broadway", opening_hours: { open_now: false } },
    { name: "Walgreens", geometry: { location: { lat: 40.7575, lng: -73.9855 } }, rating: 4, vicinity: "1471 Broadway" },
  ] } });
  const tool = "generateGoogleAPILinkNonSpecificLocation";

  const evidence = await toolEvidence(call(tool, { link: PHARMACY_LINK }), toolContext(t, "Is there a pharmacy around here?"));

  const places =
    "\n{name: Duane Reade, location(lat,lng): 40.7565,-73.9866, address: 1627 Broadway, rating: 4.1 stars, Google Maps lists it as open now}, " +
    "\n{name: CVS Pharmacy, location(lat,lng): 40.757,-73.986, address: 1633 Broadway, rating: 3.8 stars, Google Maps lists it as closed now}, " +
    "\n{name: Walgreens, location(lat,lng): 40.7575,-73.9855, address: 1471 Broadway, rating: 4 stars}";
  assert.deepEqual(evidence, {
    prompt: nearbyPlacesPrompt,
    relevantData: `\nNearby Places in order of nearest distance: ${places}`,
    data: places,
    toolUsed: tool,
  });
  assert.deepEqual(requests, [{ url: `${PHARMACY_LINK}&key=${GOOGLE_KEY}` }]);
});

const JOES_PIZZA_LINK =
  "https://maps.googleapis.com/maps/api/place/findplacefromtext/json?fields=place_id%2Cname%2Copening_hours" +
  "&inputtype=textquery&input=Joe%27s%20Pizza&locationbias=circle:2000@40.7559,-73.9871";
const JOES_PIZZA = { findplacefromtext: { status: "OK", candidates: [{ place_id: "joes-pizza", name: "Joe's Pizza" }] } };
const JOES_PIZZA_JSON = '{\n  "place_id": "joes-pizza",\n  "name": "Joe\'s Pizza"\n}';
const PLACE_TOOL = "generateGooglePlacesApiLinkSpecificLocation";

test("a Find Place link gives the model the place and its opening status, computed from Google's hours", async (t) => {
  // Tuesday at noon in New York.
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-27T16:00:00Z") });
  const requests = fakeGoogle(t, { ...JOES_PIZZA, details: { status: "OK", result: {
    name: "Joe's Pizza",
    utc_offset: -240,
    opening_hours: {
      open_now: true,
      periods: [{ open: { day: 2, time: "1100" }, close: { day: 2, time: "2200" } }],
      weekday_text: ["Monday: Closed", "Tuesday: 11:00 AM - 10:00 PM", "Wednesday: Closed", "Thursday: Closed", "Friday: Closed", "Saturday: Closed", "Sunday: Closed"],
    },
  } } });

  const evidence = await toolEvidence(
    call(PLACE_TOOL, { link: JOES_PIZZA_LINK, operatingHours: true }),
    toolContext(t, "Is Joe's Pizza open right now?"),
  );

  assert.deepEqual(evidence, {
    prompt: nearbyPlacesPrompt,
    relevantData:
      `Relevant Place Information: ${JOES_PIZZA_JSON}\n` +
      "Opening status computed from Google Maps hours. Repeat it as written and do not recalculate open or closed yourself: " +
      "Google Maps lists Joe's Pizza as open right now (it is 12:00 PM there). It closes today at 10:00 PM. " +
      "Today's listed hours: Tuesday: 11:00 AM - 10:00 PM.\n",
    toolUsed: PLACE_TOOL,
  });
  assert.deepEqual(requests, [
    { url: `${JOES_PIZZA_LINK}&key=${GOOGLE_KEY}` },
    {
      url: "https://maps.googleapis.com/maps/api/place/details/json",
      params: { place_id: "joes-pizza", fields: "name,business_status,opening_hours,current_opening_hours,utc_offset", key: GOOGLE_KEY },
    },
  ]);
});

test("a Find Place link whose hours lookup fails says the hours are not available", async (t) => {
  fakeGoogle(t, { ...JOES_PIZZA, details: new Error("timeout of 20000ms exceeded") });

  const evidence = await toolEvidence(
    call(PLACE_TOOL, { link: JOES_PIZZA_LINK, operatingHours: true }),
    toolContext(t, "Is Joe's Pizza open right now?"),
  );

  assert.deepEqual(evidence, {
    prompt: nearbyPlacesPrompt,
    relevantData: `Relevant Place Information: ${JOES_PIZZA_JSON}\nOperating Hours: Not available\n`,
    toolUsed: PLACE_TOOL,
  });
});

test("a Find Place link without a location bias is kept within 5 km of the user", async (t) => {
  const requests = fakeGoogle(t, { findplacefromtext: { status: "OK", candidates: [] } });
  const link = "https://maps.googleapis.com/maps/api/place/findplacefromtext/json?fields=name&inputtype=textquery&input=Joe%27s%20Pizza";

  const evidence = await toolEvidence(call(PLACE_TOOL, { link }), toolContext(t, "Tell me about Joe's Pizza."));

  assert.deepEqual(evidence, {
    prompt: nearbyPlacesPrompt,
    relevantData: "Relevant Place Information: null\nOperating Hours: Not available\n",
    toolUsed: PLACE_TOOL,
  });
  assert.deepEqual(requests, [{ url: `${link}&locationbias=circle:5000@40.7559,-73.9871&key=${GOOGLE_KEY}` }]);
});

test("a distance link gives the model Google's walking distance in miles and time", async (t) => {
  const link = "https://maps.googleapis.com/maps/api/distancematrix/json?destinations=Bryant%20Park&origins=40.7559,-73.9871&mode=walking";
  fakeGoogle(t, { distancematrix: { status: "OK", rows: [{ elements: [{
    distance: { text: "0.5 mi", value: 805 },
    duration: { text: "10 mins", value: 600 },
  }] }] } });
  const tool = "generateGoogleDistanceMatrixAPILink";

  const evidence = await toolEvidence(call(tool, { link }), toolContext(t, "How far is Bryant Park?"));

  assert.deepEqual(evidence, {
    relevantData: "Distance in miles: 0.50020285, How long it will take to walk: 10 mins",
    data: "distance: 805, duration: 10 mins",
    toolUsed: tool,
  });
});

const ENTRANCE_QUESTION = "What does the entrance at 123 West 43rd Street look like?";
const ENTRANCE_CALL = call("useDoorfrontAPI", { address: "123 West 43rd Street" });
const ENTRANCE_ADDRESS = "123 W 43rd St, New York, NY 10036, USA";
const ENTRANCE_LOOKUP = {
  findplacefromtext: { status: "OK", candidates: [{ name: "123 West 43rd Street", formatted_address: ENTRANCE_ADDRESS }] },
};

/** Fake the Doorfront collection at the Mongo driver. Returns the address each lookup searched for. */
function fakeDoorfront(t: TestContext, panorama: object | null) {
  const searches: string[] = [];
  t.mock.method(MongoClient.prototype, "connect", async function (this: MongoClient) { return this; });
  t.mock.method(MongoClient.prototype, "db", () => ({
    collection: () => ({
      findOne: async (query: any) => { searches.push(query.address.$regex); return panorama; },
    }),
  }));
  return searches;
}

test("the entrance tool gives the model the Doorfront panorama and its labels, to save the answer to", async (t) => {
  const requests = fakeGoogle(t, ENTRANCE_LOOKUP);
  const searches = fakeDoorfront(t, {
    _id: new ObjectId("64b000000000000000000001"),
    url: "https://doorfront.test/pano.jpg",
    human_labels: [{ labels: [
      { label: "door", subtype: 2, box: { x: 10, y: 20, width: 30, height: 40 } },
      { label: "handle", box: { x: 15, y: 25, width: 5, height: 5 } },
    ] }],
  });

  const evidence = await toolEvidence(ENTRANCE_CALL, toolContext(t, ENTRANCE_QUESTION));

  const labels =
    `Entrance Information and Features for ${ENTRANCE_ADDRESS}:` +
    "\ndoor (2), Bounding Box: x = 10, y = 20, width: 30, height: 40; " +
    "\nhandle (exists), Bounding Box: x = 15, y = 25, width: 5, height: 5";
  assert.deepEqual(evidence, {
    prompt: entrancePrompt,
    relevantData: `\n${labels}`,
    data: labels,
    images: [{ type: "image_url", image_url: { url: "https://doorfront.test/pano.jpg", detail: "high" } }],
    panoramaId: "64b000000000000000000001",
    toolUsed: "useDoorfrontAPI",
  });
  // The line break after location= has always been sent.
  assert.deepEqual(requests, [{ url:
    "https://maps.googleapis.com/maps/api/place/findplacefromtext/json?location=\n            40.7559,-73.9871" +
    `&fields=formatted_address%2Cname%2Cgeometry&inputtype=textquery&input=123%2CWest%2C43rd%2CStreet&key=${GOOGLE_KEY}` }]);
  assert.deepEqual(searches, ["123 West 43 Street"], "Doorfront addresses have no ordinal suffixes");
});

test("the entrance tool uses the description Doorfront already has", async (t) => {
  fakeGoogle(t, ENTRANCE_LOOKUP);
  fakeDoorfront(t, {
    _id: new ObjectId("64b000000000000000000002"),
    url: "https://doorfront.test/pano.jpg",
    image_description: "A glass door with a push bar on the right.",
  });

  const evidence = await toolEvidence(ENTRANCE_CALL, toolContext(t, ENTRANCE_QUESTION));

  const data = "Image Description: A glass door with a push bar on the right.";
  assert.deepEqual(evidence, { prompt: entrancePrompt, relevantData: `\n${data}`, data, toolUsed: "useDoorfrontAPI" });
});

test("the entrance tool without Doorfront data gives the model a Street View image", async (t) => {
  fakeGoogle(t, ENTRANCE_LOOKUP);
  fakeDoorfront(t, null);
  t.mock.method(globalThis, "fetch", async (url: string) => {
    const data = String(url).includes("/streetview/metadata")
      ? { status: "OK", pano_id: "pano-1", copyright: "© Google", location: { lat: 40.756, lng: -73.985 } }
      : { status: "OK", results: [{ geometry: { location: { lat: 40.7561, lng: -73.985 } } }] };
    return { json: async () => data } as Response;
  });

  const evidence = await toolEvidence(ENTRANCE_CALL, toolContext(t, ENTRANCE_QUESTION));

  const data =
    "Data on this address has not been collected yet by volunteers. Use the street view image to describe the " +
    "entrance features visible from street view. Let the user know this data is not validated by real users and may not be correct." +
    "\n             When describing this image, provide a confidence level (1 to 5) for your description of the entrance " +
    "based on how clear the image is.";
  const streetView =
    "https://maps.googleapis.com/maps/api/streetview?size=640x480&pano=pano-1&heading=0.00&fov=80&pitch=0" +
    `&source=outdoor&return_error_code=true&key=${GOOGLE_KEY}`;
  assert.deepEqual(evidence, {
    prompt: entrancePrompt,
    relevantData: `\n${data}`,
    data,
    images: [{ type: "image_url", image_url: { url: streetView, detail: "high" } }],
    toolUsed: "useDoorfrontAPI",
  });
});

test("the entrance tool keeps its prompt when Google cannot find the address", async (t) => {
  fakeGoogle(t, { findplacefromtext: { status: "ZERO_RESULTS", candidates: [] } });

  const evidence = await toolEvidence(ENTRANCE_CALL, toolContext(t, ENTRANCE_QUESTION));

  assert.deepEqual(evidence, { prompt: entrancePrompt, toolUsed: "useDoorfrontAPI" });
});

test("the nearby features tool counts the trees, sidewalk materials, and ramps around the user", async (t) => {
  const point = (lng: number, lat: number) => ({ location: { type: "Point", coordinates: [lng, lat] } });
  t.mock.method(TreeModel, "find", (async () => [point(-73.987, 40.756)]) as any);
  t.mock.method(SidewalkMaterialModel, "find", (async () => [
    { ...point(-73.9872, 40.7558), material: "Tactile" },
    { ...point(-73.9869, 40.7561), material: "manhole" },
  ]) as any);
  t.mock.method(PedestrianRampModel, "find", (async () => [point(-73.9873, 40.7557)]) as any);

  const evidence = await toolEvidence(call("getNearbyFeatures"), toolContext(t, "Are there curb ramps around me?"));

  const data = "Nearby Features for location (40.7559, -73.9871):\nTrees: 1, Sidewalk Materials: 2, Pedestrian Ramps: 1";
  assert.deepEqual(evidence, { relevantData: `\n${data}`, data, toolUsed: "getNearbyFeatures" });
});

test("the cross streets tool gives the model a low-detail static map", async (t) => {
  setTestEnv(t, { GOOGLE_MAPS_API_KEY: GOOGLE_KEY });
  const link = "https://maps.googleapis.com/maps/api/staticmap?center=40.7559,-73.9871&zoom=18&size=640x640";

  const evidence = await toolEvidence(call("getCrossStreets", { link }), toolContext(t, "What are the cross streets here?"));

  assert.deepEqual(evidence, {
    prompt: crossStreetsPrompt,
    images: [{ type: "image_url", image_url: { url: `${link}&key=${GOOGLE_KEY}`, detail: "low" } }],
    toolUsed: "getCrossStreets",
  });
});

test("the directions tool gives the model the verified route for a Question with a photo", async (t) => {
  fakeGoogle(t, {
    nearbysearch: { status: "OK", results: [{
      place_id: "citibank",
      name: "Citibank",
      vicinity: "10 Test Street",
      geometry: { location: { lat: 40.7563, lng: -73.9871 } },
      types: ["bank"],
    }] },
    directions: { status: "OK", routes: [{
      overview_polyline: { points: "abc" },
      legs: [{ distance: { text: "141 ft", value: 43 }, duration: { text: "1 min", value: 30 }, steps: [{
        html_instructions: "Head north on Test Street",
        distance: { text: "141 ft", value: 43 },
        duration: { text: "1 min", value: 30 },
        start_location: { lat: 40.7559, lng: -73.9871 },
        end_location: { lat: 40.7563, lng: -73.9871 },
      }] }],
    }] },
  });
  const context = toolContext(t, "Which way is Citibank from here?", { image: ["data:image/jpeg;base64,storefront"] });

  const evidence: any = await toolEvidence(
    call("generateGoogleDirectionAPILink", { destination: " Citibank ", address: false }),
    context,
  );

  const data = "Directions:\nStep 1) Head north on Test Street for 141 ft";
  assert.equal(evidence.prompt, directionsPrompt);
  assert.equal(evidence.data, data);
  assert.equal(
    evidence.relevantData,
    `\nVerified nearby destination: Citibank, 10 Test Street, approximately 44 meters away.\n${data}`,
  );
  assert.equal(evidence.route.destination.name, "Citibank");
  assert.equal(evidence.toolUsed, "generateGoogleDirectionAPILink");
});

test("the directions tool refuses a destination that is empty", async (t) => {
  const requests = fakeGoogle(t, {});
  const context = toolContext(t, "Which way is it from here?");

  const result: any = await toolEvidence(call("generateGoogleDirectionAPILink", { destination: "  ", address: false }), context);

  assert.equal(result.status, 200);
  assert.equal(
    result.body.output,
    "I could not verify a nearby destination from your current location. Try a more specific name or street address.",
  );
  assert.deepEqual(requests, []);
});

test("the image and video tools add their prompt, and the history tool adds nothing", async (t) => {
  const context = toolContext(t, "What does this sign say?");
  assert.deepEqual(await toolEvidence(call("imageDescription"), context), { prompt: imagePrompt, toolUsed: "imageDescription" });
  assert.deepEqual(await toolEvidence(call("videoDescription"), context), { prompt: videoPrompt, toolUsed: "videoDescription" });
  assert.deepEqual(await toolEvidence(call("historyQuery"), context), { toolUsed: "historyQuery" });
});

test("a tool whose arguments are not JSON adds nothing but its name", async (t) => {
  const requests = fakeGoogle(t, {});

  const evidence = await toolEvidence(
    { name: "useDoorfrontAPI", arguments: "{address:" },
    toolContext(t, ENTRANCE_QUESTION),
  );

  assert.deepEqual(evidence, { toolUsed: "useDoorfrontAPI" });
  assert.deepEqual(requests, []);
});

test("a tool whose arguments are null adds nothing but its name", async (t) => {
  const context = toolContext(t, "What does this sign say?");
  for (const name of ["imageDescription", "useDoorfrontAPI", "generateTrainInformation"]) {
    assert.deepEqual(await toolEvidence({ name, arguments: "null" }, context), { toolUsed: name });
  }
});

/** Fake the routing call with one answer: a tool call, no tool call, or a failure. Returns its requests. */
function fakeRouting(t: TestContext, answer: { name: string; args: object } | "no tool" | Error) {
  const requests: any[] = [];
  t.mock.method(OpenAI.Chat.Completions.prototype, "create", async (request: any) => {
    requests.push(request);
    if (answer instanceof Error) throw answer;
    if (answer === "no tool") return { choices: [{ message: { content: "none" } }] };
    return { choices: [{ message: { content: null, tool_calls: [{
      id: "call-1",
      type: "function",
      function: { name: answer.name, arguments: JSON.stringify(answer.args) },
    }] } }] };
  });
  return requests;
}

test("a routed Question gets the evidence of the tool the routing call picks", async (t) => {
  setTestEnv(t, { OPENAI_API_KEY: "tools-test-openai" });
  const routing = fakeRouting(t, { name: "imageDescription", args: {} });

  const evidence = await routedEvidence(toolContext(t, "What does this sign say?"));

  assert.deepEqual(evidence, { prompt: imagePrompt, toolUsed: "imageDescription" });
  assert.equal(routing.length, 1);
  assert.deepEqual(routing[0].messages[0], { role: "user", content: "What does this sign say?" });
  assert.match(routing[0].messages[1].content, /The latitude is 40\.7559 and the longitude is -73\.9871\./);
});

test("a routed Question gets no evidence when the routing call fails or picks no tool", async (t) => {
  setTestEnv(t, { OPENAI_API_KEY: "tools-test-openai" });
  for (const answer of [new Error("routing unavailable"), "no tool" as const]) {
    fakeRouting(t, answer);
    assert.deepEqual(await routedEvidence(toolContext(t, "What is this neighborhood like?")), {});
  }
});

test("a routed Question whose tool fails gets only the tool's name", async (t) => {
  setTestEnv(t, { OPENAI_API_KEY: "tools-test-openai" });
  fakeRouting(t, { name: "generateGoogleAPILinkNonSpecificLocation", args: { link: PHARMACY_LINK } });
  fakeGoogle(t, { nearbysearch: new Error("socket hang up") });

  const evidence = await routedEvidence(toolContext(t, "Is there a pharmacy around here?"));

  assert.deepEqual(evidence, { toolUsed: "generateGoogleAPILinkNonSpecificLocation" });
});
