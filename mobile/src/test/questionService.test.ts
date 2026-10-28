import "./doorfrontUri";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import axios from "axios";
import { MongoClient, ObjectId } from "mongodb";
import OpenAI from "openai";
import { OpenAIQuestionService } from "../../server/services/openAIQuestionService";
import { aiRequestLogService } from "../../server/services/aiRequestLog";
import { PedestrianRampModel, SidewalkMaterialModel, TreeModel } from "../../server/database/models/features";
import { formatHistoryForPrompt } from "../../server/utils/conversationHistory";
import {
  AIPrompt,
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

// Characterization tests: they pin what Question answering does today so the
// code can be moved without changing it. Providers are faked at the axios,
// fetch, OpenAI SDK, Mongo driver, and Mongoose model boundaries, not inside the service.
// The tests after the first few compare whole response bodies, final model
// requests, and AI request log rows, one test per way textRequest can end or
// data source it can use.

const TIMES_SQUARE = { latitude: 40.7559, longitude: -73.9871 };
const PRECISE_LOCATION = { ...TIMES_SQUARE, accuracy: 10 };
const GOOGLE_KEY = "question-test-google";
const ADDRESS = "1560 Broadway, New York, NY";
const GEOCODE = { results: [{ formatted_address: ADDRESS }] };
const NOW = Date.parse("2026-10-27T16:00:00Z");
let installCounter = 0;

/** About 44 meters north of TIMES_SQUARE. */
const CITIBANK = {
  place_id: "citibank",
  name: "Citibank",
  vicinity: "10 Test Street",
  geometry: { location: { lat: 40.7563, lng: -73.9871 } },
  types: ["bank"],
};
const ROUTE_TO_CITIBANK = { status: "OK", routes: [{
  overview_polyline: { points: "abc" },
  legs: [{ distance: { text: "141 ft", value: 43 }, duration: { text: "1 min", value: 30 }, steps: [{
    html_instructions: "Head <b>north</b> on Test&nbsp;Street",
    distance: { text: "141 ft", value: 43 },
    duration: { text: "1 min", value: 30 },
    maneuver: "",
    start_location: { lat: 40.7559, lng: -73.9871 },
    end_location: { lat: 40.7563, lng: -73.9871 },
    travel_mode: "WALKING",
  }] }],
}] };
/** The route the app receives for ROUTE_TO_CITIBANK. */
const VERIFIED_ROUTE = {
  destination: { name: "Citibank", address: "10 Test Street", lat: 40.7563, lng: -73.9871 },
  origin: { lat: 40.7559, lng: -73.9871 },
  totalDistance: { text: "141 ft", value: 43 },
  totalDuration: { text: "1 min", value: 30 },
  steps: [{
    index: 0,
    instruction: "Head north on Test Street",
    distance: { text: "141 ft", value: 43 },
    duration: { text: "1 min", value: 30 },
    maneuver: "",
    startLocation: { lat: 40.7559, lng: -73.9871 },
    endLocation: { lat: 40.7563, lng: -73.9871 },
    travelMode: "WALKING",
  }],
  polyline: "abc",
  travelMode: "WALKING",
};
const CITIBANK_DIRECTIONS = "Step 1) Head north on Test Street for 141 ft";
const NEARBY_SEARCH_FOR_CITIBANK = {
  url: "https://maps.googleapis.com/maps/api/place/nearbysearch/json",
  params: { location: "40.7559,-73.9871", rankby: "distance", keyword: "Citibank", key: GOOGLE_KEY },
};
const TEXT_SEARCH_FOR_CITIBANK = {
  url: "https://maps.googleapis.com/maps/api/place/textsearch/json",
  params: { query: "Citibank", location: "40.7559,-73.9871", radius: 5000, key: GOOGLE_KEY },
};
const DIRECTIONS_TO_CITIBANK = {
  url: "https://maps.googleapis.com/maps/api/directions/json",
  params: { mode: "walking", origin: "40.7559,-73.9871", destination: "place_id:citibank", key: GOOGLE_KEY },
};
const GEOCODE_TIMES_SQUARE = { url: `https://maps.googleapis.com/maps/api/geocode/json?latlng=40.7559,-73.9871&key=${GOOGLE_KEY}` };

function unverifiedDestination(label: string) {
  return `I could not verify a nearby ${label} from your current location. Try a more specific name or street address.`;
}
const UNVERIFIED_DATA = "Nearby destination lookup failed; no unverified location was used.";

const LAST_METERS_INSTRUCTION =
  "\n\nCRITICAL INSTRUCTION: The user attached an image/video of their surroundings for 'Last Meters' navigation. " +
  "DO NOT just read the GPS directions. You MUST analyze the image and use it to guide the user exactly to the " +
  "physical door or entrance relative to their current view.";

function setUp(t: TestContext) {
  setTestEnv(t, { OPENAI_API_KEY: "question-test-openai", GOOGLE_MAPS_API_KEY: GOOGLE_KEY });

  const logged: any[] = [];
  t.mock.method(aiRequestLogService, "record", async (row: any) => { logged.push(row); });
  const httpCalls: string[] = [];
  const completions: any[] = [];
  return { logged, httpCalls, completions };
}

function fakeResponse() {
  const res = {
    statusCode: 0,
    body: undefined as any,
    contentTypeValue: undefined as string | undefined,
    sent: undefined as Buffer | undefined,
    status(code: number) { res.statusCode = code; return res; },
    json(payload: any) { res.body = payload; return res; },
    contentType(value: string) { res.contentTypeValue = value; return res; },
    send(payload: Buffer) { res.sent = payload; return res; },
  };
  return res;
}

async function ask(content: textRequestBody) {
  const res = fakeResponse();
  await new OpenAIQuestionService().textRequest({ res } as any, content);
  return res;
}

/** Every analytics field the log row copies, so a row comparison sees each one. */
function analytics(feature?: string) {
  installCounter++;
  return {
    requestId: `question-request-${installCounter}`,
    installId: `question-test-${installCounter}`,
    sessionId: "question-session",
    platform: "ios",
    appVersion: "1.0.0",
    ...(feature === undefined ? {} : { feature }),
  };
}

/**
 * Fake Google over axios. `replies` answers by endpoint, the path segment before
 * "/json" ("geocode", "nearbysearch", "details", ...); an Error rejects the request.
 * Returns every request made, with its params when axios got them separately.
 */
function fakeGoogle(t: TestContext, replies: Record<string, unknown>) {
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

/** What the tool-routing call answers: one tool call, no tool call, or a failure. */
type Route = { tool: string; args?: object } | "no tool" | Error;

/** Fake OpenAI. Tool-routing calls take `routes` in order and answer calls take `answers` in order. */
function fakeModel(t: TestContext, routes: Route[], answers: (string | Error)[]) {
  const routing: any[] = [];
  const final: any[] = [];
  t.mock.method(OpenAI.Chat.Completions.prototype, "create", async (request: any) => {
    if (request.tools) {
      const route = routes[routing.length];
      routing.push(request);
      if (route === undefined) throw new Error("Unexpected routing call");
      if (route instanceof Error) throw route;
      if (route === "no tool") return { choices: [{ message: { content: "none" } }], usage: { total_tokens: 20 } };
      return {
        choices: [{ message: { content: null, tool_calls: [{
          id: "call-1",
          type: "function",
          function: { name: route.tool, arguments: JSON.stringify(route.args ?? {}) },
        }] } }],
        usage: { total_tokens: 20 },
      };
    }
    const answer = answers[final.length];
    final.push(request);
    if (answer === undefined) throw new Error("Unexpected answer call");
    if (answer instanceof Error) throw answer;
    return { choices: [{ message: { content: answer } }], usage: { total_tokens: 42 } };
  });
  return { routing, final };
}

/**
 * Fake the Doorfront collection at the Mongo driver. services/doorfront.ts keeps
 * its client for the whole process, so `db` is faked on the prototype each test.
 * Returns every collection call with the database and collection it went to.
 */
function fakeDoorfront(t: TestContext, panorama: object | null) {
  const calls: object[] = [];
  t.mock.method(MongoClient.prototype, "connect", async function (this: MongoClient) { return this; });
  t.mock.method(MongoClient.prototype, "db", (db: string) => ({
    collection: (collection: string) => ({
      findOne: async (...args: unknown[]) => { calls.push({ db, collection, findOne: args }); return panorama; },
      updateOne: async (...args: unknown[]) => { calls.push({ db, collection, updateOne: args }); return { matchedCount: 1 }; },
    }),
  }));
  return calls;
}

/** JSON as sent or stored, without the request's latency or the clock time in the system message. */
function comparable(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (key, field) => {
    if (key === "latencyMs") return undefined;
    return typeof field === "string"
      ? field.replace(/(Current Date and Time \(Eastern\): )[^\n]*/, "$1<now>")
      : field;
  }));
}

