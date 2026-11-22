import { describe, expect, it } from "vite-plus/test";

import { trialFrom as trial } from "./fixtures";
import { summarizeTrials } from "./summary";

type Row = Parameters<typeof trial>[0];

// Expected numbers come from the old dashboard's renderSummary on the same rows.
const rows = [
  {
    reviewOutcome: "got_there",
    destination: "cvs",
    destinationPlaceName: "CVS",
    destinationPlaceAddress: "1 Main St",
    pipelineVersion: "3.0.0-safety-gated",
    serverTs: "2026-11-02T15:00:00Z",
    turnCorrectness: "correct",
    entranceCorrectness: "wrong",
  },
  {
    reviewOutcome: "would_not_get_there",
    destination: "cvs",
    destinationPlaceName: "CVS",
    destinationPlaceAddress: "1 Main St",
    pipelineVersion: "3.0.0-safety-gated",
    serverTs: "2026-11-01T15:00:00Z",
    turnCorrectness: "wrong",
    entranceCorrectness: "correct",
  },
  {
    reviewOutcome: "got_there",
    destination: "Duane Reade",
    serverTs: "2026-10-28T15:00:00Z",
    turnCorrectness: "no_turn_given",
    entranceCorrectness: "not_identified",
  },
  {
    reviewOutcome: "needed_retake",
    destination: "target",
    destinationPlaceName: "Target",
    destinationPlaceAddress: "5 Elm St",
    pipelineVersion: "2.9.0",
    serverTs: "2026-11-03T15:00:00Z",
  },
  // Unscored, but its turn was still scored.
  { destination: "cvs", serverTs: "2026-11-03T16:00:00Z", turnCorrectness: "wrong" },
  // Dashboard retries, replays and Questions are not field Trials.
  {
    retryOf: "a",
    reviewOutcome: "got_there",
    serverTs: "2026-11-04T15:00:00Z",
    turnCorrectness: "wrong",
    entranceCorrectness: "wrong",
  },
  { runKind: "replay", reviewOutcome: "got_there", serverTs: "2026-11-04T15:00:00Z" },
  {
    testScenario: "question_routed",
    reviewOutcome: "got_there",
    serverTs: "2026-11-04T15:00:00Z",
    turnCorrectness: "wrong",
  },
  { reviewOutcome: "got_there", createdAt: "garbage" },
] satisfies Row[];

describe("summarizeTrials", () => {
  const summary = summarizeTrials(rows.map(trial));

  it("gives the success rate of scored field Trials", () => {
    expect(summary).toMatchObject({ trials: 6, scored: 5, success: 3, rate: 60 });
  });

  it("groups scored Trials by week, newest first, with unknown weeks sorting before the rest", () => {
    expect(summary.byWeek).toEqual([
      { label: "Week of unknown", scored: 1, success: 1, rate: 100 },
      { label: "Week of 2026-11-02", scored: 2, success: 1, rate: 50 },
      { label: "Week of 2026-10-26", scored: 2, success: 1, rate: 50 },
    ]);
  });

  it("groups by the resolved place and address, falling back to the request", () => {
    expect(summary.byLocation).toEqual([
      { label: "CVS - 1 Main St", scored: 2, success: 1, rate: 50 },
      { label: "Duane Reade", scored: 1, success: 1, rate: 100 },
      { label: "Target - 5 Elm St", scored: 1, success: 0, rate: 0 },
      { label: "Unknown", scored: 1, success: 1, rate: 100 },
    ]);
  });

  it("groups by pipeline version in the order versions first appear", () => {
    expect(summary.byVersion).toEqual([
      { label: "3.0.0-safety-gated", scored: 2, success: 1, rate: 50 },
      { label: "legacy-unversioned", scored: 2, success: 2, rate: 100 },
      { label: "2.9.0", scored: 1, success: 0, rate: 0 },
    ]);
  });

  it("counts wrong turns and entrances among field Trials scored for them, scored outcome or not", () => {
    expect(summary.wrongTurns).toEqual({ wrong: 2, scored: 3 });
    expect(summary.wrongEntrances).toEqual({ wrong: 1, scored: 2 });
  });

  it("keeps the 12 locations with the most scored Trials", () => {
    const many = Array.from({ length: 13 }, (_, i) =>
      Array.from({ length: i + 1 }, () =>
        trial({
          reviewOutcome: i % 2 ? "got_there" : "needed_retake",
          destination: `Place ${i + 1}`,
          serverTs: "2026-11-02T15:00:00Z",
        }),
      ),
    ).flat();
    many.push(
      trial({
        reviewOutcome: "got_there",
        destination: "Place 13",
        serverTs: "2026-11-02T15:00:00Z",
      }),
    );

    const { byLocation } = summarizeTrials(many);

    expect(byLocation).toHaveLength(12);
    expect(byLocation[0]).toEqual({ label: "Place 13", scored: 14, success: 1, rate: 7 });
    expect(byLocation.at(-1)).toEqual({ label: "Place 2", scored: 2, success: 2, rate: 100 });
  });

  it("has no rate before any Trial is scored", () => {
    expect(summarizeTrials([])).toEqual({
      trials: 0,
      scored: 0,
      success: 0,
      rate: null,
      byWeek: [],
      byLocation: [],
      byVersion: [],
      wrongTurns: { wrong: 0, scored: 0 },
      wrongEntrances: { wrong: 0, scored: 0 },
    });
  });
});
