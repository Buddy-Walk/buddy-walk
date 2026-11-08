import { describe, expect, it } from "vite-plus/test";

import { feedbackListSchema, telemetrySummarySchema } from "./schema";

const summary = {
  source: "mongo",
  totalEvents: 12,
  uniqueInstalls: 3,
  byEvent: [{ name: "question_asked", count: 7 }],
  byFeature: [{ feature: "directions", count: 5 }],
  answerMetrics: { count: 4, avgLatencyMs: 900 },
  aiRequests: {
    source: "mongo",
    totalRequests: 9,
    successRate: 89,
    avgLatencyMs: 1200,
    byFeature: [{ feature: "question", count: 9, avgLatencyMs: 1200 }],
    byTool: [{ tool: "none", count: 9 }],
  },
};

describe("telemetrySummarySchema", () => {
  it("reads a summary as mobile/server sends it", () => {
    const parsed = telemetrySummarySchema.parse(summary);
    expect(parsed.totalEvents).toBe(12);
    expect(parsed.aiRequests.byFeature).toEqual([
      { feature: "question", count: 9, avgLatencyMs: 1200 },
    ]);
  });

  it("fails when a field mobile/server computes is missing", () => {
    const { totalEvents: _removed, ...withoutTotal } = summary;
    expect(telemetrySummarySchema.safeParse(withoutTotal).success).toBe(false);
  });

  // Anyone can post events, and an average that reaches Infinity is sent as null.
  it("shows an answer latency mobile/server couldn't average as 0, as the old page did", () => {
    const parsed = telemetrySummarySchema.parse({
      ...summary,
      answerMetrics: { count: 1, avgLatencyMs: null },
    });
    expect(parsed.answerMetrics.avgLatencyMs).toBe(0);
  });

  // props.feature is whatever the app sent, and mobile/server groups by it as it is.
  it("shows a feature the app sent as a non-string as its text", () => {
    const parsed = telemetrySummarySchema.parse({
      ...summary,
      byFeature: [{ feature: 42, count: 1 }],
    });
    expect(parsed.byFeature).toEqual([{ feature: "42", count: 1 }]);
  });
});

describe("feedbackListSchema", () => {
  it("reads the fields the page shows", () => {
    const parsed = feedbackListSchema.parse({
      source: "mongo",
      count: 1,
      data: [
        {
          _id: "abc",
          installId: "install-1",
          date: "2026-11-01T10:00:00.000Z",
          type: "answer_rating",
          rating: 1,
          message: "Helpful",
          appVersion: "1.2.0",
        },
      ],
    });
    expect(parsed.data).toEqual([
      {
        date: "2026-11-01T10:00:00.000Z",
        type: "answer_rating",
        rating: 1,
        message: "Helpful",
        appVersion: "1.2.0",
      },
    ]);
  });

  it("reads absent or null saved fields as missing", () => {
    const parsed = feedbackListSchema.parse({
      source: "memory",
      count: 1,
      data: [{ installId: "install-1", type: "general", rating: null }],
    });
    expect(parsed.data).toEqual([{ type: "general" }]);
  });

  it("fails when the list itself is missing", () => {
    expect(feedbackListSchema.safeParse({ source: "mongo", count: 0 }).success).toBe(false);
  });
});
