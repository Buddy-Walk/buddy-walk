import { z } from "zod";

import { MAX_LIMIT } from "./filters";

/** What the view loads from mobile/server; the other filters apply to the loaded Trials. */
export interface TrialsView {
  limit: number;
  includeRetries: boolean;
}

/** A view as mobile/server's list and export read it. */
export function viewParams({ limit, includeRetries }: TrialsView): Record<string, string> {
  return { limit: String(limit), ...(includeRetries ? { includeRetries: "true" } : {}) };
}

/** The console's own export route, so the token never appears in a URL. */
export function exportHref(view: TrialsView): string {
  return `/api/trials/export.csv?${new URLSearchParams(viewParams(view))}`;
}

const exportParamsSchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT),
  includeRetries: z
    .string()
    .optional()
    .transform((value) => value === "true"),
});

/** The view an export link asks for, or undefined when it isn't a valid one. */
export function parseExportParams(search: URLSearchParams): TrialsView | undefined {
  return exportParamsSchema.safeParse(Object.fromEntries(search)).data;
}
