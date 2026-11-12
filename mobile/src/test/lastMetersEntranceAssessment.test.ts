import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import OpenAI from "openai";
import { LastMetersEntranceAssessment, parseEntranceAssessment, type EntranceAssessment, type HistoricalPanorama,
  type HistoricalPanoramaProvider } from "../../server/services/lastMetersEntranceAssessment";
import type { LastMetersTrial } from "../../server/services/lastMetersTrial";
import { setTestEnv } from "./testEnv";

const NOW = Date.parse("2026-10-27T12:00:00Z");
const CAMERA = { lat: 40.7, lng: -74 };
const TARGET = { lat: 40.70045, lng: -74 };
const ORIGINAL = { status: "OK", pano_id: "current", date: "2026-09", location: CAMERA };
const PHOTO = "data:image/jpeg;base64,AAAA";
const reply = (changes: Partial<EntranceAssessment> = {}) => JSON.stringify({
  storefrontMatches: true, panoramaEntrance: "VISIBLE", photoEntrance: "VISIBLE", sameEntrance: true,
  appearanceChanged: false, entranceHeading: 0, obstruction: "none", ...changes,
});
const BLOCKED = reply({ panoramaEntrance: "OCCLUDED", obstruction: "scaffolding", sameEntrance: false });
const NOT_FOUND = reply({ panoramaEntrance: "NOT_VISIBLE", storefrontMatches: false, entranceHeading: null });
const historical = (panoId: string, date: string, changes: Partial<HistoricalPanorama> = {}): HistoricalPanorama =>
  ({ panoId, date, camera: CAMERA, placeId: "verified-shop", ...changes });

function setup(t: TestContext, options: { answers?: string[]; history?: HistoricalPanorama[]; provider?: boolean;
  list?: HistoricalPanoramaProvider["list"]; loadView?: HistoricalPanoramaProvider["loadView"]; deadline?: number } = {}) {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  setTestEnv(t, { OPENAI_API_KEY: "test-openai" });
  const answers = options.answers ?? [BLOCKED, NOT_FOUND];
  let call = 0;
  const model = t.mock.method(OpenAI.Chat.Completions.prototype, "create", async () => {
    const content = answers[Math.min(call++, answers.length - 1)];
    return { choices: [{ message: { content } }] };
  });
  const list = t.mock.fn(options.list ?? (async () => options.history ?? []));
  const loadView = t.mock.fn(options.loadView ?? (async () => PHOTO));
  const assessment = new LastMetersEntranceAssessment({
    placeId: "verified-shop", placeName: "Verified Shop", target: TARGET, photo: PHOTO,
    deadline: options.deadline ?? NOW + 45_000, original: ORIGINAL,
    seenPanoramas: new Set(["current", "rejected-camera"]),
    options: options.provider === false ? {} : { historicalProvider: { id: "authorized-test-fixture", list, loadView } },
  });
  const current = (storefrontHeading: number | null = 0, metadata = ORIGINAL) =>
    assessment.assessCurrent({ metadata, tiles: [{ heading: 0, base64: PHOTO }] }, 0, storefrontHeading);
  const report = () => {
    let step: any;
    assessment.record({ step: (value: unknown) => { step = value; } } as LastMetersTrial, 0);
    return { ...JSON.parse(step.response), durationMs: step.durationMs };
  };
  return { assessment, current, model, list, loadView, report };
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
  const { assessment, current } = setup(t, { answers: [reply()] });
  assert.equal(await current(null), false);
  assert.equal(await current(0), true);
  assert.equal(assessment.verifiedHeading, 0);
});

test("history uses at most three distinct capture periods, newest first, without authorizing a turn", async t => {
  const { assessment, current, list, loadView, report } = setup(t, { history: [
    historical("oldest", "2022-01"), historical("third", "2023-01"), historical("first", "2025-05"), historical("second", "2024-02"),
  ] });
  await current();
  await assessment.searchHistory(false);
  assert.deepEqual(loadView.mock.calls.map(c => c.arguments[0].panoId), ["first", "second", "third"]);
  assert.equal(list.mock.calls[0].arguments[0].maxPeriods, 3);
  assert.equal(list.mock.calls[0].arguments[0].before, "2026-09");
  assert.equal(report().additionalApiRequests, 8); // current assessment + list + 3 * (image + assessment).
  assert.equal(report().historicalObservations.length, 3);
  assert.equal(report().entranceVerified, false);
  assert.equal(report().historicalStatus, "history_inconclusive");
});

test("an old visible entrance stops historical search but never becomes current evidence", async t => {
  const { assessment, current, loadView, report, model } = setup(t, {
    answers: [BLOCKED, reply()], history: [historical("old-door", "2025-01"), historical("older", "2024-01")],
  });
  await current(); await assessment.searchHistory(false);
  assert.equal(loadView.mock.callCount(), 1);
  assert.equal(report().historicalStatus, "historical_entrance_only");
  assert.equal(report().entranceVerified, false);
  assert.equal(report().historicalObservations[0].entranceVerified, false);
  assert.equal(report().historicalObservations[0].photoEntrance, "UNCERTAIN");
  assert.equal(report().historicalObservations[0].sameEntrance, false);
  const request = model.mock.calls[1].arguments[0] as any;
  assert.equal(request.messages[1].content.filter((p: any) => p.type === "image_url").length, 1, "no live photo is silently relabeled historical");
});