/** The final answer request, as `comparable` shows it. */
function finalRequest(
  prompt: string,
  relevantData: string,
  userContent: object[],
  maxTokens = 120,
  history = formatHistoryForPrompt([]),
) {
  return {
    messages: [
      {
        role: "system",
        content: `${prompt}\n\nRelevant data: ${relevantData}\nCurrent Date and Time (Eastern): <now>\n\nChat history: ${history}`,
      },
      { role: "user", content: userContent },
    ],
    model: "gpt-4o-mini",
    temperature: 0.2,
    max_tokens: maxTokens,
  };
}

test("a directions Question without a location is refused before any lookup", async (t) => {
  const { logged, httpCalls, completions } = setUp(t);
  t.mock.method(axios, "get", async (url: string) => { httpCalls.push(url); throw new Error(`Unexpected request: ${url}`); });
  t.mock.method(OpenAI.Chat.Completions.prototype, "create", async (request: any) => { completions.push(request); throw new Error("Unexpected completion"); });

  const missing = await ask({ text: "Directions to Citibank", coords: null, analytics: analytics("directions") });
  assert.equal(missing.statusCode, 200);
  assert.deepEqual(missing.body, {
    output: "I could not determine your current location, so I will not guess at nearby directions. Check location access and try again.",
    history: [{
      input: "Directions to Citibank",
      output: "I could not determine your current location, so I will not guess at nearby directions. Check location access and try again.",
      data: "Current location was unavailable; no place lookup was attempted.",
    }],
    route: null,
  });

  const vague = await ask({
    text: "Directions to Citibank",
    coords: { ...TIMES_SQUARE, accuracy: 5000 },
    analytics: analytics("directions"),
  });
  assert.equal(vague.statusCode, 200);
  assert.equal(vague.body.output, "Your location is not accurate enough for nearby directions. Enable precise location and try again.");
  assert.equal(vague.body.route, null);

  assert.deepEqual(httpCalls, []);
  assert.deepEqual(completions, []);
  assert.deepEqual(logged.map((row) => [row.success, row.errorCode, row.feature]), [
    [false, "current_location_unavailable", "directions"],
    [false, "current_location_unavailable", "directions"],
  ]);
});

