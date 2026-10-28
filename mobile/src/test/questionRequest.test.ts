import assert from "node:assert/strict";
import test from "node:test";
import { readQuestionRequest } from "../../server/services/questionRequest";
import type { textRequestBody } from "../../server/types";

const TIMES_SQUARE = { latitude: 40.7559, longitude: -73.9871 };

function question(overrides: Partial<textRequestBody> = {}): textRequestBody {
  return { text: "What is this neighborhood like?", coords: TIMES_SQUARE, ...overrides };
}

test("a location within a kilometer, or with no accuracy reported, is trusted", () => {
  for (const accuracy of [undefined, null, 0, 10, 1000]) {
    const request = readQuestionRequest(question({ coords: { ...TIMES_SQUARE, accuracy } }));
    assert.equal(request.location, "trusted", `accuracy ${accuracy}`);
  }
});

test("a location less accurate than a kilometer is not trusted", () => {
  const request = readQuestionRequest(question({ coords: { ...TIMES_SQUARE, accuracy: 1001 } }));
  assert.equal(request.location, "inaccurate");
});

test("a Question asking for a nearby place needs a verified nearby answer", () => {
  const request = readQuestionRequest(question({ text: "Directions to the Citibank" }));
  assert.equal(request.nearbyQuery, "Citibank");
  assert.equal(request.needsVerifiedNearbyAnswer, true);
});

test("a directions Question needs a verified nearby answer even when no place can be read from it", () => {
  const request = readQuestionRequest(question({ text: "Can you help me get there?", analytics: { feature: "directions" } }));
  assert.equal(request.nearbyQuery, null);
  assert.equal(request.needsVerifiedNearbyAnswer, true);
});

test("a directions Question can name its destination alone", () => {
  const bare = question({ text: "Times Square Pharmacy", analytics: { feature: "directions" } });
  assert.equal(readQuestionRequest(bare).nearbyQuery, "Times Square Pharmacy");
});

test("a Question that names no place does not need a verified nearby answer", () => {
  const request = readQuestionRequest(question({ text: "What is this neighborhood like?" }));
  assert.equal(request.nearbyQuery, null);
  assert.equal(request.needsVerifiedNearbyAnswer, false);
});

test("a photo or video Question with frames attached is answered from the frames", () => {
  const photo = readQuestionRequest(question({ image: ["data:photo"], analytics: { feature: "photo_qa" } }));
  assert.deepEqual([photo.frameCount, photo.visual], [1, "photo"]);

  const video = readQuestionRequest(question({ image: ["data:one", "", "data:two"], analytics: { feature: "video_qa" } }));
  assert.deepEqual([video.frameCount, video.visual], [2, "video"], "empty frames are not counted");
});

test("frames alone, or a photo Question without frames, are not a photo or video Question", () => {
  const framesOnly = readQuestionRequest(question({ image: ["data:photo"] }));
  assert.deepEqual([framesOnly.frameCount, framesOnly.visual], [1, null]);

  const noFrames = readQuestionRequest(question({ image: [], analytics: { feature: "photo_qa" } }));
  assert.deepEqual([noFrames.frameCount, noFrames.visual], [0, null]);
});

test("a request without a location searches from 0,0", () => {
  const request = readQuestionRequest(question({ coords: null }));
  assert.equal(request.location, "missing");
  assert.deepEqual(request.coords, { latitude: 0, longitude: 0 });
});
