import assert from "node:assert/strict";
import test from "node:test";
import { LastMileTestLogController } from "../../server/controllers/lastMileTestLog";
import { lastMileTestLogService } from "../../server/services/lastMileTestLog";
import lastMileTestLogRoute from "../../server/routes/lastMileTestLog";
import model from "../../server/database/models/lastMileTestLog";
import { readFileSync } from "node:fs";
import vm from "node:vm";

function response() {
  return { code: 200, body: undefined as any, status(code: number) { this.code = code; return this; }, json(body: any) { this.body = body; return this; } };
}
test("removed replay endpoint falls through without loading or executing a trial", async t => {
  t.mock.method(lastMileTestLogService, "getById", async () => { assert.fail("The retired route must not load a trial"); });
  const res = response();
  const req = { method: "POST", url: "/source-trial/replay", headers: { "x-admin-token": "unit-token" } };
  await new Promise<void>((resolve, reject) => {
    (lastMileTestLogRoute as any).handle(req, res, (error: unknown) => {
      if (error) { reject(error); return; }
      res.status(404);
      resolve();
    });
  });
  assert.equal(res.code, 404);
  assert.equal(res.body, undefined);
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
  assert.equal("replayCompatibility" in res.body.data, false);
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