test("a directions Question to a verified nearby place answers from Google without the model", async (t) => {
  const { logged, httpCalls, completions } = setUp(t);
  t.mock.method(axios, "get", async (url: string, options: any) => {
    httpCalls.push(url);
    if (url.includes("nearbysearch")) {
      assert.equal(options.params.keyword, "Citibank");
      return { data: { status: "OK", results: [CITIBANK] } };
    }
    if (url.includes("directions")) {
      assert.equal(options.params.destination, "place_id:citibank");
      assert.equal(options.params.mode, "walking");
      return { data: ROUTE_TO_CITIBANK };
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  t.mock.method(OpenAI.Chat.Completions.prototype, "create", async (request: any) => { completions.push(request); throw new Error("Unexpected completion"); });

  const answer = await ask({ text: "Directions to Citibank", coords: PRECISE_LOCATION, analytics: analytics("directions") });

  assert.equal(answer.statusCode, 200);
  assert.equal(answer.body.output, "Step 1) Head north on Test Street for 141 ft\nDestination: Citibank, 10 Test Street.");
  assert.deepEqual(answer.body.history, [{
    input: "Directions to Citibank",
    output: "Step 1) Head north on Test Street for 141 ft\nDestination: Citibank, 10 Test Street.",
    data: "Verified local route to Citibank.",
  }]);
  assert.deepEqual(answer.body.route, VERIFIED_ROUTE);
  assert.deepEqual(completions, []);
  assert.equal(httpCalls.length, 2);
  assert.deepEqual(logged.map((row) => [row.success, row.toolUsed, row.errorCode]), [
    [true, "verifiedNearbyWalkingDirections", undefined],
  ]);
});

test("a train Question is routed to the live MTA tool and answered by the model", async (t) => {
  const { logged, httpCalls, completions } = setUp(t);
  t.mock.method(axios, "get", async (url: string) => {
    httpCalls.push(url);
    if (url.includes("geocode/json?latlng=40.7559,-73.9871")) {
      return { data: { results: [{ formatted_address: "1560 Broadway, New York, NY" }] } };
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  const fetchCalls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string) => {
    fetchCalls.push(String(url));
    return { ok: false } as Response;
  });
  t.mock.method(OpenAI.Chat.Completions.prototype, "create", async (request: any) => {
    completions.push(request);
    if (request.tools) {
      return {
        choices: [{ message: { content: null, tool_calls: [{
          id: "call-1",
          type: "function",
          function: { name: "generateTrainInformation", arguments: JSON.stringify({ routeId: "a" }) },
        }] } }],
        usage: { total_tokens: 20 },
      };
    }
    return { choices: [{ message: { content: "The A train feed is unavailable right now." } }], usage: { total_tokens: 30 } };
  });

  const answer = await ask({ text: "When is the next A train?", coords: { ...TIMES_SQUARE, heading: 90 }, analytics: analytics("mta") });

  assert.equal(answer.statusCode, 200);
  assert.deepEqual(answer.body, {
    output: "The A train feed is unavailable right now.",
    history: [{
      input: "When is the next A train?",
      output: "The A train feed is unavailable right now.",
      data: "Live MTA Transit Information for line A: Could not connect to the MTA real-time feed right now. Please try again in a moment.",
    }],
    route: null,
  });
  assert.equal(httpCalls.length, 1);
  assert.equal(fetchCalls.length, 1);
  assert.match(fetchCalls[0], /^https:\/\/api-endpoint\.mta\.info\//);

  assert.equal(completions.length, 2);
  const [routing, final] = completions;
  assert.equal(routing.model, "gpt-4o-mini");
  assert.equal(routing.tool_choice, "auto");
  assert.deepEqual(routing.messages[0], { role: "user", content: "When is the next A train?" });
  assert.match(routing.messages[1].content, /The latitude is 40\.7559 and the longitude is -73\.9871\./);

  assert.equal(final.model, "gpt-4o-mini");
  assert.equal(final.temperature, 0.2);
  assert.equal(final.max_tokens, 100);
  const system: string = final.messages[0].content;
  assert.ok(system.startsWith(AIPrompt + trainPrompt + "\n\nRelevant data: "));
  assert.ok(system.includes(
    "Current Address: 1560 Broadway, New York, NY , Heading (Compass Direction): 90\n" +
    "Live MTA Transit Information for line A: Could not connect to the MTA real-time feed right now. Please try again in a moment.\n" +
    "Current Date and Time (Eastern): ",
  ));
  assert.ok(system.endsWith("\n\nChat history: " + formatHistoryForPrompt([])));
  assert.deepEqual(final.messages[1], { role: "user", content: [{ type: "text", text: "When is the next A train?" }] });

  assert.deepEqual(logged.map((row) => [row.success, row.toolUsed, row.tokenCount]), [
    [true, "generateTrainInformation", 30],
  ]);
});

for (const visual of [
  { feature: "photo_qa", frames: ["data:image/jpeg;base64,photo"], prompt: imagePrompt, tool: "imageDescription", maxTokens: 150 },
  { feature: "video_qa", frames: ["data:image/jpeg;base64,one", "data:image/jpeg;base64,two"], prompt: videoPrompt, tool: "videoDescription", maxTokens: 150 },
]) {
  test(`a ${visual.feature} Question sends the attached frames straight to the model`, async (t) => {
    const { logged, httpCalls, completions } = setUp(t);
    t.mock.method(axios, "get", async (url: string) => { httpCalls.push(url); throw new Error(`Unexpected request: ${url}`); });
    t.mock.method(OpenAI.Chat.Completions.prototype, "create", async (request: any) => {
      completions.push(request);
      return { choices: [{ message: { content: "A red door." } }], usage: { total_tokens: 40 } };
    });

    const answer = await ask({
      text: "What is in front of me?",
      image: visual.frames,
      coords: { ...TIMES_SQUARE, heading: 180 },
      analytics: analytics(visual.feature),
    });

    assert.equal(answer.statusCode, 200);
    assert.equal(answer.body.output, "A red door.");
    assert.equal(answer.body.route, null);
    assert.deepEqual(httpCalls, [], "a direct visual Question skips geocoding");
    assert.equal(completions.length, 1, "a direct visual Question skips tool routing");

    const [final] = completions;
    assert.equal(final.max_tokens, visual.maxTokens);
    const system: string = final.messages[0].content;
    assert.ok(system.startsWith(AIPrompt + visual.prompt + "\n\nRelevant data: , Heading (Compass Direction): 180\nCurrent Date and Time (Eastern): "));
    assert.deepEqual(final.messages[1], { role: "user", content: [
      { type: "text", text: "What is in front of me?" },
      ...visual.frames.map((url) => ({ type: "image_url", image_url: { url, detail: "auto" } })),
    ] });

    assert.deepEqual(logged.map((row) => [row.success, row.toolUsed, row.imageCount]), [
      [true, visual.tool, visual.frames.length],
    ]);
  });
}

test("a directions Question with no destination the parser can read is refused before any lookup", async (t) => {
  const { logged } = setUp(t);
  const requests = fakeGoogle(t, {});
  const model = fakeModel(t, [], []);
  const metadata = analytics("directions");
  const text = "Can you help me get there?";

  const res = await ask({ text, coords: PRECISE_LOCATION, analytics: metadata });

  const output = unverifiedDestination("destination");
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { output, history: [{ input: text, output, data: UNVERIFIED_DATA }], route: null });
  assert.deepEqual(requests, []);
  assert.deepEqual(model, { routing: [], final: [] });
  assert.deepEqual(comparable(logged), [{
    ...metadata, inputLength: text.length, hasImage: false, imageCount: 0,
    hasCoords: true, success: false, errorCode: "nearby_destination_not_verified", outputLength: output.length,
  }]);
});

test("a directions Question whose destination Google cannot verify is refused", async (t) => {
  const { logged } = setUp(t);
  const requests = fakeGoogle(t, {
    nearbysearch: { status: "ZERO_RESULTS", results: [] },
    textsearch: { status: "ZERO_RESULTS", results: [] },
  });
  const model = fakeModel(t, [], []);
  const metadata = analytics("directions");
  const text = "Directions to Citibank";

  const res = await ask({ text, coords: PRECISE_LOCATION, analytics: metadata });

  const output = unverifiedDestination("Citibank");
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { output, history: [{ input: text, output, data: UNVERIFIED_DATA }], route: null });
  assert.deepEqual(requests, [NEARBY_SEARCH_FOR_CITIBANK, TEXT_SEARCH_FOR_CITIBANK]);
  assert.deepEqual(model, { routing: [], final: [] });
  assert.deepEqual(comparable(logged), [{
    ...metadata, inputLength: text.length, hasImage: false, imageCount: 0,
    hasCoords: true, success: false, errorCode: "nearby_destination_not_verified", outputLength: output.length,
  }]);
});

test("a directions Question with a photo sends the verified route to the model", async (t) => {
  const { logged } = setUp(t);
  const requests = fakeGoogle(t, {
    nearbysearch: { status: "OK", results: [CITIBANK] },
    directions: ROUTE_TO_CITIBANK,
  });
  const answer = "Citibank is the glass door ahead of you.";
  const model = fakeModel(t, [], [answer]);
  const metadata = analytics("directions");
  const text = "Directions to Citibank";
  const photo = "data:image/jpeg;base64,storefront";

  const res = await ask({ text, image: [photo], coords: PRECISE_LOCATION, analytics: metadata });

  const data = `Directions:\n${CITIBANK_DIRECTIONS}`;
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { output: answer, history: [{ input: text, output: answer, data }], route: VERIFIED_ROUTE });
  assert.deepEqual(requests, [NEARBY_SEARCH_FOR_CITIBANK, DIRECTIONS_TO_CITIBANK]);
  assert.deepEqual(model.routing, []);
  assert.deepEqual(comparable(model.final), [finalRequest(
    AIPrompt + directionsPrompt,
    `\nVerified nearby destination: Citibank, 10 Test Street, approximately 44 meters away.\n${data}`,
    [{ type: "text", text }, { type: "image_url", image_url: { url: photo, detail: "auto" } }],
    280,
  )]);
  assert.deepEqual(comparable(logged), [{
    ...metadata, toolUsed: "verifiedNearbyWalkingDirections",
    inputLength: text.length, hasImage: true, imageCount: 1, hasCoords: true, success: true,
    outputLength: answer.length, tokenCount: 42,
  }]);
});

// A Question the nearby-place parser cannot read reaches tool routing, and the
// directions tool then verifies its destination the same way.
const FALLBACK_DIRECTIONS_QUESTION = "Which way is Citibank from here?";
const DIRECTIONS_TOOL: Route = { tool: "generateGoogleDirectionAPILink", args: { destination: "Citibank", address: false } };

test("a routed directions Question without a location is refused", async (t) => {
  const { logged } = setUp(t);
  const requests = fakeGoogle(t, {});
  const model = fakeModel(t, [DIRECTIONS_TOOL], []);
  const metadata = analytics();
  const text = FALLBACK_DIRECTIONS_QUESTION;

  const res = await ask({ text, coords: null, analytics: metadata });

  const output = unverifiedDestination("Citibank");
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { output, history: [{ input: text, output, data: UNVERIFIED_DATA }], route: null });
  assert.deepEqual(requests, []);
  assert.equal(model.routing.length, 1);
  assert.match(model.routing[0].messages[1].content, /The latitude is 0 and the longitude is 0\./);
  assert.deepEqual(model.final, []);
  // A missing location is replaced with 0,0 before routing, so the row says it had coordinates.
  assert.deepEqual(comparable(logged), [{
    ...metadata, toolUsed: "generateGoogleDirectionAPILink", inputLength: text.length,
    hasImage: false, imageCount: 0, hasCoords: true, success: false,
    errorCode: "nearby_destination_not_verified", outputLength: output.length,
  }]);
});

test("a routed directions Question with an empty destination is refused", async (t) => {
  const { logged } = setUp(t);
  const requests = fakeGoogle(t, { geocode: GEOCODE });
  const model = fakeModel(t, [{ tool: "generateGoogleDirectionAPILink", args: { destination: "  ", address: false } }], []);
  const metadata = analytics();
  const text = FALLBACK_DIRECTIONS_QUESTION;

  const res = await ask({ text, coords: PRECISE_LOCATION, analytics: metadata });

  const output = unverifiedDestination("destination");
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { output, history: [{ input: text, output, data: UNVERIFIED_DATA }], route: null });
  assert.deepEqual(requests, [GEOCODE_TIMES_SQUARE]);
  assert.equal(model.routing.length, 1);
  assert.deepEqual(model.final, []);
  assert.deepEqual(comparable(logged), [{
    ...metadata, toolUsed: "generateGoogleDirectionAPILink", inputLength: text.length,
    hasImage: false, imageCount: 0, hasCoords: true, success: false,
    errorCode: "nearby_destination_not_verified", outputLength: output.length,
  }]);
});

