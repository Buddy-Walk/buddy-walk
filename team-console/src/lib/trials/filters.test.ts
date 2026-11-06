import { describe, expect, it } from "vite-plus/test";

import {
  activePreset,
  filterTrials,
  hasFilters,
  togglePreset,
  trialsSearchSchema,
  viewTrials,
  type TrialFilters,
} from "./filters";
import { trialFrom as trial } from "./fixtures";

const trials = [
  trial({
    _id: "exact",
    navigationMode: "exact",
    testScenario: "test_a_visible",
    hasPanorama: true,
    reviewOutcome: "got_there",
    destination: "CVS",
    destinationPlaceName: "CVS Pharmacy",
    destinationPlaceAddress: "1 Main St",
  }),
  trial({
    _id: "approach",
    navigationMode: "approach",
    testScenario: "test_b_approach",
    destination: "Target",
    destinationPlaceAddress: "5 Elm St",
  }),
  trial({
    _id: "aligned",
    navigationMode: "aligned",
    testScenario: "heading_aligned",
    hasPanorama: true,
    reviewOutcome: "would_not_get_there",
    destination: "Duane Reade",
  }),
  trial({
    _id: "unverified",
    testScenario: "destination_unverified",
    reviewOutcome: "needed_retake",
    destination: "Main street deli",
  }),
  trial({ _id: "odd", navigationMode: "walking", destination: "cvs on 5th" }),
];

const shown = (filters: TrialFilters) => filterTrials(trials, filters).map((t) => t._id);

// Expected rows come from the old dashboard's matchesFilters on the same Trials.
describe("filterTrials", () => {
  it("shows every Trial without filters", () => {
    expect(shown({})).toEqual(["exact", "approach", "aligned", "unverified", "odd"]);
  });

  it("filters by distance gate, counting unknown modes as none", () => {
    expect(shown({ mode: "approach" })).toEqual(["approach"]);
    expect(shown({ mode: "none" })).toEqual(["unverified", "odd"]);
  });

  it("filters by scenario, panorama and outcome", () => {
    expect(shown({ scenario: "heading_aligned" })).toEqual(["aligned"]);
    expect(shown({ panorama: "yes" })).toEqual(["exact", "aligned"]);
    expect(shown({ panorama: "no" })).toEqual(["approach", "unverified", "odd"]);
    expect(shown({ outcome: "unscored" })).toEqual(["approach", "odd"]);
    expect(shown({ outcome: "would_not_get_there" })).toEqual(["aligned"]);
  });

  it("finds text in the request, resolved place or address, ignoring case and outer spaces", () => {
    expect(shown({ q: "cvs" })).toEqual(["exact", "odd"]);
    expect(shown({ q: "MAIN" })).toEqual(["exact", "unverified"]);
    expect(shown({ q: "  main st " })).toEqual(["exact", "unverified"]);
  });

  it("combines filters", () => {
    expect(shown({ mode: "approach", panorama: "no" })).toEqual(["approach"]);
    expect(shown({ mode: "exact", panorama: "no" })).toEqual([]);
  });
});

describe("viewTrials", () => {
  it("summarizes every outcome, since filtering by one would make the rate 0% or 100%", () => {
    const { shown, summary } = viewTrials(trials, { outcome: "got_there", panorama: "yes" });

    expect(shown.map((t) => t._id)).toEqual(["exact"]);
    expect(summary).toMatchObject({ trials: 2, scored: 2, success: 1, rate: 50 });
  });
});

describe("presets", () => {
  it("is active only when the filters are exactly the preset", () => {
    expect(activePreset({ mode: "approach", panorama: "no" })).toBe("approachNoPanorama");
    expect(activePreset({ panorama: "no" })).toBe("noPanorama");
    expect(activePreset({ outcome: "unscored" })).toBe("needsReview");
    expect(activePreset({ outcome: "would_not_get_there" })).toBe("failed");
    expect(activePreset({ panorama: "no", q: "cvs" })).toBeUndefined();
    expect(activePreset({ panorama: "no", q: "  " })).toBe("noPanorama");
  });

  it("replaces the filters, and clears them when it was already active", () => {
    expect(togglePreset({ q: "cvs", mode: "exact" }, "noPanorama")).toEqual({ panorama: "no" });
    expect(togglePreset({ panorama: "no" }, "noPanorama")).toEqual({});
  });

  it("counts blank text as no filter", () => {
    expect(hasFilters({})).toBe(false);
    expect(hasFilters({ q: " " })).toBe(false);
    expect(hasFilters({ outcome: "unscored" })).toBe(true);
  });
});

describe("trialsSearchSchema", () => {
  it("opens with 200 Trials and no retries", () => {
    expect(trialsSearchSchema.parse({})).toEqual({ limit: 200, includeRetries: false });
  });

  it("reopens a shared view", () => {
    const shared = {
      limit: 50,
      mode: "approach",
      scenario: "test_b_approach",
      panorama: "no",
      outcome: "unscored",
      q: "cvs",
      includeRetries: true,
    };

    expect(trialsSearchSchema.parse(shared)).toEqual(shared);
  });

  it("caps the limit at the 500 mobile/server returns", () => {
    expect(trialsSearchSchema.parse({ limit: 900 }).limit).toBe(500);
  });

  it("falls back to the default for values it doesn't know", () => {
    expect(
      trialsSearchSchema.parse({
        limit: 0,
        mode: "sideways",
        scenario: "test_z",
        panorama: "maybe",
        outcome: "great",
        q: 5,
        includeRetries: "yes",
      }),
    ).toEqual({ limit: 200, includeRetries: false });
  });
});
