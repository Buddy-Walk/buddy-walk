import assert from "node:assert/strict";
import { test } from "node:test";
import sharp from "sharp";
import {
  MobileLastMileService,
  mobileReviewPanoramaStatus,
  saveFieldReviewPanorama,
} from "../../server/services/mobileLastMile";
import { OpenAIService, type LastMetersRunResult } from "../../server/services/openAI";
import { lastMileTestLogService } from "../../server/services/lastMileTestLog";
import {
  buildReplayInput,
  type LastMetersRequestInput,
} from "../../server/utils/lastMileReplay";
import { LAST_MILE_HEADINGS } from "../../server/utils/lastMileNavigation";
import { RECAPTURE_MESSAGE } from "../utils/lastMileSafety";

/** Create original and live sensor evidence that agree until a test supplies a failure. */
function captureRequest(): LastMetersRequestInput {
  const now = Date.now();
  return {
    destination: "Bluemercury",
    lat: 40.71579060521043,
    lng: -74.011422721738,
    deviceHeading: 0,
    gpsAccuracyMeters: 5,
    compassAccuracyLevel: 3,
    sensors: {
      photoCapturedAt: now,
      positionTimestamp: now,
      headingTimestamp: now,
      headingReference: "true",
      latestPosition: { lat: 40.71579060521043, lng: -74.011422721738, accuracy: 5, timestamp: now },
      latestHeading: 0,
      latestHeadingTimestamp: now,
      latestHeadingReference: "true",
    },
  };
}

/** Generate valid in-memory image bytes; these tests never contact an image or AI provider. */
async function fixtureJpeg(): Promise<Buffer> {
  return sharp({ create: { width: 640, height: 640, channels: 3, background: "#426881" } })
    .jpeg()
    .toBuffer();
}

for (const scenario of ["missing metadata", "moved rotated uncertain GPS", "missing imagery", "indoor imagery"] as const) {
  test(`mobile sensor-blocked capture saves review evidence: ${scenario}`, async t => {
    // Exercise the inherited HTTP handler and the real safety gate, then await background storage.
    const request = captureRequest();
    if (scenario === "missing metadata") request.sensors = undefined;
    else {
      request.gpsAccuracyMeters = 45;
      request.sensors!.latestPosition.lat += 0.0002;
      request.sensors!.latestPosition.accuracy = 45;
      request.sensors!.latestHeading = 90;
    }
    const jpeg = await fixtureJpeg();
    const photo = `data:image/jpeg;base64,${jpeg.toString("base64")}`;
    let answer: any;
    let logged: any;
    let attachment: any;
    let downloads = 0;
    let finishAttachment!: () => void;
    const attached = new Promise<void>(resolve => {
      // Expose a completion signal for the asynchronous storage update.
      finishAttachment = resolve;
    });
    t.mock.method(lastMileTestLogService, "record", async (row: any) => {
      // Capture the unmodified failed trial and return its original record ID.
      logged = row;
      return "mobile-original-trial";
    });
    t.mock.method(lastMileTestLogService, "attachPanorama", async (id: string, update: any) => {
      // Ensure imagery is attached to that same trial, rather than creating or executing a retry.
      assert.equal(id, "mobile-original-trial");
      attachment = update;
      finishAttachment();
    });
    const service = new MobileLastMileService(async (id, location) => {
      // Keep the real review saver while replacing provider downloads with controlled evidence.
      await saveFieldReviewPanorama(id, location, async originalLocation => {
        // The recovery answer must precede downloading, and live GPS drift must not relocate imagery.
        assert.ok(answer, "The safety response must be sent before review downloads start");
        assert.deepEqual(originalLocation, { lat: request.lat, lng: request.lng });
        downloads++;
        if (scenario === "missing imagery" || scenario === "indoor imagery") {
          const error = new Error("No validated outdoor panorama");
          Object.assign(error, {
            code: "STREET_VIEW_NO_VALIDATED_OUTDOOR_PANORAMA",
            attempts: [{ status: scenario === "indoor imagery" ? "indoor" : "no_imagery", reason: scenario }],
          });
          throw error;
        }
        return {
          metadata: { status: "OK", pano_id: "review-only-pano", copyright: "Google", date: "2025-01" },
          attempts: [{ status: "accepted", reason: "Validated outdoor fixture" }],
          tiles: LAST_MILE_HEADINGS.map(heading => ({
            // Supply all required headings without a network dependency.
            heading, base64: photo,
          })),
        };
      });
    });
    const res = {
      /** Preserve the response adapter's normal chaining behavior. */
      status: () => res,
      /** Record the withheld response for ordering and guidance assertions. */
      json: (body: any) => { answer = body; },
    };

    await service.lastMileRequest({ req: {} as any, res: res as any }, request, photo);
    assert.equal(downloads, 0, "Provider work starts after the HTTP handler returns");
    assert.equal(answer.guidanceKind, "withheld");
    assert.equal(answer.warning, "turn_withheld");
    assert.equal(answer.targetHeading, null);
    assert.equal(answer.output, RECAPTURE_MESSAGE);
    assert.equal(logged.error, "turn_withheld");
    assert.deepEqual(logged.replayInput.sensors, request.sensors);
    assert.equal(logged.replayInput.lat, request.lat);
    assert.equal(logged.replayInput.lng, request.lng);
    assert.equal(logged.runKind, "field");
    assert.equal(logged.retryOf, undefined);
    if (scenario === "missing metadata") {
      assert.deepEqual(answer.safetyReasons, ["capture_metadata_missing"]);
    } else {
      assert.deepEqual(answer.safetyReasons, ["turned_since_capture", "moved_since_capture", "gps_uncertain"]);
    }

    await attached;
    assert.equal(downloads, 1);
    if (scenario === "missing imagery" || scenario === "indoor imagery") {
      assert.equal(attachment.panoramaPhoto, undefined);
      assert.equal(attachment.panoramaStatus, "STREET_VIEW_NO_VALIDATED_OUTDOOR_PANORAMA");
      assert.equal(attachment.panoramaValidation[0].reason, scenario);
    } else {
      assert.match(attachment.panoramaPhoto, /^data:image\/jpeg;base64,/);
      assert.equal(attachment.panoId, "review-only-pano");
      assert.deepEqual(attachment.panoramaHeadings, [...LAST_MILE_HEADINGS]);
      assert.equal(attachment.panoramaStatus, "OK");
    }
    assert.equal(logged.success, false, "Review imagery cannot promote the failed trial into guidance");
  });
}

