import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import OpenAI from "openai";
import { LastMetersEntranceAssessment, parseEntranceAssessment, type EntranceAssessment } from "../../server/services/lastMetersEntranceAssessment";
import type { LastMetersTrial } from "../../server/services/lastMetersTrial";
import { withinEntranceBudget, PanoramaDeadlineError } from "../../server/services/lastMetersPanoramaBudget";
import { setTestEnv } from "./testEnv";

const NOW = Date.parse("2026-10-27T12:00:00Z");
const CAMERA = { lat: 40.7, lng: -74 };
const ORIGINAL = { status: "OK", pano_id: "current", date: "2026-09", location: CAMERA };
const PHOTO = "data:image/jpeg;base64,AAAA";
const reply = (changes: Partial<EntranceAssessment> = {}) => JSON.stringify({
  storefrontMatches: true, panoramaEntrance: "VISIBLE", photoEntrance: "VISIBLE", sameEntrance: true,
  appearanceChanged: false, entranceHeading: 0, obstruction: "none", ...changes,
});
function setup(t: TestContext, answers: string[]) {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  setTestEnv(t, { OPENAI_API_KEY: "test-openai" });
  let call = 0;
  t.mock.method(OpenAI.Chat.Completions.prototype, "create", async () => {
    const content = answers[Math.min(call++, answers.length - 1)];
    return { choices: [{ message: { content } }] };
  });
  const assessment = new LastMetersEntranceAssessment({
    placeName: "Verified Shop", photo: PHOTO, budget: { deadline: NOW + 45_000, seen: new Set(), apiRequests: 0 }, original: ORIGINAL,
  });
  const current = (storefrontHeading: number | null = 0, metadata = ORIGINAL) =>
    assessment.assessCurrent({ metadata, tiles: [{ heading: 0, base64: PHOTO }] }, 0, storefrontHeading);
  const report = () => {
    let step: any;
    assessment.record({ step: (value: unknown) => { step = value; } } as LastMetersTrial);
    return { ...JSON.parse(step.response), durationMs: step.durationMs };
  };
  return { assessment, current, report };
}

for (const state of ["VISIBLE", "OCCLUDED", "NOT_VISIBLE", "UNCERTAIN"] as const) {
  test(`entrance assessment parses ${state} independently of storefront identity`, () => {
    const value = parseEntranceAssessment(reply({ panoramaEntrance: state, photoEntrance: "UNCERTAIN" }));
    assert.equal(value.panoramaEntrance, state);
    assert.equal(value.photoEntrance, "UNCERTAIN");
    assert.equal(value.storefrontMatches, true);
  });
}

test("malformed, legacy and out-of-range assessments fail closed", () => {
  for (const text of ["0", "VISIBLE", "{}", "not JSON", reply({ entranceHeading: 12 }), reply({ sameEntrance: "true" as any })]) {
    assert.equal(parseEntranceAssessment(text).panoramaEntrance, "UNCERTAIN");
    assert.equal(parseEntranceAssessment(text).storefrontMatches, false);
  }
});

test("current entrance verification requires a map-matched store and a door visible in both sources", async t => {
  const { assessment, current } = setup(t, [reply()]);
  assert.equal(await current(null), false);
  assert.equal(await current(0), true);
  assert.equal(assessment.verifiedHeading, 0);
});

test("a changed storefront or door is not promoted by a later matching model reply", async t => {
  const { assessment, current, report } = setup(t, [reply(), reply({ appearanceChanged: true }), reply()]);
  assert.equal(await current(), true);
  assert.equal(await current(), false);
  assert.equal(await current(), false);
  assert.equal(assessment.restoreVerified("current"), false);
  assert.equal(report().entranceVerified, false);
});

test("deadline aborts an in-flight request and ignores a late reply", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: NOW });
  const budget = { seen: new Set<string>(), apiRequests: 0, deadline: NOW + 100 };
  let captured!: AbortSignal;
  let finish!: () => void;
  const pending = withinEntranceBudget(budget, (signal, timeout) => {
    captured = signal;
    assert.equal(timeout, 100);
    return new Promise<void>(resolve => { finish = resolve; });
  });
  t.mock.timers.tick(100);
  await assert.rejects(pending, PanoramaDeadlineError);
  assert.equal(captured.aborted, true);
  finish();
  await assert.rejects(withinEntranceBudget(budget, () => assert.fail("Expired request was started")), PanoramaDeadlineError);
});

test("an individual vision timeout aborts before the shared deadline", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: NOW });
  const budget = { seen: new Set<string>(), apiRequests: 0, deadline: NOW + 45_000 };
  let captured!: AbortSignal;
  const pending = withinEntranceBudget(budget, (signal, timeout) => {
    captured = signal;
    assert.equal(timeout, 8000);
    return new Promise<void>(() => {});
  });
  t.mock.timers.tick(8000);
  await assert.rejects(pending, { code: "PANORAMA_REQUEST_TIMEOUT" });
  assert.equal(captured.aborted, true);
});
