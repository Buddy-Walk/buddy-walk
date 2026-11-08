import { queryOptions } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { viewParams } from "#/lib/trials/export";
import { MAX_LIMIT } from "#/lib/trials/filters";
import { reviewInputSchema, reviewRequest } from "#/lib/trials/review";
import {
  savedReviewResponseSchema,
  trialDetailResponseSchema,
  trialListResponseSchema,
} from "#/lib/trials/schema";
import { callApi } from "#/server/api";

/**
 * Checks a response from one of mobile/server's Last Meters endpoints against
 * its schema. A change to the fields mobile/server computes fails here; saved
 * fields from older Trials read as missing (see schema.ts).
 */
async function parseResponse<T extends z.ZodType>(
  path: string,
  response: Response,
  schema: T,
): Promise<z.output<T>> {
  const parsed = schema.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error(
      `mobile/server's response to ${path} has an unexpected shape:\n${z.prettifyError(parsed.error)}`,
    );
  }
  return parsed.data;
}

async function getFromApi<T extends z.ZodType>(
  path: string,
  params: Record<string, string>,
  schema: T,
): Promise<z.output<T>> {
  return parseResponse(path, await callApi(path, { params }), schema);
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
      viewParams(data),
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

/** Saves a Trial's review and returns it as saved, which is what the console shows. */
export const saveReview = createServerFn({ method: "POST" })
  .validator(reviewInputSchema.extend({ trialId: z.string().min(1) }))
  .handler(async ({ data: { trialId, ...review } }) => {
    const path = `/api/last-meters-tests/${encodeURIComponent(trialId)}/review`;
    const response = await callApi(path, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(reviewRequest(review)),
    });
    const { data: saved } = await parseResponse(path, response, savedReviewResponseSchema);
    return saved;
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
