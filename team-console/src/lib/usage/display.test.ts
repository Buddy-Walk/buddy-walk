import { describe, expect, it } from "vite-plus/test";

import { feedbackRating, summaryCards, withBars } from "./display";
import type { TelemetrySummary } from "./schema";

const summary: TelemetrySummary = {
  source: "mongo",
  totalEvents: 12,
  uniqueInstalls: 3,
  byEvent: [],
  byFeature: [],
  answerMetrics: { avgLatencyMs: 900 },
  aiRequests: { totalRequests: 9, successRate: 89, byFeature: [] },
};

describe("summaryCards", () => {
  it("lists the old page's six cards in its order", () => {
    expect(summaryCards(summary)).toEqual([
      { label: "Telemetry events", value: "12" },
      { label: "Unique installs", value: "3" },
      { label: "Avg answer latency (ms)", value: "900" },
      { label: "AI requests logged", value: "9" },
      { label: "AI success rate", value: "89%" },
      { label: "Data source", value: "mongo" },
    ]);
  });

  it("shows a zero success rate as 0%", () => {
    const none = { ...summary, aiRequests: { ...summary.aiRequests, successRate: 0 } };
    expect(summaryCards(none)[4]).toEqual({ label: "AI success rate", value: "0%" });
  });
});

describe("withBars", () => {
  it("sizes each bar against the largest count, rounded", () => {
    const rows = [
      { name: "a", count: 3 },
      { name: "b", count: 2 },
      { name: "c", count: 1 },
    ];
    expect(withBars(rows).map((row) => row.percent)).toEqual([100, 67, 33]);
  });

  it("keeps the row's own fields", () => {
    expect(withBars([{ feature: "directions", count: 4 }])).toEqual([
      { feature: "directions", count: 4, percent: 100 },
    ]);
  });

  it("draws no bars when every count is zero", () => {
    expect(withBars([{ name: "a", count: 0 }])[0]?.percent).toBe(0);
  });
});

describe("feedbackRating", () => {
  it("shows an answer rating as thumbs", () => {
    expect(feedbackRating({ type: "answer_rating", rating: 1 })).toBe("👍");
    expect(feedbackRating({ type: "answer_rating", rating: -1 })).toBe("👎");
  });

  it("shows other ratings as stars, including zero", () => {
    expect(feedbackRating({ type: "general", rating: 4 })).toBe("4★");
    expect(feedbackRating({ type: "bug", rating: 0 })).toBe("0★");
  });

  it("shows nothing when feedback has no rating", () => {
    expect(feedbackRating({ type: "general" })).toBeUndefined();
  });
});