test("a routed directions Question whose destination Google cannot verify is refused", async (t) => {
  const { logged } = setUp(t);
  const requests = fakeGoogle(t, {
    geocode: GEOCODE,
    nearbysearch: { status: "ZERO_RESULTS", results: [] },
    textsearch: { status: "ZERO_RESULTS", results: [] },
  });
  const model = fakeModel(t, [DIRECTIONS_TOOL], []);
  const metadata = analytics();
  const text = FALLBACK_DIRECTIONS_QUESTION;

  const res = await ask({ text, coords: PRECISE_LOCATION, analytics: metadata });

  const output = unverifiedDestination("Citibank");
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { output, history: [{ input: text, output, data: UNVERIFIED_DATA }], route: null });
  assert.deepEqual(requests, [GEOCODE_TIMES_SQUARE, NEARBY_SEARCH_FOR_CITIBANK, TEXT_SEARCH_FOR_CITIBANK]);
  assert.equal(model.routing.length, 1);
  assert.deepEqual(model.final, []);
  assert.deepEqual(comparable(logged), [{
    ...metadata, toolUsed: "generateGoogleDirectionAPILink", inputLength: text.length,
    hasImage: false, imageCount: 0, hasCoords: true, success: false,
    errorCode: "nearby_destination_not_verified", outputLength: output.length,
  }]);
});

test("a routed directions Question to a verified destination answers from Google without the model", async (t) => {
  const { logged } = setUp(t);
  const requests = fakeGoogle(t, {
    geocode: GEOCODE,
    nearbysearch: { status: "OK", results: [CITIBANK] },
    directions: ROUTE_TO_CITIBANK,
  });
  const model = fakeModel(t, [DIRECTIONS_TOOL], []);
  const metadata = analytics();
  const text = FALLBACK_DIRECTIONS_QUESTION;

  const res = await ask({ text, coords: PRECISE_LOCATION, analytics: metadata });

  const output = `${CITIBANK_DIRECTIONS}\nDestination: Citibank, 10 Test Street.`;
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, {
    output,
    history: [{ input: text, output, data: "Verified local route to Citibank." }],
    route: VERIFIED_ROUTE,
  });
  assert.deepEqual(requests, [GEOCODE_TIMES_SQUARE, NEARBY_SEARCH_FOR_CITIBANK, DIRECTIONS_TO_CITIBANK]);
  assert.equal(model.routing.length, 1);
  assert.deepEqual(model.final, []);
  assert.deepEqual(comparable(logged), [{
    ...metadata, toolUsed: "generateGoogleDirectionAPILink", inputLength: text.length,
    hasImage: false, imageCount: 0, hasCoords: true, success: true, outputLength: output.length,
  }]);
});

