import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import OpenAI from "openai";
import { LastMetersEntranceAssessment, type EntranceAssessment } from "../../server/services/lastMetersEntranceAssessment";
import type { LastMetersTrial } from "../../server/services/lastMetersTrial";
import { setTestEnv } from "./testEnv";
const NOW = Date.parse("2026-10-27T12:00:00Z");
const CAMERA = { lat: 40.7, lng: -74 };
const PHOTO = "data:image/jpeg;base64,AAAA";
const reply = (changes: Partial<EntranceAssessment> = {}) => JSON.stringify({
  storefrontMatches: true, panoramaEntrance: "VISIBLE", photoEntrance: "VISIBLE", sameEntrance: true,
  appearanceChanged: false, entranceHeading: 0, obstruction: "none", ...changes,
});
function setup(t: TestContext, options: { answers: string[] }) {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  setTestEnv(t, { OPENAI_API_KEY: "test-openai" });
  let call = 0;
  t.mock.method(OpenAI.Chat.Completions.prototype, "create", async () => ({ choices: [{ message: {
    content: options.answers[Math.min(call++, options.answers.length - 1)],
  } }] }));
  const assessment = new LastMetersEntranceAssessment({ placeId: "verified-shop", placeName: "Verified Shop",
    target: { lat: 40.70045, lng: -74 }, photo: PHOTO, deadline: NOW + 45_000, options: {},
    original: { status: "OK", pano_id: "current", date: "2026-09", location: CAMERA } });
  const current = (storefrontHeading: number | null = 0) => assessment.assessCurrent({
    metadata: { status: "OK", pano_id: "current", date: "2026-09", location: CAMERA },
    tiles: [{ heading: 0, base64: PHOTO }],
  }, 0, storefrontHeading);
  const report = () => {
    let step: any;
    assessment.record({ step: (value: unknown) => { step = value; } } as LastMetersTrial, 0);
    return JSON.parse(step.response);
  };
  return { assessment, current, report };
}

test("current entrance verification requires a map-matched store and a door visible in both sources", async t => {
  const { assessment, current } = setup(t, { answers: [reply()] });
  assert.equal(await current(null), false);
  assert.equal(await current(0), true);
  assert.equal(assessment.verifiedHeading, 0);
});

test("a changed storefront or door is not promoted by a later matching model reply", async t => {
  const { assessment, current, report } = setup(t, { answers: [reply(), reply({ appearanceChanged: true }), reply()] });
  assert.equal(await current(), true);
  assert.equal(await current(), false);
  assert.equal(await current(), false);
  assert.equal(assessment.restoreVerified("current"), false);
  assert.equal(report().entranceVerified, false);
});
