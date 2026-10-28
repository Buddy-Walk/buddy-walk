import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { classifyInput } from "../../server/services/lastMetersInputClassification";
import { LastMetersTrial } from "../../server/services/lastMetersTrial";
import { lastMetersTestLogService } from "../../server/services/lastMetersTestLog";
import { strictLastMetersGuidancePolicy } from "../../server/utils/lastMetersGuidancePolicy";
import type { LastMetersRequestInput } from "../../server/utils/lastMetersReplay";

const NOW = Date.parse("2026-10-27T12:00:00Z");
const PHOTO = "data:image/jpeg;base64,AAAA";

/** Record what the Trial saves and classify what the user typed into the Last Meters field. */
async function classify(t: TestContext, destination: string) {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const rows: Record<string, any>[] = [];
  t.mock.method(lastMetersTestLogService, "record", async (row: Record<string, any>) => {
    rows.push(row);
    return `trial-${rows.length}`;
  });
  const request: LastMetersRequestInput = { destination, lat: 40.7, lng: -74, deviceHeading: 90, gpsAccuracyMeters: 14 };
  // A replay saves no photo of its own, so the placeholder image is never compressed.
  const trial = new LastMetersTrial({
    request, image: PHOTO,
    options: { retry: { retryOf: "original-1", panoramaMode: "fresh", defaultsApplied: [], replayInput: { receivedAt: NOW } as any } },
    policy: strictLastMetersGuidancePolicy,
  });
  const result = await classifyInput(trial, request, PHOTO);
  /** End the Trial if classifying did not, so its saved row shows what it logged. */
  const saved = async () => {
    if (result.kind === "ok") await trial.answer({}, { success: true });
    return rows[0];
  };
  return { result, saved };
}

const stepsOf = (row: Record<string, any>) => row.steps.map((step: any) => [step.name, step.response]);

test("classifyInput returns the place to search for, without a question lead-in", async t => {
  const { result, saved } = await classify(t, "Where is the McDonald's?");

  assert.deepEqual(result, { kind: "ok", value: "McDonald's" });
  const row = await saved();
  assert.deepEqual(stepsOf(row), [["input_classification", 'DESTINATION: "McDonald\'s" (question lead-in removed)']]);
  assert.equal(row.destinationQuery, "McDonald's");
});

test("classifyInput hands a question about the surroundings to the Question service with the photo", async t => {
  const { result, saved } = await classify(t, "What is in front of me?");

  const exit = result.kind === "exit" ? result.result : assert.fail();
  assert.deepEqual(exit, {
    kind: "question",
    testLogId: "trial-1",
    textRequest: {
      text: "What is in front of me?",
      image: [PHOTO],
      coords: { latitude: 40.7, longitude: -74, accuracy: 14, heading: 90 },
      analytics: { feature: "photo_qa" },
    },
  });
  const row = await saved();
  assert.deepEqual(stepsOf(row), [["input_classification", "QUESTION (question): sent to the question answering flow"]]);
  assert.deepEqual({ testScenario: row.testScenario, finalOutput: row.finalOutput }, {
    testScenario: "question_routed", finalOutput: "Answered by the question answering flow.",
  });
});

test("classifyInput hands a train question to the Question service as a transit question, without the photo", async t => {
  const { result } = await classify(t, "When is the next Q train?");

  const exit = result.kind === "exit" ? result.result : assert.fail();
  assert.equal(exit.kind, "question");
  const textRequest = exit.kind === "question" ? exit.textRequest : assert.fail();
  assert.deepEqual({ image: textRequest.image, analytics: textRequest.analytics }, { image: undefined, analytics: { feature: "mta" } });
});
