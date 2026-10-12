import assert from "node:assert/strict";
import test from "node:test";
import { LastMileTestLogController } from "../../server/controllers/lastMileTestLog";
import { lastMileTestLogService } from "../../server/services/lastMileTestLog";
import { OpenAIService } from "../../server/services/openAI";
import model from "../../server/database/models/lastMileTestLog";
import { readFileSync } from "node:fs";
import vm from "node:vm";

function response() {
  return { code: 200, body: undefined as any, status(code: number) { this.code = code; return this; }, json(body: any) { this.body = body; return this; } };
}
test("replay endpoint authenticates, rejects legacy inputs, limits paid runs, and preserves source", async t => {
  const env = { ADMIN_TOKEN: process.env.ADMIN_TOKEN, OPENAI_API_KEY: process.env.OPENAI_API_KEY, GOOGLE_MAPS_API_KEY: process.env.GOOGLE_MAPS_API_KEY };
  Object.assign(process.env, { ADMIN_TOKEN: "unit-token", OPENAI_API_KEY: "unit-test", GOOGLE_MAPS_API_KEY: "unit-test" });
  t.after(() => { for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  const controller = new LastMileTestLogController();
  const req = { headers: { "x-admin-token": "unit-token" }, query: {}, params: { id: "source-trial" } } as any;
  const unauthorized = response();
  await controller.replay({ ...req, headers: {} }, unauthorized as any);
  assert.equal(unauthorized.code, 401);
  let row: any = {};
  t.mock.method(lastMileTestLogService, "getById", async () => row);
  const legacy = response();
  await controller.replay(req, legacy as any);
  assert.equal(legacy.code, 422);
  row = { userPhoto: "data:image/jpeg;base64,test", replayInput: { schemaVersion: 1, lat: 40.7, lng: -74,
    destination: "Citi", receivedAt: 1000, sensors: {}, heading: 90 } };
  const unchanged = JSON.stringify(row);
  let calls = 0;
  t.mock.method(OpenAIService.prototype, "lastMileRequest", async (...args: any[]) => {
    calls++;
    assert.deepEqual(args[9], { retryOf: "source-trial", evaluationTime: 1000 });
    assert.equal(args[3], row.userPhoto);
    args[0].res.json({ testLogId: "new-replay-trial", output: "Withheld" });
  });
  for (let i = 0; i < 3; i++) {
    const result = response();
    await controller.replay(req, result as any);
    assert.equal(result.code, 200);
    assert.equal(result.body.replay, true);
    assert.equal(result.body.result.testLogId, "new-replay-trial");
  }
  const limited = response();
  await controller.replay(req, limited as any);
  assert.equal(limited.code, 429);
  assert.equal(calls, 3);
  assert.equal(JSON.stringify(row), unchanged);
});
test("evaluation endpoint returns a controlled error on database failure", async t => {
  const token = process.env.ADMIN_TOKEN;
  const req = { headers: token ? { "x-admin-token": token } : {}, query: {} } as any;
  t.mock.method(lastMileTestLogService, "getSummaries", async () => { throw new Error("database unavailable"); });
  const res = response();
  await new LastMileTestLogController().evaluation(req, res as any);
  assert.equal(res.code, 503);
});
test("Mongo schema preserves replay provenance and withheld reasons", () => {
  const doc = new model({ destination: "Citi", lat: 40.7, lng: -74, userPhoto: "data:image/jpeg;base64,test",
    pipelineVersion: "v3", deployedCommit: "abc", runKind: "replay", retryOf: "source",
    replayInput: { schemaVersion: 1, receivedAt: 123 }, safetyReasons: ["photo_stale"],
    walkingEvidence: { verified: false, reason: "walking_route_unavailable" }, panoramaTargetHeading: 0,
    confidenceMethod: "heuristic-not-calibrated" }).toObject();
  assert.equal(doc.runKind, "replay");
  assert.equal(doc.replayInput?.receivedAt, 123);
  assert.deepEqual(doc.safetyReasons, ["photo_stale"]);
  assert.equal(doc.panoramaTargetHeading, 0);
});

test("trial detail opts into saved Street View blobs without changing list behavior", async t => {
  const photo = "data:image/jpeg;base64,test";
  let requested: unknown;
  t.mock.method(lastMileTestLogService, "getById", async (_id: string, options: unknown) => {
    requested = options;
    return { userPhoto: photo, panoramaPhoto: photo, destinationPhoto: photo } as any;
  });
  const req = { headers: { "x-admin-token": process.env.ADMIN_TOKEN }, params: { id: "trial" },
    query: { includeImages: "true", includeStreetView: "true" } } as any;
  const res = response();
  await new LastMileTestLogController().getOne(req, res as any);
  assert.deepEqual(requested, { includeStreetView: true });
  assert.equal(res.body.data.panoramaPhoto, photo);
  assert.equal(res.body.data.destinationPhoto, photo);
});

test("dashboard renders saved panoramas, decimal headings and missing-image explanations", () => {
  const html = readFileSync("server/views/lastMileTests.html", "utf8");
  const script = html.match(/<script>([\s\S]*?)<\/script>/)![1];
  const helper = script.slice(script.indexOf("function streetViewImagesHtml("), script.indexOf("function renderDetail("));
  const context = vm.createContext({ esc: (v: any) => String(v),
    imgSrc: (v: any) => typeof v === "string" && v.startsWith("data:") ? v : "", noPanoramaReason: () => "No outdoor panorama saved." });
  vm.runInContext(helper, context);
  const rendered = vm.runInContext('streetViewImagesHtml({panoramaPhoto:"data:image/jpeg;base64,pano",destinationPhoto:"data:image/jpeg;base64,ref",panoramaHeadings:[0,22.5]})', context);
  assert.match(rendered, /src="data:image\/jpeg;base64,pano"/);
  assert.match(rendered, /src="data:image\/jpeg;base64,ref"/);
  assert.match(rendered, /22.5°/);
  assert.match(rendered, /download="panoramaPhoto.jpg"/);
  assert.match(vm.runInContext('streetViewImagesHtml({})', context), /No outdoor panorama saved/);
  assert.match(script, /includeStreetView=true/);
});
test("dashboard script parses and excludes replay and legacy status from field metrics", () => {
  const html = readFileSync("server/views/lastMileTests.html", "utf8");
  const script = html.match(/<script>([\s\S]*?)<\/script>/)![1];
  new vm.Script(script);
  const outcomeFunction = script.slice(script.indexOf("function outcomeOf("), script.indexOf("var SOURCE_LABELS"));
  const summaryFunction = script.slice(script.indexOf("function renderSummary("), script.indexOf("function saveReview("));
  const element = { innerHTML: "" };
  const context = vm.createContext({ document: { getElementById: () => element }, esc: (s: string) => s,
    weekOf: () => "week", successTable: () => "" });
  vm.runInContext(outcomeFunction + summaryFunction, context);
  vm.runInContext('renderSummary([{reviewOutcome:"got_there",runKind:"replay"},{reviewerStatus:"pass"}])', context);
  assert.match(element.innerHTML, /0 of 1 trials scored/);
});
