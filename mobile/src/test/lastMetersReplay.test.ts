import assert from "node:assert/strict";
import test from "node:test";
import { LastMetersTestLogController } from "../../server/controllers/lastMetersTestLog";
import { lastMetersTestLogService } from "../../server/services/lastMetersTestLog";
import model from "../../server/database/models/lastMetersTestLog";

function response() {
  return { code: 200, body: undefined as any, status(code: number) { this.code = code; return this; }, json(body: any) { this.body = body; return this; } };
}
test("evaluation endpoint returns a controlled error on database failure", async t => {
  const token = process.env.ADMIN_TOKEN;
  const req = { headers: token ? { "x-admin-token": token } : {}, query: {} } as any;
  t.mock.method(lastMetersTestLogService, "getSummaries", async () => { throw new Error("database unavailable"); });
  const res = response();
  await new LastMetersTestLogController().evaluation(req, res as any);
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
  t.mock.method(lastMetersTestLogService, "getById", async (_id: string, options: unknown) => {
    requested = options;
    return { userPhoto: photo, panoramaPhoto: photo, destinationPhoto: photo } as any;
  });
  const req = { headers: { "x-admin-token": process.env.ADMIN_TOKEN }, params: { id: "trial" },
    query: { includeImages: "true", includeStreetView: "true" } } as any;
  const res = response();
  await new LastMetersTestLogController().getOne(req, res as any);
  assert.deepEqual(requested, { includeStreetView: true });
  assert.equal(res.body.data.panoramaPhoto, photo);
  assert.equal(res.body.data.destinationPhoto, photo);
});
