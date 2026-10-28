import "./doorfrontUri";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import axios from "axios";
import { verifiedWalkingDirections, visualEvidence } from "../../server/services/questionEvidence";
import { QuestionReply } from "../../server/services/questionReply";
import { readQuestionRequest } from "../../server/services/questionRequest";
import { aiRequestLogService } from "../../server/services/aiRequestLog";
import { directionsPrompt, imagePrompt, videoPrompt, type textRequestBody } from "../../server/types";
import { setTestEnv } from "./testEnv";

const GOOGLE_KEY = "evidence-test-google";
const TIMES_SQUARE = { latitude: 40.7559, longitude: -73.9871, accuracy: 10 };
const PHOTO = "data:image/jpeg;base64,storefront";

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
const VERIFIED_DIRECTIONS_DATA = `Directions:\n${CITIBANK_DIRECTIONS}`;
const VERIFIED_DIRECTIONS_RELEVANT_DATA =
  `\nVerified nearby destination: Citibank, 10 Test Street, approximately 44 meters away.\n${VERIFIED_DIRECTIONS_DATA}`;
const FOUND_CITIBANK = { nearbysearch: { status: "OK", results: [CITIBANK] }, directions: ROUTE_TO_CITIBANK };
const NOT_FOUND = { nearbysearch: { status: "ZERO_RESULTS", results: [] }, textsearch: { status: "ZERO_RESULTS", results: [] } };
const UNVERIFIED_DATA = "Nearby destination lookup failed; no unverified location was used.";
let installCounter = 0;

/**
 * Fake Google over axios, answering by endpoint ("nearbysearch", "directions", ...).
 * Returns the endpoints requested.
 */
function fakeGoogle(t: TestContext, replies: Record<string, unknown>) {
  setTestEnv(t, { GOOGLE_MAPS_API_KEY: GOOGLE_KEY });
  const endpoints: string[] = [];
  t.mock.method(axios, "get", async (url: string) => {
    const endpoint = new URL(url).pathname.split("/").at(-2)!;
    endpoints.push(endpoint);
    if (!(endpoint in replies)) throw new Error(`Unexpected request: ${url}`);
    const reply = replies[endpoint];
    if (reply instanceof Error) throw reply;
    return { data: reply };
  });
  return endpoints;
}

/**
 * A Question's request and reply, with the log rows its reply writes. Each has
 * its own install, so its history starts empty.
 */
function question(t: TestContext, content: Partial<textRequestBody> = {}) {
  const logged: any[] = [];
  t.mock.method(aiRequestLogService, "record", async (row: any) => { logged.push(row); });
  installCounter++;
  const body: textRequestBody = {
    text: "Directions to Citibank",
    coords: TIMES_SQUARE,
    analytics: { installId: `evidence-test-${installCounter}` },
    ...content,
  };
  const request = readQuestionRequest(body);
  return { request, reply: new QuestionReply(body, request), logged };
}

test("a photo Question is answered with the image prompt", () => {
  assert.deepEqual(visualEvidence("photo"), { prompt: imagePrompt, toolUsed: "imageDescription" });
});

test("a video Question is answered with the video prompt", () => {
  assert.deepEqual(visualEvidence("video"), { prompt: videoPrompt, toolUsed: "videoDescription" });
});

function unverified(label: string) {
  const output = `I could not verify a nearby ${label} from your current location. Try a more specific name or street address.`;
  return { status: 200, body: { output, history: [{ input: "Directions to Citibank", output, data: UNVERIFIED_DATA }], route: null } };
}

test("verified directions without frames answer without the model", async (t) => {
  fakeGoogle(t, FOUND_CITIBANK);
  const { request, reply, logged } = question(t);

  const result = await verifiedWalkingDirections({ path: "up front", destination: "Citibank", request, reply });

  const output = `${CITIBANK_DIRECTIONS}\nDestination: Citibank, 10 Test Street.`;
  assert.deepEqual(result, { status: 200, body: {
    output,
    history: [{ input: "Directions to Citibank", output, data: "Verified local route to Citibank." }],
    route: VERIFIED_ROUTE,
  } });
  assert.deepEqual(logged.map((row) => [row.success, row.toolUsed]), [[true, "verifiedNearbyWalkingDirections"]]);
});

test("verified directions with a photo give the model the route", async (t) => {
  const endpoints = fakeGoogle(t, FOUND_CITIBANK);
  const { request, reply, logged } = question(t, { image: [PHOTO] });

  const evidence = await verifiedWalkingDirections({ path: "up front", destination: "Citibank", request, reply });

  assert.deepEqual(evidence, {
    prompt: directionsPrompt,
    relevantData: VERIFIED_DIRECTIONS_RELEVANT_DATA,
    data: VERIFIED_DIRECTIONS_DATA,
    route: VERIFIED_ROUTE,
    toolUsed: "verifiedNearbyWalkingDirections",
  });
  assert.deepEqual(endpoints, ["nearbysearch", "directions"]);
  assert.deepEqual(logged, []);
});

test("verified directions with no destination are refused before any lookup", async (t) => {
  const endpoints = fakeGoogle(t, {});
  const { request, reply, logged } = question(t);

  const result = await verifiedWalkingDirections({ path: "up front", destination: null, request, reply });

  assert.deepEqual(result, unverified("destination"));
  assert.deepEqual(endpoints, []);
  assert.deepEqual(logged.map((row) => [row.errorCode, row.toolUsed]), [["nearby_destination_not_verified", undefined]]);
});

test("verified directions to a destination Google cannot verify are refused", async (t) => {
  fakeGoogle(t, NOT_FOUND);
  const { request, reply, logged } = question(t, { image: [PHOTO] });

  const result = await verifiedWalkingDirections({ path: "up front", destination: "Citibank", request, reply });

  assert.deepEqual(result, unverified("Citibank"));
  assert.deepEqual(logged.map((row) => [row.errorCode, row.toolUsed]), [["nearby_destination_not_verified", undefined]]);
});

test("verified directions after tool routing log the directions tool", async (t) => {
  fakeGoogle(t, FOUND_CITIBANK);
  const { request, reply } = question(t, { image: [PHOTO] });

  const evidence = await verifiedWalkingDirections({ path: "after routing", destination: "Citibank", request, reply });

  assert.deepEqual(evidence, {
    prompt: directionsPrompt,
    relevantData: VERIFIED_DIRECTIONS_RELEVANT_DATA,
    data: VERIFIED_DIRECTIONS_DATA,
    route: VERIFIED_ROUTE,
    toolUsed: "generateGoogleDirectionAPILink",
  });
});

test("verified directions after tool routing log the directions tool when refused", async (t) => {
  fakeGoogle(t, NOT_FOUND);
  const { request, reply, logged } = question(t);

  const result = await verifiedWalkingDirections({ path: "after routing", destination: "Citibank", request, reply });

  assert.deepEqual(result, unverified("Citibank"));
  assert.deepEqual(logged.map((row) => [row.errorCode, row.toolUsed]), [
    ["nearby_destination_not_verified", "generateGoogleDirectionAPILink"],
  ]);
});

test("verified directions without a location are refused before any lookup", async (t) => {
  const endpoints = fakeGoogle(t, {});
  const { request, reply } = question(t, { coords: null });

  const result = await verifiedWalkingDirections({ path: "after routing", destination: "Citibank", request, reply });

  assert.deepEqual(result, unverified("Citibank"));
  assert.deepEqual(endpoints, []);
});
