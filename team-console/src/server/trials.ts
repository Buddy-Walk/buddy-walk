import { queryOptions, type Query } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { viewParams } from "#/lib/trials/export";
import { MAX_LIMIT } from "#/lib/trials/filters";
import { retryAnswerFrom } from "#/lib/trials/retry";
import { reviewInputSchema, reviewRequest } from "#/lib/trials/review";
import {
  PANORAMA_MODES,
  savedReviewResponseSchema,
  trialDetailResponseSchema,
  trialListResponseSchema,
} from "#/lib/trials/schema";
import { callApi, fetchApi, getFromApi, parseResponse } from "#/server/api";

const trialsParams = z.object({
  limit: z.number().int().min(1).max(MAX_LIMIT),
  includeRetries: z.boolean(),
});
export type TrialsParams = z.output<typeof trialsParams>;

/** The newest Trials, without images, which only the detail loads, and whether retries are on. */
export const listTrials = createServerFn()
  .validator(trialsParams)
  .handler(async ({ data }) => {
    const { data: trials, retry } = await getFromApi(
      "/api/last-meters-tests",
      viewParams(data),
      trialListResponseSchema,
    );
    return { trials, retry };
  });
export type TrialList = Awaited<ReturnType<typeof listTrials>>;

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

/** A Trial's retry history and replay facts, without the images the detail loads. */
export const getTrialRuns = createServerFn()
  .validator(z.object({ trialId: z.string().min(1) }))
  .handler(async ({ data }) => {
    const { data: trial } = await getFromApi(
      `/api/last-meters-tests/${encodeURIComponent(data.trialId)}`,
      {},
      trialDetailResponseSchema,
    );
    return trial;
  });

/**
 * Sends one retry, which runs for as long as the pipeline takes. Its answer is
 * returned rather than thrown, so the browser can tell a refusal from a failed
 * send and send it again under the same key.
 */
export const retryTrial = createServerFn({ method: "POST" })
  .validator(
    z.object({
      trialId: z.string().min(1),
      panoramaMode: z.enum(PANORAMA_MODES),
      idempotencyKey: z.uuid(),
    }),
  )
  .handler(async ({ data: { trialId, panoramaMode, idempotencyKey } }) => {
    const response = await fetchApi(`/api/last-meters-tests/${encodeURIComponent(trialId)}/retry`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
      body: JSON.stringify({ panoramaMode }),
    });
    const body: unknown = await response.json().catch(() => undefined);
    return retryAnswerFrom(response.status, body);
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

// Under the detail's key, so a saved review reaches its retry history here too.
// Light enough to fetch on every open and poll while a retry runs.
export const trialRunsQuery = (trialId: string) =>
  queryOptions({
    queryKey: ["trial", trialId, "runs"],
    queryFn: () => getTrialRuns({ data: { trialId } }),
    retry: false,
    staleTime: 0,
  });

export const isTrialRunsQuery = (query: Query) => query.queryKey[2] === "runs";
