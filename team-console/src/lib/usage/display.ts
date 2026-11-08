import type { Feedback, TelemetrySummary } from "./schema";

/** The summary's headline numbers, in the order the page shows them. */
export function summaryCards(summary: TelemetrySummary): { label: string; value: string }[] {
  return [
    { label: "Telemetry events", value: String(summary.totalEvents) },
    { label: "Unique installs", value: String(summary.uniqueInstalls) },
    { label: "Avg answer latency (ms)", value: String(summary.answerMetrics.avgLatencyMs) },
    { label: "AI requests logged", value: String(summary.aiRequests.totalRequests) },
    { label: "AI success rate", value: `${summary.aiRequests.successRate}%` },
    { label: "Data source", value: summary.source },
  ];
}

/** Adds each row's bar width, as a percent of the largest count. */
export function withBars<T extends { count: number }>(rows: T[]): (T & { percent: number })[] {
  const max = Math.max(1, ...rows.map((row) => row.count));
  return rows.map((row) => ({ ...row, percent: Math.round((row.count / max) * 100) }));
}

/** Answer ratings are thumbs up or down; other feedback may carry a star rating. */
export function feedbackRating({
  type,
  rating,
}: Pick<Feedback, "type" | "rating">): string | undefined {
  if (type === "answer_rating") return rating !== undefined && rating > 0 ? "👍" : "👎";
  return rating === undefined ? undefined : `${rating}★`;
}
