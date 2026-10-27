import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import axios from "axios";
import OpenAI from "openai";
import { OpenAIQuestionService } from "../../server/services/openAIQuestionService";
import { aiRequestLogService } from "../../server/services/aiRequestLog";
import { formatHistoryForPrompt } from "../../server/utils/conversationHistory";
import { AIPrompt, imagePrompt, trainPrompt, videoPrompt, type textRequestBody } from "../../server/types";
import { setTestEnv } from "./testEnv";

// Characterization tests: they pin what Question answering does today so the
// code can be moved without changing it. Providers are faked at the axios,
// fetch, and OpenAI SDK boundaries, not inside the service.

const TIMES_SQUARE = { latitude: 40.7559, longitude: -73.9871 };
let installCounter = 0;

function setUp(t: TestContext) {
  setTestEnv(t, { OPENAI_API_KEY: "question-test-openai", GOOGLE_MAPS_API_KEY: "question-test-google" });

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

function analytics(feature?: string) {
  installCounter++;
  return { installId: `question-test-${installCounter}`, feature };
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
  const place = {
    place_id: "citibank",
    name: "Citibank",
    vicinity: "10 Test Street",
    geometry: { location: { lat: 40.7563, lng: -73.9871 } },
    types: ["bank"],
  };
  const step = {
    html_instructions: "Head <b>north</b> on Test&nbsp;Street",
    distance: { text: "141 ft", value: 43 },
    duration: { text: "1 min", value: 30 },
    maneuver: "",
    start_location: { lat: 40.7559, lng: -73.9871 },
    end_location: { lat: 40.7563, lng: -73.9871 },
    travel_mode: "WALKING",
  };
  t.mock.method(axios, "get", async (url: string, options: any) => {
    httpCalls.push(url);
    if (url.includes("nearbysearch")) {
      assert.equal(options.params.keyword, "Citibank");
      return { data: { status: "OK", results: [place] } };
    }
    if (url.includes("directions")) {
      assert.equal(options.params.destination, "place_id:citibank");
      assert.equal(options.params.mode, "walking");
      return { data: { status: "OK", routes: [{
        overview_polyline: { points: "abc" },
        legs: [{ distance: { text: "141 ft", value: 43 }, duration: { text: "1 min", value: 30 }, steps: [step] }],
      }] } };
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  t.mock.method(OpenAI.Chat.Completions.prototype, "create", async (request: any) => { completions.push(request); throw new Error("Unexpected completion"); });

  const answer = await ask({ text: "Directions to Citibank", coords: { ...TIMES_SQUARE, accuracy: 10 }, analytics: analytics("directions") });

  assert.equal(answer.statusCode, 200);
  assert.equal(answer.body.output, "Step 1) Head north on Test Street for 141 ft\nDestination: Citibank, 10 Test Street.");
  assert.deepEqual(answer.body.history, [{
    input: "Directions to Citibank",
    output: "Step 1) Head north on Test Street for 141 ft\nDestination: Citibank, 10 Test Street.",
    data: "Verified local route to Citibank.",
  }]);
  assert.deepEqual(answer.body.route, {
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
  });
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