test("duplicate IDs and overlapping year/month capture periods do not consume extra observations", async t => {
  const { assessment, current, loadView } = setup(t, { history: [
    historical("repeat", "2025-04"), historical("repeat", "2025-03"), historical("same-period", "2025-04"),
    historical("year-overlap", "2025"), historical("second", "2024-02"), historical("third", "2023-01"),
  ] });
  await current(); await assessment.searchHistory(false);
  assert.deepEqual(loadView.mock.calls.map(c => c.arguments[0].panoId), ["repeat", "second", "third"]);
});

test("unavailable and empty historical providers remain distinguishable", async t => {
  const { assessment, current, list, report } = setup(t, { provider: false });
  await current(); await assessment.searchHistory(false);
  assert.equal(report().historicalStatus, "provider_unavailable");
  assert.equal(list.mock.callCount(), 0);
});

test("an authorized provider with no images records no usable history", async t => {
  const { assessment, current, loadView, report } = setup(t);
  await current(); await assessment.searchHistory(false);
  assert.equal(report().historicalStatus, "no_usable_history");
  assert.equal(loadView.mock.callCount(), 0);
});

test("history rejects unknown/current/future dates, duplicate current IDs, wrong businesses and distant cameras", async t => {
  const { assessment, current, loadView, report } = setup(t, { history: [
    historical("current", "2025-01"), historical("same-date", "2026-09"), historical("future", "2027-01"),
    historical("no-date", "unknown"), historical("wrong-shop", "2025-02", { placeId: "other-shop" }),
    historical("distant", "2025-03", { camera: { lat: 41, lng: -74 } }),
    historical("rejected-camera", "2025-04"),
  ] });
  await current(); await assessment.searchHistory(false);
  assert.equal(loadView.mock.callCount(), 0);
  assert.equal(report().historicalStatus, "no_usable_history");
});

test("missing original capture dates prevent pretending a nearby image is historical", async t => {
  const { assessment, current, list, report } = setup(t);
  await current(0, { ...ORIGINAL, date: "" }); await assessment.searchHistory(false);
  assert.equal(list.mock.callCount(), 0);
  assert.equal(report().historicalStatus, "capture_date_unavailable");
});

test("no history is requested for an unlocated or merely uncertain entrance", async t => {
  const { assessment, current, list, report } = setup(t, { answers: [NOT_FOUND] });
  await current(); await assessment.searchHistory(false);
  assert.equal(list.mock.callCount(), 0);
  assert.equal(report().historicalStatus, "occlusion_not_established");
});

test("a changed storefront or door is not promoted by a later matching model reply", async t => {
  const { assessment, current, report } = setup(t, { answers: [reply(), reply({ appearanceChanged: true }), reply()] });
  assert.equal(await current(), true);
  assert.equal(await current(), false);
  assert.equal(await current(), false);
  assert.equal(assessment.restoreVerified("current"), false);
  assert.equal(report().entranceVerified, false);
});

test("historical changed architecture is inconclusive even when an old door is visible", async t => {
  const { assessment, current, report } = setup(t, { answers: [BLOCKED, reply({ appearanceChanged: true })], history: [historical("old", "2025-01")] });
  await current(); await assessment.searchHistory(false);
  assert.equal(report().historicalStatus, "history_inconclusive");
  assert.equal(report().entranceVerified, false);
});

test("provider errors are sanitized rather than persisting signed URLs or credentials", async t => {
  const { assessment, current, report } = setup(t, { list: async () => { throw new Error("https://private?key=secret-token"); } });
  await current(); await assessment.searchHistory(false);
  assert.equal(report().historicalStatus, "history_failed_or_timed_out");
  assert.equal(JSON.stringify(report()).includes("secret-token"), false);
});

test("historical lookup times out, aborts and ignores a late provider result", { timeout: 1000 }, async t => {
  let finish!: (items: HistoricalPanorama[]) => void;
  let signal: AbortSignal | undefined;
  const { assessment, current, loadView, report } = setup(t, { deadline: NOW + 20,
    list: async input => { signal = input.signal; return new Promise(resolve => { finish = resolve; }); } });
  await current(); await assessment.searchHistory(false);
  assert.equal(signal?.aborted, true);
  const saved = JSON.stringify(report());
  assert.equal(report().historicalStatus, "history_failed_or_timed_out");
  finish([historical("too-late", "2025-01")]);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(loadView.mock.callCount(), 0);
  assert.equal(JSON.stringify(report()), saved);
});

test("failed historical image requests still log the attempted ID and period", async t => {
  const { assessment, current, report } = setup(t, { history: [historical("failed-image", "2025-01")],
    loadView: async () => { throw new Error("secret image URL"); } });
  await current(); await assessment.searchHistory(false);
  assert.deepEqual(report().historicalAttempts, [{ panoId: "failed-image", date: "2025-01", outcome: "failed_or_timed_out" }]);
  assert.equal(report().historicalStatus, "history_failed_or_timed_out");
});

test("provider image URLs cannot be forwarded to the model or persisted in the Trial", async t => {
  const { assessment, current, model, report } = setup(t, { history: [historical("bad-image", "2025-01")], loadView: async () => "https://private?key=secret" });
  await current(); await assessment.searchHistory(false);
  assert.equal(model.mock.callCount(), 1);
  assert.equal(report().failureReason, "historical_image_invalid");
  assert.equal(JSON.stringify(report()).includes("key=secret"), false);
});