test("a routed directions Question with a photo adds the Last Meters instruction", async (t) => {
  const { logged } = setUp(t);
  const requests = fakeGoogle(t, {
    geocode: GEOCODE,
    nearbysearch: { status: "OK", results: [CITIBANK] },
    directions: ROUTE_TO_CITIBANK,
  });
  const answer = "Citibank is the glass door ahead of you.";
  const model = fakeModel(t, [DIRECTIONS_TOOL], [answer]);
  const metadata = analytics();
  const text = FALLBACK_DIRECTIONS_QUESTION;
  const photo = "data:image/jpeg;base64,storefront";

  const res = await ask({ text, image: [photo], coords: PRECISE_LOCATION, analytics: metadata });

  const data = `Directions:\n${CITIBANK_DIRECTIONS}`;
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { output: answer, history: [{ input: text, output: answer, data }], route: VERIFIED_ROUTE });
  assert.deepEqual(requests, [GEOCODE_TIMES_SQUARE, NEARBY_SEARCH_FOR_CITIBANK, DIRECTIONS_TO_CITIBANK]);
  assert.equal(model.routing.length, 1);
  assert.deepEqual(comparable(model.final), [finalRequest(
    AIPrompt + directionsPrompt + LAST_METERS_INSTRUCTION,
    `Current Address: ${ADDRESS} \nVerified nearby destination: Citibank, 10 Test Street, approximately 44 meters away.\n${data}`,
    [{ type: "text", text }, { type: "image_url", image_url: { url: photo, detail: "auto" } }],
  )]);
  assert.deepEqual(comparable(logged), [{
    ...metadata, toolUsed: "generateGoogleDirectionAPILink", inputLength: text.length,
    hasImage: true, imageCount: 1, hasCoords: true, success: true, outputLength: answer.length, tokenCount: 42,
  }]);
});

/**
 * Ask a Question routed to `route` from Times Square and check the answer, the
 * final model request, and the log row. `relevantData` is everything after the
 * current address in the system message's relevant data.
 */
