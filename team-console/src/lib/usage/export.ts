import { z } from "zod";

export const dateRangeSchema = z.object({
  since: z.iso.date().optional(),
  until: z.iso.date().optional(),
});
export type DateRange = z.output<typeof dateRangeSchema>;

/** The /usage search params. A date the console can't read is dropped, so an edited link still opens. */
export const usageSearchSchema = z.object({
  since: dateRangeSchema.shape.since.catch(undefined),
  until: dateRangeSchema.shape.until.catch(undefined),
});

/** A date range as mobile/server's summary and exports read it. */
export function rangeParams({ since, until }: DateRange): Record<string, string> {
  return { ...(since ? { since } : {}), ...(until ? { until } : {}) };
}

const USAGE_EXPORTS = {
  "events.csv": { path: "/api/telemetry/events.csv", filename: "telemetry_events.csv" },
  "ai-requests.csv": { path: "/api/telemetry/ai-requests.csv", filename: "ai_requests.csv" },
  "feedback.csv": { path: "/api/feedback/export.csv", filename: "feedback.csv" },
  "chat-logs.csv": { path: "/api/db/chatlogs.csv", filename: "chat_logs.csv" },
};
export type UsageExportFile = keyof typeof USAGE_EXPORTS;

const exportsByFile = new Map(Object.entries(USAGE_EXPORTS));

/** Where one of the console's usage exports comes from, or undefined when there is no such export. */
export function usageExport(file: string) {
  return exportsByFile.get(file);
}

/** The console's own export route, so the token never appears in a URL. */
export function usageExportHref(file: UsageExportFile, range: DateRange): string {
  const query = new URLSearchParams(rangeParams(range)).toString();
  return `/api/usage/${file}${query ? `?${query}` : ""}`;
}

/** The range an export link asks for, or undefined when a date isn't valid. */
export function parseDateRange(search: URLSearchParams): DateRange | undefined {
  return dateRangeSchema.safeParse(Object.fromEntries(search)).data;
}
