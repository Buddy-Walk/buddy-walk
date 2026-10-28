import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { QuestionReply } from "../../server/services/questionReply";
import { readQuestionRequest } from "../../server/services/questionRequest";
import { aiRequestLogService } from "../../server/services/aiRequestLog";
import type { textRequestBody } from "../../server/types";

const TIMES_SQUARE = { latitude: 40.7559, longitude: -73.9871 };
let installCounter = 0;

/** Starts a reply for `content`, catching the log rows it writes. */
function startReply(t: TestContext, content: Omit<textRequestBody, "analytics">) {
  installCounter++;
  const analytics = {
    requestId: `reply-request-${installCounter}`,
    installId: `reply-test-${installCounter}`,
    sessionId: "reply-session",
    platform: "ios",
    appVersion: "1.0.0",
    feature: "directions",
  };
  const logged: any[] = [];
  t.mock.method(aiRequestLogService, "record", async (row: any) => { logged.push(row); });
  const question = { ...content, analytics };
  return { reply: new QuestionReply(question, readQuestionRequest(question)), logged, analytics };
}

/** The log row fields every Question's row copies from its request. */
function rowFor(analytics: object, text: string) {
  return { ...analytics, inputLength: text.length, hasImage: false, imageCount: 0 };
}

test("a Question without a location is refused, and its log row says it had none", async (t) => {
  const text = "Directions to Citibank";
  const { reply, logged, analytics } = startReply(t, { text, coords: null });

  const result = await reply.locationUnavailable();

  const output =
    "I could not determine your current location, so I will not guess at nearby directions. Check location access and try again.";
  const history = [{ input: text, output, data: "Current location was unavailable; no place lookup was attempted." }];
  assert.deepEqual(result, { status: 200, body: { output, history, route: null } });
  assert.deepEqual(logged.map(({ latencyMs, ...row }) => row), [{
    ...rowFor(analytics, text), toolUsed: undefined, hasCoords: false, success: false,
    errorCode: "current_location_unavailable", outputLength: output.length, tokenCount: undefined,
  }]);
});

test("a Question with an inaccurate location is refused, and its log row says it had one", async (t) => {
  const text = "Directions to Citibank";
  const { reply, logged } = startReply(t, { text, coords: { ...TIMES_SQUARE, accuracy: 5000 } });

  const result = await reply.locationUnavailable();

  const output = "Your location is not accurate enough for nearby directions. Enable precise location and try again.";
  assert.deepEqual(result.body, {
    output,
    history: [{ input: text, output, data: "Current location was unavailable; no place lookup was attempted." }],
    route: null,
  });
  assert.deepEqual(logged.map((row) => [row.hasCoords, row.errorCode]), [[true, "current_location_unavailable"]]);
});

test("a Question whose destination is not verified is refused with the tool that looked for it, logged as having a location", async (t) => {
  const text = "Which way is Citibank from here?";
  const { reply, logged, analytics } = startReply(t, { text, coords: null });

  const result = await reply.destinationNotVerified("Citibank", "generateGoogleDirectionAPILink");

  const output = "I could not verify a nearby Citibank from your current location. Try a more specific name or street address.";
  const history = [{ input: text, output, data: "Nearby destination lookup failed; no unverified location was used." }];
  assert.deepEqual(result, { status: 200, body: { output, history, route: null } });
  assert.deepEqual(logged.map(({ latencyMs, ...row }) => row), [{
    ...rowFor(analytics, text), toolUsed: "generateGoogleDirectionAPILink", hasCoords: true, success: false,
    errorCode: "nearby_destination_not_verified", outputLength: output.length, tokenCount: undefined,
  }]);
});

const ROUTE = {
  destination: { name: "Citibank", address: "10 Test Street", lat: 40.7563, lng: -73.9871 },
  origin: { lat: 40.7559, lng: -73.9871 },
  totalDistance: { text: "141 ft", value: 43 },
  totalDuration: { text: "1 min", value: 30 },
  steps: [],
  polyline: "abc",
  travelMode: "WALKING",
};

test("verified walking directions are answered without the model, with the route", async (t) => {
  const text = "Directions to Citibank";
  const { reply, logged, analytics } = startReply(t, { text, coords: TIMES_SQUARE });

  const result = await reply.verifiedDirections({
    placeName: "Citibank",
    placeAddress: "10 Test Street",
    directionsText: "Step 1) Head north on Test Street for 141 ft",
    distanceMeters: 44,
    route: ROUTE,
  }, "verifiedNearbyWalkingDirections");

  const output = "Step 1) Head north on Test Street for 141 ft\nDestination: Citibank, 10 Test Street.";
  const history = [{ input: text, output, data: "Verified local route to Citibank." }];
  assert.deepEqual(result, { status: 200, body: { output, history, route: ROUTE } });
  assert.deepEqual(logged.map(({ latencyMs, ...row }) => row), [{
    ...rowFor(analytics, text), toolUsed: "verifiedNearbyWalkingDirections", hasCoords: true, success: true,
    errorCode: undefined, outputLength: output.length, tokenCount: undefined,
  }]);
});

test("the model's answer is sent with the data it used, the route, and its token count", async (t) => {
  const text = "Directions to Citibank";
  const { reply, logged, analytics } = startReply(t, { text, image: ["data:storefront"], coords: TIMES_SQUARE });

  const result = await reply.modelAnswer({
    output: "Citibank is the glass door ahead of you.",
    data: "Directions:\nStep 1) Head north on Test Street for 141 ft",
    route: ROUTE,
  }, { toolUsed: "verifiedNearbyWalkingDirections", tokenCount: 42 });

  const output = "Citibank is the glass door ahead of you.";
  const history = [{ input: text, output, data: "Directions:\nStep 1) Head north on Test Street for 141 ft" }];
  assert.deepEqual(result, { status: 200, body: { output, history, route: ROUTE } });
  assert.deepEqual(logged.map(({ latencyMs, ...row }) => row), [{
    ...rowFor(analytics, text), hasImage: true, imageCount: 1, toolUsed: "verifiedNearbyWalkingDirections",
    hasCoords: true, success: true, errorCode: undefined, outputLength: output.length, tokenCount: 42,
  }]);
});

test("a failed model call answers 500 with the error's message", async (t) => {
  const text = "What is this neighborhood like?";
  const { reply, logged, analytics } = startReply(t, { text, coords: TIMES_SQUARE });

  const result = await reply.modelFailed(new Error("model unavailable"));

  assert.deepEqual(result, { status: 500, body: { error: "Error processing your request: model unavailable" } });
  assert.deepEqual(logged.map(({ latencyMs, ...row }) => row), [{
    ...rowFor(analytics, text), toolUsed: undefined, hasCoords: true, success: false,
    errorCode: "openai_error", outputLength: undefined, tokenCount: undefined,
  }]);
});

test("a failed model call adds nothing to the history", async (t) => {
  const text = "What is this neighborhood like?";
  const { reply } = startReply(t, { text, coords: TIMES_SQUARE });

  await reply.modelFailed(new Error("model unavailable"));
  const next = await reply.destinationNotVerified("Citibank");

  assert.equal("history" in next.body && next.body.history.length, 1);
});

test("the log row's latency runs from when the reply was started", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-27T16:00:00Z") });
  const { reply, logged } = startReply(t, { text: "Directions to Citibank", coords: null });
  t.mock.timers.tick(250);

  await reply.locationUnavailable();

  assert.equal(logged[0].latencyMs, 250);
});