async function askRoutedQuestion(
  t: TestContext,
  { text, route, google = {}, image, prompt, relevantData, data = "", userContent = [] }: {
    text: string;
    route: Route;
    google?: Record<string, unknown>;
    image?: string[];
    prompt: string;
    relevantData: string;
    /** The data the Question's history entry records. */
    data?: string;
    /** User content after the Question's text and attached images. */
    userContent?: object[];
  },
) {
  const { logged } = setUp(t);
  const requests = fakeGoogle(t, { geocode: GEOCODE, ...google });
  const answer = "Here is what I found.";
  const model = fakeModel(t, [route], [answer]);
  const metadata = analytics();

  const res = await ask({ text, image, coords: PRECISE_LOCATION, analytics: metadata });

  const images = (image ?? []).map((url) => ({ type: "image_url", image_url: { url, detail: "auto" } }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { output: answer, history: [{ input: text, output: answer, data }], route: null });
  assert.equal(model.routing.length, 1);
  assert.deepEqual(comparable(model.final), [finalRequest(
    prompt,
    `Current Address: ${ADDRESS} ${relevantData}`,
    [{ type: "text", text }, ...images, ...userContent],
  )]);
  assert.deepEqual(comparable(logged), [{
    ...metadata,
    ...(route instanceof Error || route === "no tool" ? {} : { toolUsed: route.tool }),
    inputLength: text.length, hasImage: images.length > 0, imageCount: images.length, hasCoords: true,
    success: true, outputLength: answer.length, tokenCount: 42,
  }]);
  assert.deepEqual(requests[0], GEOCODE_TIMES_SQUARE);
  return { requests: requests.slice(1), answer };
}

const PHARMACIES = [
  { name: "Duane Reade", geometry: { location: { lat: 40.7565, lng: -73.9866 } }, rating: 4.1, vicinity: "1627 Broadway", opening_hours: { open_now: true } },
  { name: "CVS Pharmacy", geometry: { location: { lat: 40.757, lng: -73.986 } }, rating: 3.8, vicinity: "1633 Broadway", opening_hours: { open_now: false } },
  { name: "Walgreens", geometry: { location: { lat: 40.7575, lng: -73.9855 } }, rating: 4, vicinity: "1471 Broadway" },
];
const PHARMACY_LINK =
  "https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=40.7559,-73.9871&rankby=distance&type=pharmacy";
const PHARMACY_TOOL: Route = { tool: "generateGoogleAPILinkNonSpecificLocation", args: { link: PHARMACY_LINK } };

test("a nearby places link sends Google's list, with open-now text, to the model", async (t) => {
  const places =
    "\n{name: Duane Reade, location(lat,lng): 40.7565,-73.9866, address: 1627 Broadway, rating: 4.1 stars, Google Maps lists it as open now}, " +
    "\n{name: CVS Pharmacy, location(lat,lng): 40.757,-73.986, address: 1633 Broadway, rating: 3.8 stars, Google Maps lists it as closed now}, " +
    "\n{name: Walgreens, location(lat,lng): 40.7575,-73.9855, address: 1471 Broadway, rating: 4 stars}";
  const { requests } = await askRoutedQuestion(t, {
    text: "Is there a pharmacy around here?",
    route: PHARMACY_TOOL,
    google: { nearbysearch: { status: "OK", results: PHARMACIES } },
    prompt: AIPrompt + nearbyPlacesPrompt,
    relevantData: `\nNearby Places in order of nearest distance: ${places}`,
    data: places,
  });
  assert.deepEqual(requests, [{ url: `${PHARMACY_LINK}&key=${GOOGLE_KEY}` }]);
});

const JOES_PIZZA = { place_id: "joes-pizza", name: "Joe's Pizza", formatted_address: "1435 Broadway, New York, NY 10018, USA" };
const JOES_PIZZA_JSON = [
  "{",
  '  "place_id": "joes-pizza",',
  '  "name": "Joe\'s Pizza",',
  '  "formatted_address": "1435 Broadway, New York, NY 10018, USA"',
  "}",
].join("\n");
const BIASED_JOES_PIZZA_LINK =
  "https://maps.googleapis.com/maps/api/place/findplacefromtext/json?fields=place_id%2Cname%2Copening_hours" +
  "&inputtype=textquery&input=Joe%27s%20Pizza&locationbias=circle:2000@40.7559,-73.9871";
const JOES_PIZZA_HOURS_LOOKUP = {
  url: "https://maps.googleapis.com/maps/api/place/details/json",
  params: { place_id: "joes-pizza", fields: "name,business_status,opening_hours,current_opening_hours,utc_offset", key: GOOGLE_KEY },
};

test("a Find Place link sends the place and its computed opening status to the model", async (t) => {
  // Tuesday at noon in New York.
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const { requests } = await askRoutedQuestion(t, {
    text: "Is Joe's Pizza open right now?",
    route: { tool: "generateGooglePlacesApiLinkSpecificLocation", args: { link: BIASED_JOES_PIZZA_LINK, operatingHours: true } },
    google: {
      findplacefromtext: { status: "OK", candidates: [JOES_PIZZA] },
      details: { status: "OK", result: {
        name: "Joe's Pizza",
        utc_offset: -240,
        opening_hours: {
          open_now: true,
          periods: [{ open: { day: 2, time: "1100" }, close: { day: 2, time: "2200" } }],
          weekday_text: ["Monday: Closed", "Tuesday: 11:00 AM - 10:00 PM", "Wednesday: Closed", "Thursday: Closed", "Friday: Closed", "Saturday: Closed", "Sunday: Closed"],
        },
      } },
    },
    prompt: AIPrompt + nearbyPlacesPrompt,
    relevantData:
      `Relevant Place Information: ${JOES_PIZZA_JSON}\n` +
      "Opening status computed from Google Maps hours. Repeat it as written and do not recalculate open or closed yourself: " +
      "Google Maps lists Joe's Pizza as open right now (it is 12:00 PM there). It closes today at 10:00 PM. " +
      "Today's listed hours: Tuesday: 11:00 AM - 10:00 PM.\n",
  });
  assert.deepEqual(requests, [{ url: `${BIASED_JOES_PIZZA_LINK}&key=${GOOGLE_KEY}` }, JOES_PIZZA_HOURS_LOOKUP]);
});

test("a Find Place link whose hours lookup fails says the hours are not available", async (t) => {
  const { requests } = await askRoutedQuestion(t, {
    text: "Is Joe's Pizza open right now?",
    route: { tool: "generateGooglePlacesApiLinkSpecificLocation", args: { link: BIASED_JOES_PIZZA_LINK, operatingHours: true } },
    google: {
      findplacefromtext: { status: "OK", candidates: [JOES_PIZZA] },
      details: new Error("timeout of 20000ms exceeded"),
    },
    prompt: AIPrompt + nearbyPlacesPrompt,
    relevantData: `Relevant Place Information: ${JOES_PIZZA_JSON}\nOperating Hours: Not available\n`,
  });
  assert.deepEqual(requests, [{ url: `${BIASED_JOES_PIZZA_LINK}&key=${GOOGLE_KEY}` }, JOES_PIZZA_HOURS_LOOKUP]);
});

test("a Find Place link without a location bias is kept within 5 km of the user", async (t) => {
  const link = "https://maps.googleapis.com/maps/api/place/findplacefromtext/json?fields=name&inputtype=textquery&input=Joe%27s%20Pizza";
  const { requests } = await askRoutedQuestion(t, {
    text: "Tell me about Joe's Pizza.",
    route: { tool: "generateGooglePlacesApiLinkSpecificLocation", args: { link, operatingHours: false } },
    google: { findplacefromtext: { status: "OK", candidates: [{ name: "Joe's Pizza" }] } },
    prompt: AIPrompt + nearbyPlacesPrompt,
    relevantData: 'Relevant Place Information: {\n  "name": "Joe\'s Pizza"\n}\nOperating Hours: Not available\n',
  });
  assert.deepEqual(requests, [{ url: `${link}&locationbias=circle:5000@40.7559,-73.9871&key=${GOOGLE_KEY}` }]);
});

test("a distance link sends Google's walking distance and time to the model", async (t) => {
  const link =
    "https://maps.googleapis.com/maps/api/distancematrix/json?departure_time=now&destinations=Bryant%20Park" +
    "&origins=40.7559,-73.9871&mode=walking";
  const { requests } = await askRoutedQuestion(t, {
    text: "How far is Bryant Park?",
    route: { tool: "generateGoogleDistanceMatrixAPILink", args: { link } },
    google: { distancematrix: { status: "OK", rows: [{ elements: [{
      distance: { text: "0.5 mi", value: 805 },
      duration: { text: "10 mins", value: 600 },
    }] }] } },
    prompt: AIPrompt,
    relevantData: "Distance in miles: 0.50020285, How long it will take to walk: 10 mins",
    data: "distance: 805, duration: 10 mins",
  });
  assert.deepEqual(requests, [{ url: `${link}&key=${GOOGLE_KEY}` }]);
});

test("a cross streets Question sends a low-detail static map to the model", async (t) => {
  const link = "https://maps.googleapis.com/maps/api/staticmap?center=40.7559,-73.9871&zoom=18&size=640x640";
  const { requests } = await askRoutedQuestion(t, {
    text: "What are the cross streets here?",
    route: { tool: "getCrossStreets", args: { link } },
    prompt: AIPrompt + crossStreetsPrompt,
    relevantData: "",
    userContent: [{ type: "image_url", image_url: { url: `${link}&key=${GOOGLE_KEY}`, detail: "low" } }],
  });
  assert.deepEqual(requests, []);
});

const ENTRANCE_QUESTION = "What does the entrance at 123 West 43rd Street look like?";
const DOORFRONT_TOOL: Route = { tool: "useDoorfrontAPI", args: { address: "123 West 43rd Street" } };
const ENTRANCE_ADDRESS = "123 W 43rd St, New York, NY 10036, USA";
const ENTRANCE_LOOKUP = {
  findplacefromtext: { status: "OK", candidates: [{ name: "123 West 43rd Street", formatted_address: ENTRANCE_ADDRESS }] },
};
const ENTRANCE_LOOKUP_REQUEST = { url:
  "https://maps.googleapis.com/maps/api/place/findplacefromtext/json?location=\n            40.7559,-73.9871" +
  `&fields=formatted_address%2Cname%2Cgeometry&inputtype=textquery&input=123%2CWest%2C43rd%2CStreet&key=${GOOGLE_KEY}` };
/** The Doorfront lookup for ENTRANCE_ADDRESS, with ordinals stripped from the place name. */
const DOORFRONT_FIND = {
  db: "myFirstDatabase",
  collection: "collect_panorama",
  findOne: [
    { address: { $regex: "123 West 43 Street", $options: "i" } },
    { projection: { url: 1, human_labels: { $slice: 1 }, creator: 1, address: 1, location: 1, image_description: 1 } },
  ],
};

test("an entrance Question sends the Doorfront panorama and its labels, then saves the answer to Doorfront", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const doorfront = fakeDoorfront(t, {
    _id: new ObjectId("64b000000000000000000001"),
    url: "https://doorfront.test/pano.jpg",
    address: "123 West 43 Street",
    location: { lat: 40.7561, lng: -73.985 },
    human_labels: [{ labels: [
      { label: "door", subtype: 2, box: { x: 10, y: 20, width: 30, height: 40 } },
      { label: "handle", box: { x: 15, y: 25, width: 5, height: 5 } },
    ] }],
  });
  const labels =
    `Entrance Information and Features for ${ENTRANCE_ADDRESS}:` +
    "\ndoor (2), Bounding Box: x = 10, y = 20, width: 30, height: 40; " +
    "\nhandle (exists), Bounding Box: x = 15, y = 25, width: 5, height: 5";
  const { requests, answer } = await askRoutedQuestion(t, {
    text: ENTRANCE_QUESTION,
    route: DOORFRONT_TOOL,
    google: ENTRANCE_LOOKUP,
    prompt: AIPrompt + entrancePrompt,
    relevantData: `\n${labels}`,
    data: labels,
    userContent: [{ type: "image_url", image_url: { url: "https://doorfront.test/pano.jpg", detail: "high" } }],
  });
  assert.deepEqual(requests, [ENTRANCE_LOOKUP_REQUEST]);
  // Compared without `comparable` so the write must use an ObjectId and a Date, as Mongo needs.
  assert.deepEqual(doorfront, [DOORFRONT_FIND, {
    db: "myFirstDatabase",
    collection: "collect_panorama",
    updateOne: [
      { _id: new ObjectId("64b000000000000000000001") },
      { $set: { image_description: answer, updatedAt: new Date(NOW) } },
    ],
  }]);
});

