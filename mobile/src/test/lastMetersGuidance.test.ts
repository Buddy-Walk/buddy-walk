import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import OpenAI from "openai";
import { composeGuidance, type GuidanceInput } from "../../server/services/lastMetersGuidance";
import { LastMetersTrial } from "../../server/services/lastMetersTrial";
import { lastMetersTestLogService } from "../../server/services/lastMetersTestLog";
import { mobileLastMetersGuidancePolicy, strictLastMetersGuidancePolicy } from "../../server/utils/lastMetersGuidancePolicy";
import type { VerifiedNearbyDestination } from "../../server/services/verifiedDestination";
import type { LastMetersRequestInput } from "../../server/utils/lastMetersReplay";
import { setTestEnv } from "./testEnv";

const NOW = Date.parse("2026-10-27T12:00:00Z");
const USER = { lat: 40.7, lng: -74 };
const REQUEST: LastMetersRequestInput = { ...USER, destination: "McDonald's", deviceHeading: 90, gpsAccuracyMeters: 5 };
const PHOTO = "data:image/jpeg;base64,AAAA";
/** About 50 meters north of the user. */
const NEAR = { lat: 40.70045, lng: -74 };
const LANDMARKS = "A recessed doorway is on the brick wall in your photo.";

const DESTINATION: VerifiedNearbyDestination = {
  placeId: "mcdonalds",
  placeName: "McDonald's",
  placeAddress: "10 Test Street",
  types: ["restaurant"],
  location: NEAR,
  distanceMeters: 50,
  candidateSummary: "McDonald's, 50 meters",
  placeCandidates: [],
  placesSearches: ["nearby"],
  openNow: true,
  businessStatus: "OPERATIONAL",
};

/** Fake OpenAI's landmarks answer, record what the Trial saves, and compose guidance for a user facing east toward an entrance straight north. */
async function compose(t: TestContext, landmarks: string | null, changes: Partial<GuidanceInput> = {}) {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  setTestEnv(t, { OPENAI_API_KEY: "test-openai" });
  const requests: any[] = [];
  t.mock.method(OpenAI.Chat.Completions.prototype, "create", async (request: any) => {
    requests.push(request);
    return { choices: [{ message: { content: landmarks } }], usage: { total_tokens: 42 } };
  });
  const rows: Record<string, any>[] = [];
  t.mock.method(lastMetersTestLogService, "record", async (row: Record<string, any>) => {
    rows.push(row);
    return `trial-${rows.length}`;
  });
  t.mock.method(console, "log", () => undefined);
  // A replay saves no photo of its own, so the placeholder image is never compressed.
  const trial = new LastMetersTrial({
    request: REQUEST, image: PHOTO,
    options: { retry: { retryOf: "original-1", panoramaMode: "fresh", defaultsApplied: [], replayInput: { receivedAt: NOW } as any } },
    policy: strictLastMetersGuidancePolicy,
  });
  const guidance = await composeGuidance(trial, {
    request: REQUEST,
    image: PHOTO,
    place: DESTINATION,
    entrance: { source: "geocoding_entrance", location: NEAR, distanceMeters: 50 },
    destinationBearing: 0,
    turnHeading: 90,
    walkingEvidence: { verified: true, reason: "walking_route_consistent_not_accessibility_verified" },
    reference: undefined,
    panoramaDate: "2025-01",
    closedNotice: "",
    policy: strictLastMetersGuidancePolicy,
    ...changes,
  });
  /** End the Trial so its saved row shows what composing logged. */
  const saved = async () => {
    await trial.answer({}, { success: true });
    return rows[0];
  };
  return { guidance, requests, saved };
}

test("composeGuidance turns the user toward the entrance and adds the landmarks from their photo", async t => {
  const { guidance, requests, saved } = await compose(t, `  ${LANDMARKS}  `);

  assert.deepEqual(guidance, {
    turnInstruction: "Turn 90 degrees to your left.",
    finalOutput: "Turn 90 degrees to your left. After turning, McDonald's is about 150 feet away in that direction. " +
      `Continue with your primary navigation. Landmarks: ${LANDMARKS} Entrance accessibility has not been verified. ` +
      " Source: Google Maps and Street View imagery from 2025-01.",
  });
  assert.equal(requests.length, 1);
  const [system, user] = requests[0].messages;
  assert.match(system.content, /The validated turn instruction is: "Turn 90 degrees to your left\."/);
  assert.match(system.content, /No separate destination reference image is provided\./);
  assert.match(system.content, /Do not name, describe, or direct the user toward any business other than "McDonald's"/);
  assert.deepEqual(user.content, [
    { type: "text", text: "--- USER'S CURRENT PHOTO ---" },
    { type: "image_url", image_url: { url: PHOTO, detail: "high" } },
  ]);
  const row = await saved();
  assert.deepEqual(
    row.steps.map((step: any) => [step.name, step.response, step.success, step.error, step.tokenCount]),
    [["accessible_guidance", LANDMARKS, true, undefined, 42]],
  );
});

test("composeGuidance tells the user to turn in place when the photo shows no reliable landmark", async t => {
  const { guidance, saved } = await compose(t, "NO_RELIABLE_LANDMARKS");

  assert.match(guidance.finalOutput, / Landmarks: No reliable physical landmark was identified\. Turn in place without moving forward, then confirm your orientation before continuing\. /);
  const row = await saved();
  assert.deepEqual(
    row.steps.map((step: any) => [step.name, step.response, step.success, step.error]),
    [["accessible_guidance", "NO_RELIABLE_LANDMARKS", false, "No reliable physical landmark was identified."]],
  );
});

test("composeGuidance shows the destination reference photo as dated historical context", async t => {
  const reference = {
    photo: "data:image/jpeg;base64,REFERENCE", date: "2025-06", status: "OK",
    placeName: "McDonald's", placeAddress: "10 Test Street", targetHeading: 0,
  };
  const { requests } = await compose(t, LANDMARKS, { reference });

  const [system, user] = requests[0].messages;
  assert.match(system.content, /A separate Street View image for "McDonald's" is also provided\. It was captured 2025-06 and may be outdated\./);
  assert.deepEqual(user.content.slice(2), [
    { type: "text", text: "--- DESTINATION-FOCUSED STREET VIEW REFERENCE ---" },
    { type: "image_url", image_url: { url: "data:image/jpeg;base64,REFERENCE", detail: "high" } },
  ]);
});

test("composeGuidance words the landmarks request and the answer the guidance policy's way", async t => {
  const { guidance, requests } = await compose(t, LANDMARKS, {
    policy: mobileLastMetersGuidancePolicy,
    walkingEvidence: { verified: false, reason: "walking_route_requires_detour" },
    closedNotice: " Google lists McDonald's as closed right now.",
  });

  assert.ok(requests[0].messages[0].content.endsWith(mobileLastMetersGuidancePolicy.landmarkContext));
  assert.equal(
    guidance.finalOutput,
    "Turn 90 degrees to your left. After turning, McDonald's is about 150 feet away in that direction. " +
      `Continue with your primary navigation. Landmarks: ${LANDMARKS} Google lists McDonald's as closed right now. ` +
      "Turn in place only; the distance is a straight-line estimate, not a verified walking path. " +
      "Entrance accessibility has not been verified.  Source: Google Maps and Street View imagery from 2025-01.",
  );
});
