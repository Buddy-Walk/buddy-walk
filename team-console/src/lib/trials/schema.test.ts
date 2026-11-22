import { describe, expect, it } from "vite-plus/test";

import { trialDetailResponseSchema, trialListResponseSchema } from "./schema";

const retriesOn = { available: true };

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
      reviewerStatus: "pass",
      hasPanorama: false,
      retryCount: 2,
    });
    expect(trial.steps[0]).toMatchObject({ name: "confidence_fusion", success: true });
  });

  it("reads null and absent fields as missing", () => {
    const [trial] = trialListResponseSchema.parse({ retry: retriesOn, data: [listRow] }).data;

    expect(trial.panoramaMatchedHeading).toBeUndefined();
    expect(trial.safetyReasons).toEqual([]);
    expect(trial.moduleTimingsMs).toBeUndefined();
  });

  it("drops the image placeholders the list sends", () => {
    const [trial] = trialListResponseSchema.parse({ retry: retriesOn, data: [listRow] }).data;

    expect(trial).not.toHaveProperty("userPhoto");
  });

  it("rejects a row without an id", () => {
    const { _id, ...withoutId } = listRow;

    expect(() => trialListResponseSchema.parse({ retry: retriesOn, data: [withoutId] })).toThrow();
  });

  it("keeps a Trial saved in an older shape, reading its unknown values as missing", () => {
    const [trial] = trialListResponseSchema.parse({
      retry: retriesOn,
      data: [
        {
          ...listRow,
          reviewOutcome: "great",
          runKind: "legacy",
          gpsAccuracyMeters: "12",
          walkingEvidence: true,
          moduleTimingsMs: { preCheck: "fast", guidance: 900 },
        },
      ],
    }).data;

    expect(trial._id).toBe(listRow._id);
    expect(trial.reviewOutcome).toBeUndefined();
    expect(trial.runKind).toBeUndefined();
    expect(trial.gpsAccuracyMeters).toBeUndefined();
    expect(trial.walkingEvidence).toBeUndefined();
    expect(trial.moduleTimingsMs).toEqual({ guidance: 900 });
  });

  it("leaves out list items saved in an older shape", () => {
    const [trial] = trialListResponseSchema.parse({
      retry: retriesOn,
      data: [
        {
          ...listRow,
          steps: ["confidence_fusion", { name: "confidence_fusion", success: "yes" }],
          safetyReasons: ["low_light", 3],
          placesSearches: "CVS",
        },
      ],
    }).data;

    expect(trial.steps).toEqual([{ name: "confidence_fusion" }]);
    expect(trial.safetyReasons).toEqual(["low_light"]);
    expect(trial.placesSearches).toEqual([]);
  });
});

describe("retry facts", () => {
  const row = (fields: Record<string, unknown>) =>
    trialListResponseSchema.parse({ retry: retriesOn, data: [{ ...listRow, ...fields }] }).data[0];

  it("reads how a Trial can be replayed", () => {
    const { replay } = row({
      replay: {
        status: "replayable_with_defaults",
        defaultsApplied: ["compass accuracy level 3"],
        originalPanorama: { available: true, panoId: "panoA", panoramaDate: "2025-06" },
      },
    });
    expect(replay).toEqual({
      status: "replayable_with_defaults",
      defaultsApplied: ["compass accuracy level 3"],
      originalPanorama: { available: true, panoId: "panoA", panoramaDate: "2025-06" },
    });
  });

  it("reads a retry running on the server", () => {
    expect(
      row({ runningRetry: { panoramaMode: "original", startedAt: 1730000000000 } }),
    ).toMatchObject({
      runningRetry: { panoramaMode: "original", startedAt: 1730000000000 },
    });
  });

  it("reads no running retry as none", () => {
    expect(row({ runningRetry: null }).runningRetry).toBeUndefined();
  });

  it("fails when mobile/server changes the retry facts it computes", () => {
    expect(() => row({ runningRetry: { panoramaMode: "legacy", startedAt: 1 } })).toThrow();
    expect(() => row({ replay: undefined })).toThrow();
    expect(() => row({ replay: { status: "maybe", defaultsApplied: [] } })).toThrow();
  });

  it("keeps a saved panorama value in an older shape from failing the row", () => {
    const { replay } = row({
      replay: {
        status: "replayable",
        defaultsApplied: [],
        originalPanorama: { available: true, panoId: "panoA", panoramaDate: 202506 },
      },
    });
    expect(replay.originalPanorama).toEqual({ available: true, panoId: "panoA" });
  });

  it("reads whether retries are on for the server", () => {
    const off = { available: false, reason: "Set OPENAI_API_KEY." };
    expect(trialListResponseSchema.parse({ data: [], retry: off }).retry).toEqual(off);
  });

  it("fails a response that doesn't say whether retries are on", () => {
    expect(() => trialListResponseSchema.parse({ data: [] })).toThrow();
  });

  it("reads the retry running on a detail's history", () => {
    const { data } = trialDetailResponseSchema.parse({
      data: {
        ...listRow,
        history: {
          originalId: listRow._id,
          original: null,
          retries: [],
          runningRetry: { panoramaMode: "fresh", startedAt: 1730000000000 },
        },
      },
    });
    expect(data.history?.runningRetry).toEqual({ panoramaMode: "fresh", startedAt: 1730000000000 });
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
    reviewerStatus: "fail",
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
    expect(data.history?.retries[0]).toMatchObject({
      isRetry: true,
      panoramaMode: "original",
      reviewerStatus: "fail",
    });
  });

  it("keeps Places candidates and history entries saved in an older shape", () => {
    const { data } = trialDetailResponseSchema.parse({
      data: {
        ...listRow,
        placeCandidates: [{ address: "1 Main St", types: "pharmacy" }],
        history: {
          originalId: listRow._id,
          original: null,
          retries: [{ ...historyEntry, panoramaMode: "legacy", reviewOutcome: "great" }],
        },
      },
    });

    expect(data.placeCandidates).toEqual([{ address: "1 Main St", types: [] }]);
    expect(data.history?.retries[0]).toMatchObject({ id: historyEntry.id, isRetry: true });
    expect(data.history?.retries[0].panoramaMode).toBeUndefined();
    expect(data.history?.retries[0].reviewOutcome).toBeUndefined();
  });

  it("reads a detail without history as having none", () => {
    const { data } = trialDetailResponseSchema.parse({ data: listRow });

    expect(data.history).toBeUndefined();
    expect(data.placeCandidates).toEqual([]);
  });
});