test("an entrance Question uses the description Doorfront already has", async (t) => {
  const description = "Image Description: A glass door with a push bar on the right.";
  const doorfront = fakeDoorfront(t, {
    _id: new ObjectId("64b000000000000000000002"),
    url: "https://doorfront.test/pano.jpg",
    address: "123 West 43 Street",
    image_description: "A glass door with a push bar on the right.",
  });
  const { requests } = await askRoutedQuestion(t, {
    text: ENTRANCE_QUESTION,
    route: DOORFRONT_TOOL,
    google: ENTRANCE_LOOKUP,
    prompt: AIPrompt + entrancePrompt,
    relevantData: `\n${description}`,
    data: description,
  });
  assert.deepEqual(requests, [ENTRANCE_LOOKUP_REQUEST]);
  assert.deepEqual(comparable(doorfront), [DOORFRONT_FIND]);
});

test("an entrance Question without Doorfront data sends a Street View image instead", async (t) => {
  const doorfront = fakeDoorfront(t, null);
  const fetches: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string) => {
    fetches.push(String(url));
    const data = String(url).includes("/streetview/metadata")
      ? { status: "OK", pano_id: "pano-1", copyright: "© Google", location: { lat: 40.756, lng: -73.985 } }
      : { status: "OK", results: [{ geometry: { location: { lat: 40.7561, lng: -73.985 } } }] };
    return { json: async () => data } as Response;
  });
  const streetView =
    "https://maps.googleapis.com/maps/api/streetview?size=640x480&pano=pano-1&heading=0.00&fov=80&pitch=0" +
    `&source=outdoor&return_error_code=true&key=${GOOGLE_KEY}`;
  const notCollected =
    "Data on this address has not been collected yet by volunteers. Use the street view image to describe the " +
    "entrance features visible from street view. Let the user know this data is not validated by real users and may not be correct." +
    "\n             When describing this image, provide a confidence level (1 to 5) for your description of the entrance " +
    "based on how clear the image is.";
  const { requests } = await askRoutedQuestion(t, {
    text: ENTRANCE_QUESTION,
    route: DOORFRONT_TOOL,
    google: ENTRANCE_LOOKUP,
    prompt: AIPrompt + entrancePrompt,
    relevantData: `\n${notCollected}`,
    data: notCollected,
    userContent: [{ type: "image_url", image_url: { url: streetView, detail: "high" } }],
  });
  assert.deepEqual(requests, [ENTRANCE_LOOKUP_REQUEST]);
  assert.deepEqual(comparable(doorfront), [DOORFRONT_FIND]);
  assert.deepEqual(fetches, [
    `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(ENTRANCE_ADDRESS)}&key=${GOOGLE_KEY}`,
    `https://maps.googleapis.com/maps/api/streetview/metadata?location=40.7561,-73.985&source=outdoor&key=${GOOGLE_KEY}`,
  ]);
});

test("a nearby features Question counts the trees, sidewalk materials, and ramps around the user", async (t) => {
  const point = (lng: number, lat: number) => ({ location: { type: "Point", coordinates: [lng, lat] } });
  const finds: object[] = [];
  const fakeFind = (collection: string, docs: object[]) => async (...args: unknown[]) => {
    finds.push({ collection, find: args });
    return docs;
  };
  t.mock.method(TreeModel, "find", fakeFind("trees", [point(-73.987, 40.756)]) as any);
  t.mock.method(SidewalkMaterialModel, "find", fakeFind("sidewalk_material", [
    { ...point(-73.9872, 40.7558), material: "Tactile" },
    { ...point(-73.9869, 40.7561), material: "manhole" },
  ]) as any);
  t.mock.method(PedestrianRampModel, "find", fakeFind("pedestrian_ramps", [point(-73.9873, 40.7557)]) as any);
  const features = "Nearby Features for location (40.7559, -73.9871):\nTrees: 1, Sidewalk Materials: 2, Pedestrian Ramps: 1";

  const { requests } = await askRoutedQuestion(t, {
    text: "Are there curb ramps around me?",
    route: { tool: "getNearbyFeatures", args: {} },
    prompt: AIPrompt,
    relevantData: `\n${features}`,
    data: features,
  });

  assert.deepEqual(requests, []);
  const within = { location: { $geoWithin: { $centerSphere: [[-73.9871, 40.7559], 0.06 / 3963.2] } } };
  assert.deepEqual(finds, [
    { collection: "trees", find: [within, { _id: 0, location: 1 }] },
    { collection: "sidewalk_material", find: [within, { _id: 0, location: 1, material: 1 }] },
    { collection: "pedestrian_ramps", find: [within, { _id: 0, location: 1 }] },
  ]);
});

