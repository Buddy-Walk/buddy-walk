/** Shapes Last Meters test log rows for the admin API and dashboard. */

import type { lastMileTestLogInterface } from "../database/models/lastMileTestLog";

export interface LastMileTestImageFields {
  userPhoto?: string;
  panoramaPhoto?: string;
  destinationPhoto?: string;
}

export interface LastMileTestImageFlags {
  hasUserPhoto: boolean;
  hasPanorama: boolean;
  hasDestinationPhoto: boolean;
}

export const LAST_MILE_TEST_IMAGE_FIELDS = ["userPhoto", "panoramaPhoto", "destinationPhoto"] as const;
export type LastMileTestImageField = (typeof LAST_MILE_TEST_IMAGE_FIELDS)[number];

/** What list views need to know about each image, read without the image itself. */
export interface LastMileTestImageStats {
  imageStats: Record<LastMileTestImageField, { length: number; stored: boolean }>;
}

/** A log row's id as a string, whether Mongo or the in-memory store gave it. */
export function rowId(row: object): string {
  return String((row as { _id?: unknown })._id ?? "");
}

/** Only data URLs are stored images the dashboard can render. */
export function isStoredImage(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("data:");
}

function placeholderForLength(length: number): string {
  return length > 0 ? `[base64 image ${length} chars]` : "";
}

export function imagePlaceholder(value?: string): string {
  return placeholderForLength(value?.length ?? 0);
}

export function imageStatsOf(row: LastMileTestImageFields): LastMileTestImageStats["imageStats"] {
  const stats = (value?: string) => ({ length: value?.length ?? 0, stored: isStoredImage(value) });
  return {
    userPhoto: stats(row.userPhoto),
    panoramaPhoto: stats(row.panoramaPhoto),
    destinationPhoto: stats(row.destinationPhoto),
  };
}

/** The same list-view shape as toLastMileTestResponse(row, false), for rows read without images. */
export function toLastMileTestSummaryResponse<T extends LastMileTestImageStats>(row: T) {
  const { imageStats, ...rest } = row;
  return {
    ...rest,
    hasUserPhoto: imageStats.userPhoto.stored,
    hasPanorama: imageStats.panoramaPhoto.stored,
    hasDestinationPhoto: imageStats.destinationPhoto.stored,
    userPhoto: placeholderForLength(imageStats.userPhoto.length),
    panoramaPhoto: placeholderForLength(imageStats.panoramaPhoto.length),
    destinationPhoto: placeholderForLength(imageStats.destinationPhoto.length),
  };
}

/**
 * Adds explicit image presence flags and, unless includeImages is set, swaps the
 * base64 payloads for short placeholders so list views stay light.
 */
export function toLastMileTestResponse<T extends LastMileTestImageFields>(
  row: T,
  includeImages: boolean,
  includeStreetView = false
): T & LastMileTestImageFlags {
  const flags: LastMileTestImageFlags = {
    hasUserPhoto: isStoredImage(row.userPhoto),
    hasPanorama: isStoredImage(row.panoramaPhoto),
    hasDestinationPhoto: isStoredImage(row.destinationPhoto),
  };
  if (includeImages) {
    return {
      ...row,
      ...flags,
      // Only an explicitly requested single-trial detail includes Street View.
      panoramaPhoto: includeStreetView ? row.panoramaPhoto : imagePlaceholder(row.panoramaPhoto),
      destinationPhoto: includeStreetView ? row.destinationPhoto : imagePlaceholder(row.destinationPhoto),
    };
  }
  return {
    ...row,
    ...flags,
    userPhoto: imagePlaceholder(row.userPhoto),
    panoramaPhoto: imagePlaceholder(row.panoramaPhoto),
    destinationPhoto: imagePlaceholder(row.destinationPhoto),
  };
}

/** The facts the retry history shows for one run, typed from the log model. */
export type RetryHistoryFields = { _id?: unknown } & Partial<
  Pick<
    lastMileTestLogInterface,
    | "serverTs"
    | "retryOf"
    | "retryPanoramaMode"
    | "retryDefaultsApplied"
    | "panoId"
    | "panoramaDate"
    | "panoramaSource"
    | "panoramaStatus"
    | "navigationMode"
    | "testScenario"
    | "success"
    | "error"
    | "finalOutput"
    | "reviewerStatus"
    | "reviewOutcome"
    | "pipelineVersion"
    | "deployedCommit"
    | "safetyReasons"
    | "latencyMs"
  >
>;

/** One history entry: the original test or one of its retries, without images. */
export function toRetryHistoryEntry(row: RetryHistoryFields) {
  return {
    id: String(row._id ?? ""),
    serverTs: row.serverTs,
    isRetry: Boolean(row.retryOf),
    panoramaMode: row.retryPanoramaMode,
    defaultsApplied: row.retryDefaultsApplied ?? [],
    panoId: row.panoId,
    panoramaDate: row.panoramaDate,
    panoramaSource: row.panoramaSource,
    panoramaStatus: row.panoramaStatus,
    navigationMode: row.navigationMode,
    testScenario: row.testScenario,
    success: row.success,
    error: row.error,
    finalOutput: row.finalOutput,
    reviewerStatus: row.reviewerStatus,
    reviewOutcome: row.reviewOutcome,
    pipelineVersion: row.pipelineVersion,
    deployedCommit: row.deployedCommit,
    safetyReasons: row.safetyReasons ?? [],
    latencyMs: row.latencyMs,
  };
}
