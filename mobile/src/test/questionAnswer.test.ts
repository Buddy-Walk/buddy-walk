import "./doorfrontUri";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { MongoClient, ObjectId } from "mongodb";
import OpenAI from "openai";
import { answerWithModel } from "../../server/services/questionAnswer";
import { QuestionReply } from "../../server/services/questionReply";
import { readQuestionRequest } from "../../server/services/questionRequest";
import { aiRequestLogService } from "../../server/services/aiRequestLog";
import type { Evidence } from "../../server/services/questionEvidence";
import { AIPrompt, type textRequestBody } from "../../server/types";
import { setTestEnv } from "./testEnv";

const TIMES_SQUARE = { latitude: 40.7559, longitude: -73.9871, accuracy: 10 };
const LOCATION = "Current Address: 1560 Broadway, New York, NY ";
const NO_HISTORY = "(none — fresh test session)";
let installCounter = 0;

/** Fake OpenAI answer calls, taking `answers` in order. Returns the requests made. */
function fakeModel(t: TestContext, answers: (string | Error)[]) {
  setTestEnv(t, { OPENAI_API_KEY: "answer-test-openai" });
  const requests: any[] = [];
  t.mock.method(OpenAI.Chat.Completions.prototype, "create", async (request: any) => {
    const answer = answers[requests.length];
    requests.push(request);
    if (answer === undefined) throw new Error("Unexpected answer call");
    if (answer instanceof Error) throw answer;
    return { choices: [{ message: { content: answer } }], usage: { total_tokens: 42 } };
  });
  return requests;
}

/**
 * Answers a Question from `evidence` and returns the result with the log rows
 * it wrote. Each Question has its own install, so its history starts empty
 * unless `analytics` names one.
 */
async function answer(
  t: TestContext,
  evidence: Evidence,
  content: Partial<textRequestBody> = {},
) {
  const logged: any[] = [];
  t.mock.method(aiRequestLogService, "record", async (row: any) => { logged.push(row); });
  installCounter++;
  const body: textRequestBody = {
    text: "What is around me?",
    coords: TIMES_SQUARE,
    analytics: { installId: `answer-test-${installCounter}` },
    ...content,
  };
  const request = readQuestionRequest(body);
  const result = await answerWithModel({
    content: body,
    location: LOCATION,
    evidence,
    reply: new QuestionReply(body, request),
  });
  return { result, logged };
}

/** The system message without the clock time, which changes each run. */
function systemMessage(request: any): string {
  return request.messages[0].content.replace(/(Current Date and Time \(Eastern\): )[^\n]*/, "$1<now>");
}

test("the model answers from the prompt, the location, and the evidence", async (t) => {
  const model = fakeModel(t, ["A busy part of Midtown."]);

  const { result, logged } = await answer(t, {
    prompt: "\nDescribe the place.",
    relevantData: "\nNearby: Duane Reade",
    data: "Nearby: Duane Reade",
    toolUsed: "generateGoogleAPILinkNonSpecificLocation",
  });

  assert.deepEqual(result, { status: 200, body: {
    output: "A busy part of Midtown.",
    history: [{ input: "What is around me?", output: "A busy part of Midtown.", data: "Nearby: Duane Reade" }],
    route: null,
  } });
  assert.equal(model.length, 1);
  assert.equal(
    systemMessage(model[0]),
    `${AIPrompt}\nDescribe the place.\n\nRelevant data: ${LOCATION}\nNearby: Duane Reade` +
      `\nCurrent Date and Time (Eastern): <now>\n\nChat history: ${NO_HISTORY}`,
  );
  assert.deepEqual(model[0].messages[1], { role: "user", content: [{ type: "text", text: "What is around me?" }] });
  assert.deepEqual(
    [model[0].model, model[0].temperature, model[0].max_tokens],
    ["gpt-4o-mini", 0.2, 120],
  );
  assert.deepEqual(
    logged.map((row) => [row.success, row.toolUsed, row.tokenCount]),
    [[true, "generateGoogleAPILinkNonSpecificLocation", 42]],
  );
});

test("the model sees the Question's frames, then the evidence's images, and the route comes back", async (t) => {
  const model = fakeModel(t, ["The door is ahead."]);
  const photo = "data:image/jpeg;base64,storefront";
  const streetView = { type: "image_url" as const, image_url: { url: "https://streetview.test/pano", detail: "low" as const } };
  const route = { polyline: "abc" } as any;

  const { result } = await answer(t, { images: [streetView], route }, { image: [photo] });

  assert.deepEqual(model[0].messages[1].content, [
    { type: "text", text: "What is around me?" },
    { type: "image_url", image_url: { url: photo, detail: "auto" } },
    streetView,
  ]);
  assert.equal((result.body as any).route, route);
});

