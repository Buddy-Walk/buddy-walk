import { queryOptions } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";
import { z } from "zod";

import { MAX_LIMIT } from "#/lib/trials/filters";
import { trialDetailResponseSchema, trialListResponseSchema } from "#/lib/trials/schema";

/**
 * GETs one of mobile/server's Last Meters endpoints as the team, and checks the
 * response against its schema. A change to the fields mobile/server computes
 * fails here; saved fields from older Trials read as missing (see schema.ts).
 */
async function getFromApi<T extends z.ZodType>(
  path: string,
  params: Record<string, string>,
  schema: T,
): Promise<z.output<T>> {
  if (!env.API_BASE_URL) throw new Error("API_BASE_URL is not set for the Team console.");
  const url = new URL(path, env.API_BASE_URL);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);

  const response = await fetch(url, {
    headers: env.ADMIN_TOKEN ? { "x-admin-token": env.ADMIN_TOKEN } : {},
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const parsed = schema.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error(
      `mobile/server's response to ${path} has an unexpected shape:\n${z.prettifyError(parsed.error)}`,
    );
  }
  return parsed.data;
}

const trialsParams = z.object({
  limit: z.number().int().min(1).max(MAX_LIMIT),
  includeRetries: z.boolean(),
});
export type TrialsParams = z.output<typeof trialsParams>;

/** The newest Trials, without images, which only the detail loads. */
export const listTrials = createServerFn()
  .validator(trialsParams)
  .handler(async ({ data }) => {
    const { data: trials } = await getFromApi(
      "/api/last-meters-tests",
      {
        limit: String(data.limit),
        ...(data.includeRetries ? { includeRetries: "true" } : {}),
      },
      trialListResponseSchema,
    );
    return trials;
  });

/** One Trial with its photo, saved Street View images and retry history. */
export const getTrial = createServerFn()
  .validator(z.object({ trialId: z.string().min(1) }))
  .handler(async ({ data }) => {
    const { data: trial } = await getFromApi(
      `/api/last-meters-tests/${encodeURIComponent(data.trialId)}`,
      { includeImages: "true", includeStreetView: "true" },
      trialDetailResponseSchema,
    );
    return trial;
  });

// A failed load shows at once, with Refresh or Try again beside it, as the old page did.
export const trialsQuery = (params: TrialsParams) =>
  queryOptions({
    queryKey: ["trials", params],
    queryFn: () => listTrials({ data: params }),
    retry: false,
  });

// Fetched again each time a Trial opens, since its review panorama is saved
// after the answer; not on window focus, since it carries about 1 MB of images.
export const trialQuery = (trialId: string) =>
  queryOptions({
    queryKey: ["trial", trialId],
    queryFn: () => getTrial({ data: { trialId } }),
    retry: false,
    staleTime: 0,
    refetchOnWindowFocus: false,
  });
