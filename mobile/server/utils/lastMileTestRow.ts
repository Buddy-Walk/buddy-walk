/** Shapes Last Meters test log rows for the admin API and dashboard. */

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
  includeImages: boolean
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
      // Legacy panorama composites are huge and not shown on the dashboard.
      panoramaPhoto: imagePlaceholder(row.panoramaPhoto),
      destinationPhoto: imagePlaceholder(row.destinationPhoto),
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