// When routing fails, picks no tool, or the tool throws, the Question is still
// answered by the model, without that tool's data.
const NEIGHBORHOOD_QUESTION = "What is this neighborhood like?";

test("a Question whose routing call fails is answered without tool data", async (t) => {
  const { requests } = await askRoutedQuestion(t, {
    text: NEIGHBORHOOD_QUESTION,
    route: new Error("routing unavailable"),
    prompt: AIPrompt,
    relevantData: "",
  });
  assert.deepEqual(requests, []);
});

test("a Question routed to no tool is answered without tool data", async (t) => {
  const { requests } = await askRoutedQuestion(t, {
    text: NEIGHBORHOOD_QUESTION,
    route: "no tool",
    prompt: AIPrompt,
    relevantData: "",
  });
  assert.deepEqual(requests, []);
});

test("a Question whose tool throws is answered without that tool's data", async (t) => {
  const { requests } = await askRoutedQuestion(t, {
    text: "Is there a pharmacy around here?",
    route: PHARMACY_TOOL,
    google: { nearbysearch: new Error("socket hang up") },
    prompt: AIPrompt,
    relevantData: "",
  });
  assert.deepEqual(requests, [{ url: `${PHARMACY_LINK}&key=${GOOGLE_KEY}` }]);
});

test("a Question routed to the image tool adds the image prompt", async (t) => {
  const { requests } = await askRoutedQuestion(t, {
    text: "What does this sign say?",
    image: ["data:image/jpeg;base64,sign"],
    route: { tool: "imageDescription" },
    prompt: AIPrompt + imagePrompt,
    relevantData: "",
  });
  assert.deepEqual(requests, []);
});

test("a Question routed to the video tool adds the video prompt", async (t) => {
  const { requests } = await askRoutedQuestion(t, {
    text: "What happened in this clip?",
    image: ["data:image/jpeg;base64,one", "data:image/jpeg;base64,two"],
    route: { tool: "videoDescription" },
    prompt: AIPrompt + videoPrompt,
    relevantData: "",
  });
  assert.deepEqual(requests, []);
});

test("a Question routed to the history tool is answered from the chat history", async (t) => {
  const { logged } = setUp(t);
  fakeGoogle(t, { geocode: GEOCODE });
  const first = "A busy part of Midtown.";
  const second = "You asked what this neighborhood is like.";
  const model = fakeModel(t, ["no tool", { tool: "historyQuery" }], [first, second]);
  const metadata = analytics();
  const text = "What did I just ask you?";

  await ask({ text: NEIGHBORHOOD_QUESTION, coords: PRECISE_LOCATION, analytics: metadata });
  const res = await ask({ text, coords: PRECISE_LOCATION, analytics: metadata });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, {
    output: second,
    history: [
      { input: NEIGHBORHOOD_QUESTION, output: first, data: "" },
      { input: text, output: second, data: "" },
    ],
    route: null,
  });
  assert.deepEqual(comparable(model.final[1]), finalRequest(
    AIPrompt,
    `Current Address: ${ADDRESS} `,
    [{ type: "text", text }],
    120,
    `User Input: ${NEIGHBORHOOD_QUESTION}, AI Output: ${first}, Data Used: `,
  ));
  assert.deepEqual(comparable(logged[1]), {
    ...metadata, toolUsed: "historyQuery", inputLength: text.length, hasImage: false, imageCount: 0,
    hasCoords: true, success: true, outputLength: second.length, tokenCount: 42,
  });
});

test("a Question's system message carries the current address, compass heading, and orientation", async (t) => {
  const { logged } = setUp(t);
  const requests = fakeGoogle(t, { geocode: GEOCODE });
  const answer = "You are facing west on Broadway.";
  const model = fakeModel(t, ["no tool"], [answer]);
  const metadata = analytics();
  const text = "Which way am I facing?";

  const res = await ask({
    text,
    coords: { ...TIMES_SQUARE, accuracy: 10, heading: 270, orientation: { alpha: 10, beta: 20, gamma: 30 } },
    analytics: metadata,
  });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { output: answer, history: [{ input: text, output: answer, data: "" }], route: null });
  assert.deepEqual(requests, [GEOCODE_TIMES_SQUARE]);
  assert.deepEqual(comparable(model.final), [finalRequest(
    AIPrompt,
    `Current Address: ${ADDRESS} , Heading (Compass Direction): 270, Orientation - Alpha: 10, Beta: 20, Gamma: 30`,
    [{ type: "text", text }],
  )]);
  assert.deepEqual(comparable(logged), [{
    ...metadata, inputLength: text.length, hasImage: false, imageCount: 0, hasCoords: true,
    success: true, outputLength: answer.length, tokenCount: 42,
  }]);
});

test("a Question whose final model call fails answers 500", async (t) => {
  const { logged } = setUp(t);
  const requests = fakeGoogle(t, { geocode: GEOCODE });
  const model = fakeModel(t, ["no tool"], [new Error("model unavailable")]);
  const metadata = analytics();
  const text = NEIGHBORHOOD_QUESTION;

  const res = await ask({ text, coords: PRECISE_LOCATION, analytics: metadata });

  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, { error: "Error processing your request: model unavailable" });
  assert.deepEqual(requests, [GEOCODE_TIMES_SQUARE]);
  assert.deepEqual(comparable(model.final), [finalRequest(AIPrompt, `Current Address: ${ADDRESS} `, [{ type: "text", text }])]);
  assert.deepEqual(comparable(logged), [{
    ...metadata, inputLength: text.length, hasImage: false, imageCount: 0, hasCoords: true,
    success: false, errorCode: "openai_error",
  }]);
});

test("text to speech returns the model's MP3 bytes", async (t) => {
  setUp(t);
  const speechCalls: any[] = [];
  const mp3 = Buffer.from("fake-mp3-bytes");
  t.mock.method(OpenAI.Audio.Speech.prototype, "create", async (request: any) => {
    speechCalls.push(request);
    return { arrayBuffer: async () => mp3.buffer.slice(mp3.byteOffset, mp3.byteOffset + mp3.byteLength) };
  });

  const res = fakeResponse();
  await new OpenAIQuestionService().audioRequest({ res } as any, "Turn left.");

  assert.deepEqual(speechCalls, [{ model: "tts-1", voice: "echo", input: "Turn left." }]);
  assert.equal(res.contentTypeValue, "audio/mpeg");
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.sent, mp3);
});
