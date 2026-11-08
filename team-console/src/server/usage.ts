import { queryOptions } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";

import { dateRangeSchema, rangeParams, type DateRange } from "#/lib/usage/export";
import { feedbackListSchema, telemetrySummarySchema } from "#/lib/usage/schema";
import { getFromApi } from "#/server/api";

const FEEDBACK_LIMIT = 100;
const REFRESH_INTERVAL = 30_000;

/** Telemetry and AI request totals for the date range. */
export const getTelemetrySummary = createServerFn()
  .validator(dateRangeSchema)
  .handler(({ data }) =>
    getFromApi("/api/telemetry/summary", rangeParams(data), telemetrySummarySchema),
  );

/** The newest feedback. mobile/server's list takes no dates, so it doesn't follow the filters. */
export const listFeedback = createServerFn().handler(async () => {
  const { data } = await getFromApi(
    "/api/feedback",
    { limit: String(FEEDBACK_LIMIT) },
    feedbackListSchema,
  );
  return data;
});

// A failed load shows at once beside Refresh, and the next interval tries again.
export const telemetrySummaryQuery = (range: DateRange) =>
  queryOptions({
    queryKey: ["usage", "summary", range],
    queryFn: () => getTelemetrySummary({ data: range }),
    retry: false,
    refetchInterval: REFRESH_INTERVAL,
  });

export const feedbackQuery = queryOptions({
  queryKey: ["usage", "feedback"],
  queryFn: () => listFeedback(),
  retry: false,
  refetchInterval: REFRESH_INTERVAL,
});
