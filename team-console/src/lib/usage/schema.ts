import { z } from "zod";

import { maybe } from "#/lib/saved-fields";

// Shapes of mobile/server's /api/telemetry/summary and /api/feedback responses.
// Only the fields the console reads are listed; zod drops the rest.

const countByEvent = z.object({ name: z.string(), count: z.number() });

// mobile/server groups by the app's props.feature as sent, which may not be a string.
const countByFeature = z.object({ feature: z.coerce.string(), count: z.number() });

export const telemetrySummarySchema = z.object({
  source: z.string(),
  totalEvents: z.number(),
  uniqueInstalls: z.number(),
  byEvent: z.array(countByEvent),
  byFeature: z.array(countByFeature),
  answerMetrics: z.object({
    // Averaged from latencies the app sends; null when one of them was Infinity.
    avgLatencyMs: z
      .number()
      .nullable()
      .transform((latency) => latency ?? 0),
  }),
  aiRequests: z.object({
    totalRequests: z.number(),
    successRate: z.number(),
    byFeature: z.array(countByFeature.extend({ avgLatencyMs: z.number() })),
  }),
});
export type TelemetrySummary = z.output<typeof telemetrySummarySchema>;

const feedbackSchema = z.object({
  date: maybe(z.string()),
  type: maybe(z.string()),
  rating: maybe(z.number()),
  message: maybe(z.string()),
  appVersion: maybe(z.string()),
});
export type Feedback = z.output<typeof feedbackSchema>;

export const feedbackListSchema = z.object({ data: z.array(feedbackSchema) });