for (const scenario of ["retry", "pinned panorama", "existing review", "question", "late safety gate", "missing log ID", "ordinary answer"] as const) {
  test(`mobile review adapter leaves shared execution unchanged: ${scenario}`, async t => {
    // Check the adapter boundary with a stubbed shared result and no provider access.
    const request = captureRequest();
    if (scenario !== "late safety gate") request.sensors = undefined;
    if (scenario === "question") request.destination = "When is the 2 train arriving?";
    const original: LastMetersRunResult = {
      kind: "response", status: 200, testLogId: "original",
      body: { guidanceKind: "withheld", warning: "turn_withheld", targetHeading: null },
      ...(scenario === "existing review" ? { reviewPanorama: Promise.resolve() } : {}),
    };
    if (scenario === "missing log ID") original.testLogId = undefined;
    if (scenario === "ordinary answer") original.body = { output: "Existing answer" };
    const calls: unknown[] = [];
    t.mock.method(OpenAIService.prototype, "runLastMeters", async (...args: unknown[]) => {
      // Verify that the original request, image, and retry options reach the shared pipeline intact.
      calls.push(args);
      return original;
    });
    let saves = 0;
    const service = new MobileLastMileService(async () => {
      // Detect any unintended extra background work for existing pipeline/retry outcomes.
      saves++;
    });
    const options = scenario === "retry"
      ? { retry: { retryOf: "root", panoramaMode: "fresh" as const, defaultsApplied: [], replayInput: buildReplayInput(request, "photo", Date.now()) } }
      : scenario === "pinned panorama"
        ? { pinnedPanorama: { status: "OK", pano_id: "pinned-original" } }
        : {};
    const result = await service.runLastMeters(request, "photo", options);
    assert.equal(result, original);
    assert.deepEqual(calls, [[request, "photo", options]]);
    assert.equal(saves, 0);
  });
}

test("mobile review storage failure cannot replace or reject a withheld answer", async t => {
  // A failed asynchronous attachment must settle without an unhandled rejection or a new response.
  t.mock.method(lastMileTestLogService, "record", async () => "storage-failure-trial");
  t.mock.method(console, "error", () => undefined);
  const request = captureRequest();
  request.sensors = undefined;
  const service = new MobileLastMileService(async () => {
    // Simulate unavailable storage after the safety result is already determined.
    throw new Error("storage unavailable");
  });
  const result = await service.runLastMeters(request, "photo");
  assert.equal(result.kind, "response");
  if (result.kind !== "response") return;
  assert.equal(result.body.guidanceKind, "withheld");
  await assert.doesNotReject(result.reviewPanorama!);
  assert.equal(result.body.targetHeading, null);
});

test("review status identifies the deployed adapter and actual provider capability", t => {
  // Diagnose deployment drift without creating a field trial or relying on a screenshot.
  const names = ["OPENAI_API_KEY", "GOOGLE_MAPS_API_KEY", "GOOGLE_API_KEY", "RENDER_GIT_COMMIT"];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  t.after(() => {
    // Restore the complete credential/commit fixture after checking the public status response.
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  });
  process.env.RENDER_GIT_COMMIT = "deployed-review-fix";
  process.env.OPENAI_API_KEY = "fixture-openai";
  process.env.GOOGLE_MAPS_API_KEY = "fixture-maps";
  assert.deepEqual(mobileReviewPanoramaStatus(), {
    version: "1.0.0", deployedCommit: "deployed-review-fix", enabled: true,
  });
  delete process.env.GOOGLE_MAPS_API_KEY;
  delete process.env.GOOGLE_API_KEY;
  assert.equal(mobileReviewPanoramaStatus().enabled, false);
});