test("the model sees only the last three answers in the history", async (t) => {
  const model = fakeModel(t, ["first", "second", "third", "fourth", "fifth"]);
  const analytics = { installId: "answer-test-history" };
  for (const text of ["q1", "q2", "q3", "q4", "q5"]) {
    await answer(t, { data: `d-${text}` }, { text, analytics });
  }

  assert.match(
    systemMessage(model[4]),
    /\n\nChat history: User Input: q2, AI Output: second, Data Used: d-q2\nUser Input: q3, AI Output: third, Data Used: d-q3\nUser Input: q4, AI Output: fourth, Data Used: d-q4$/,
  );
});

test("the answer's length is capped by the Question's feature", async (t) => {
  const caps = { mta: 100, location_qa: 80, directions: 280, photo_qa: 150, video_qa: 150, something_else: 120 };
  const model = fakeModel(t, Object.keys(caps).map(() => "An answer."));

  for (const feature of Object.keys(caps)) {
    await answer(t, {}, { analytics: { installId: `answer-test-cap-${feature}`, feature } });
  }

  assert.deepEqual(model.map((request) => request.max_tokens), Object.values(caps));
});

const LAST_METERS_INSTRUCTION =
  "\n\nCRITICAL INSTRUCTION: The user attached an image/video of their surroundings for 'Last Meters' navigation. " +
  "DO NOT just read the GPS directions. You MUST analyze the image and use it to guide the user exactly to the " +
  "physical door or entrance relative to their current view.";

test("directions found after tool routing with a frame add the Last Meters instruction", async (t) => {
  const model = fakeModel(t, ["The door is ahead.", "The door is ahead.", "Head north."]);
  const photo = "data:image/jpeg;base64,storefront";

  await answer(t, { prompt: "\nGive directions.", toolUsed: "generateGoogleDirectionAPILink" }, { image: [photo] });
  await answer(t, { prompt: "\nGive directions.", toolUsed: "verifiedNearbyWalkingDirections" }, { image: [photo] });
  await answer(t, { prompt: "\nGive directions.", toolUsed: "generateGoogleDirectionAPILink" });

  const prompts = model.map((request) => systemMessage(request).split("\n\nRelevant data: ")[0]);
  assert.deepEqual(prompts, [
    `${AIPrompt}\nGive directions.${LAST_METERS_INSTRUCTION}`,
    `${AIPrompt}\nGive directions.`,
    `${AIPrompt}\nGive directions.`,
  ]);
});

/**
 * Fake the Doorfront collection at the Mongo driver. services/doorfront.ts keeps
 * its client for the whole process, so `db` is faked on the prototype each test.
 * Returns each update with the collection it went to.
 */
function fakeDoorfront(t: TestContext) {
  const updates: object[] = [];
  t.mock.method(MongoClient.prototype, "connect", async function (this: MongoClient) { return this; });
  t.mock.method(MongoClient.prototype, "db", (db: string) => ({
    collection: (collection: string) => ({
      updateOne: async (filter: any, update: any) => {
        updates.push({ db, collection, filter, description: update.$set.image_description });
        return { matchedCount: 1 };
      },
    }),
  }));
  return updates;
}

test("the answer is saved as the Doorfront panorama's description", async (t) => {
  fakeModel(t, ["A glass door with a push bar.", "A glass door with a push bar."]);
  const updates = fakeDoorfront(t);

  await answer(t, { panoramaId: "64b000000000000000000001" });
  await answer(t, {});

  assert.deepEqual(updates, [{
    db: "myFirstDatabase",
    collection: "collect_panorama",
    filter: { _id: new ObjectId("64b000000000000000000001") },
    description: "A glass door with a push bar.",
  }]);
});

test("a failed model call answers 500 and adds nothing to the history", async (t) => {
  const model = fakeModel(t, [new Error("model unavailable"), "A busy part of Midtown."]);
  const analytics = { installId: "answer-test-failure" };

  const { result, logged } = await answer(t, { toolUsed: "getCrossStreets" }, { analytics });
  await answer(t, {}, { analytics });

  assert.deepEqual(result, { status: 500, body: { error: "Error processing your request: model unavailable" } });
  assert.deepEqual(logged.map((row) => [row.success, row.toolUsed, row.errorCode]), [[false, "getCrossStreets", "openai_error"]]);
  assert.ok(systemMessage(model[1]).endsWith(`Chat history: ${NO_HISTORY}`));
});
