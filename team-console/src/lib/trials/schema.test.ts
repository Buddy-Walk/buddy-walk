import { describe, expect, it } from "vite-plus/test";

import { trialDetailResponseSchema, trialListResponseSchema } from "./schema";

// A list row as mobile/server's list() sends it: the summary response plus retry facts.
const listRow = {
  _id: "6720f1c2a1b2c3d4e5f60718",
  pipelineVersion: "3.0.0-safety-gated",
  runKind: "field",
  destination: "CVS",
  lat: 40.7,
  lng: -73.9,
  serverTs: "2026-11-02T15:04:05.000Z",
  navigationMode: "exact",
  testScenario: "test_a_visible",
  destinationDistanceMeters: 31.4,
  panoramaMatchedHeading: null,
  panoramaHeadings: [0, 45],
  steps: [{ name: "confidence_fusion", prompt: "p", model: "gpt", success: true }],
  reviewerStatus: "pass",
  reviewOutcome: "got_there",
  success: true,
  latencyMs: 8100,
  hasUserPhoto: true,
  hasPanorama: false,
  hasDestinationPhoto: false,
  userPhoto: "[base64 image 1200 chars]",
  panoramaPhoto: "",
  destinationPhoto: "",
  retryCount: 2,
  replay: { status: "replayable", defaultsApplied: [], originalPanorama: { available: false } },
  runningRetry: null,
  placeCandidateCount: 3,
};

describe("trialListResponseSchema", () => {
  it("reads a Trial row as mobile/server sends it", () => {
    const [trial] = trialListResponseSchema.parse({
      source: "mongo",
      retry: { available: true },
      data: [listRow],
    }).data;

    expect(trial).toMatchObject({
      _id: "6720f1c2a1b2c3d4e5f60718",
      destination: "CVS",
      destinationDistanceMeters: 31.4,
      reviewOutcome: "got_there",
      hasPanorama: false,
      retryCount: 2,
    });
    expect(trial.steps[0]).toMatchObject({ name: "confidence_fusion", success: true });
  });

  it("reads null and absent fields as missing", () => {
    const [trial] = trialListResponseSchema.parse({ data: [listRow] }).data;

    expect(trial.panoramaMatchedHeading).toBeUndefined();
    expect(trial.safetyReasons).toEqual([]);
    expect(trial.moduleTimingsMs).toBeUndefined();
  });

  it("drops the image placeholders the list sends", () => {
    const [trial] = trialListResponseSchema.parse({ data: [listRow] }).data;

    expect(trial).not.toHaveProperty("userPhoto");
  });

  it("rejects a row without an id", () => {
    const { _id, ...withoutId } = listRow;

    expect(() => trialListResponseSchema.parse({ data: [withoutId] })).toThrow();
  });

  it("rejects an outcome mobile/server doesn't define", () => {
    expect(() =>
      trialListResponseSchema.parse({ data: [{ ...listRow, reviewOutcome: "great" }] }),
    ).toThrow();
  });
});

describe("trialDetailResponseSchema", () => {
  const historyEntry = {
    id: "6720f1c2a1b2c3d4e5f60719",
    serverTs: "2026-11-03T10:00:00.000Z",
    isRetry: true,
    panoramaMode: "original",
    defaultsApplied: ["compass accuracy"],
    testScenario: "test_a_reference",
    success: false,
    error: "destination_not_visible",
    safetyReasons: [],
    latencyMs: 9000,
  };

  it("reads a Trial's images, Places candidates and retry history", () => {
    const { data } = trialDetailResponseSchema.parse({
      source: "mongo",
      retry: { available: false, reason: "off" },
      data: {
        ...listRow,
        userPhoto: "data:image/jpeg;base64,AAAA",
        panoramaPhoto: "data:image/jpeg;base64,BBBB",
        placeCandidates: [
          {
            name: "CVS",
            address: "1 Main St",
            distanceMeters: 30,
            types: [],
            relevant: true,
            source: "nearby",
          },
        ],
        history: {
          originalId: listRow._id,
          original: null,
          retries: [historyEntry],
          runningRetry: null,
        },
      },
    });

    expect(data.userPhoto).toBe("data:image/jpeg;base64,AAAA");
    expect(data.placeCandidates[0]).toMatchObject({ name: "CVS", relevant: true });
    expect(data.history?.original).toBeNull();
    expect(data.history?.retries[0]).toMatchObject({ isRetry: true, panoramaMode: "original" });
  });

  it("reads a detail without history as having none", () => {
    const { data } = trialDetailResponseSchema.parse({ data: listRow });

    expect(data.history).toBeUndefined();
    expect(data.placeCandidates).toEqual([]);
  });
});
