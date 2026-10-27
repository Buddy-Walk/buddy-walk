import mongoose from "mongoose";
import sharp from "sharp";
import lastMetersTestLogModel, {
  lastMetersTestLogInterface,
} from "../database/models/lastMetersTestLog";
import {
  isMongoConnected,
  memoryLastMetersTests,
  pushMemoryLastMetersTest,
} from "../database/usageStore";
import {
  imageStatsOf,
  LAST_METERS_TEST_IMAGE_FIELDS,
  rowId,
  withOriginalPhoto,
  type LastMetersTestImageField,
  type LastMetersTestImageStats,
} from "../utils/lastMetersTestRow";
import {
  LAST_METERS_PIPELINE_VERSION,
  STORED_PHOTO_JPEG_QUALITY,
  STORED_PHOTO_MAX_WIDTH,
  UPSTREAM_PIPELINE_VERSION,
  deployedCommit,
  hasReplayablePhoto,
} from "../utils/lastMetersReplay";

type UnstampedLastMetersTestLog = Omit<
  lastMetersTestLogInterface,
  "serverTs" | "pipelineVersion" | "deployedCommit"
>;

export type LastMetersTestSummary = Omit<lastMetersTestLogInterface, LastMetersTestImageField> &
  LastMetersTestImageStats & {
    /** Whether the stored user photo can be replayed, read without the photo. */
    userPhotoReplayable: boolean;
  };


/**
 * Image lengths and data-URL checks computed inside MongoDB. Each trial carries
 * about 1 MB of base64 images, and pulling them for a whole list exhausts the
 * Render free instance's memory and CPU.
 */
function imageStatsOfField(field: string) {
  const value = { $ifNull: [field, ""] };
  return {
    length: { $strLenCP: value },
    stored: { $eq: [{ $substrCP: [value, 0, 5] }, "data:"] },
  };
}

/** Mirrors hasReplayablePhoto. */
function photoReplayable(field: string) {
  return { $regexMatch: { input: { $ifNull: [field, ""] }, regex: "^data:image/[\\w.+-]+;base64,." } };
}

const IMAGE_STATS_STAGE = {
  $addFields: {
    imageStats: Object.fromEntries(
      LAST_METERS_TEST_IMAGE_FIELDS.map((field) => [field, imageStatsOfField(`$${field}`)] as const)
    ),
    userPhotoReplayable: photoReplayable("$userPhoto"),
  },
};

/**
 * Looks up a retry's original into retryOriginal, keeping only `project` of
 * it. Rows that are not retries match nothing.
 */
function retryOriginalStages(project: Record<string, unknown>) {
  return [
    {
      $set: {
        retryOriginalId: { $convert: { input: "$retryOf", to: "objectId", onError: null, onNull: null } },
      },
    },
    {
      $lookup: {
        from: lastMetersTestLogModel.collection.name,
        localField: "retryOriginalId",
        foreignField: "_id",
        pipeline: [{ $project: { _id: 0, ...project } }],
        as: "retryOriginal",
      },
    },
    { $set: { retryOriginal: { $first: "$retryOriginal" } } },
  ];
}

/** A retry keeps no photo of its own and runs on its original's. */
const USES_ORIGINAL_PHOTO = {
  $and: [
    { $eq: [{ $ifNull: ["$userPhoto", null] }, null] },
    { $ne: [{ $type: "$retryOriginal" }, "missing"] },
  ],
};

/**
 * Retries reuse their original's stored photo instead of keeping a copy, so
 * list reads that return images fill it in from the original.
 */
const RETRY_PHOTO_STAGES = [
  ...retryOriginalStages({ userPhoto: 1 }),
  { $set: { userPhoto: { $ifNull: ["$userPhoto", "$retryOriginal.userPhoto"] } } },
  { $unset: ["retryOriginalId", "retryOriginal"] },
];

/**
 * The image-free counterpart of RETRY_PHOTO_STAGES, run after
 * IMAGE_STATS_STAGE: a retry reports its original's photo stats, measured
 * inside the lookup so the photo itself is never copied.
 */
const RETRY_PHOTO_STATS_STAGES = [
  ...retryOriginalStages({
    stats: imageStatsOfField("$userPhoto"),
    replayable: photoReplayable("$userPhoto"),
  }),
  {
    $set: {
      "imageStats.userPhoto": { $cond: [USES_ORIGINAL_PHOTO, "$retryOriginal.stats", "$imageStats.userPhoto"] },
      userPhotoReplayable: { $cond: [USES_ORIGINAL_PHOTO, "$retryOriginal.replayable", "$userPhotoReplayable"] },
    },
  },
  { $unset: ["retryOriginalId", "retryOriginal"] },
];
const WITHOUT_IMAGES_STAGE = {
  $project: Object.fromEntries(LAST_METERS_TEST_IMAGE_FIELDS.map((field) => [field, 0] as const)),
};

function toSummary(row: lastMetersTestLogInterface): LastMetersTestSummary {
  const { userPhoto, panoramaPhoto, destinationPhoto, ...rest } = row;
  return {
    ...rest,
    imageStats: imageStatsOf({ userPhoto, panoramaPhoto, destinationPhoto }),
    userPhotoReplayable: hasReplayablePhoto(userPhoto),
  };
}

function withoutImages(row: lastMetersTestLogInterface): lastMetersTestLogInterface {
  const { userPhoto, panoramaPhoto, destinationPhoto, ...rest } = row;
  return rest;
}

/** The in-memory counterpart of RETRY_PHOTO_STAGES; returns a copy, never the stored row. */
function withRetryPhoto(row: lastMetersTestLogInterface): lastMetersTestLogInterface {
  if (!row.retryOf) return row;
  const original = memoryLastMetersTests.find((entry) => rowId(entry) === row.retryOf);
  return withOriginalPhoto(row, original ?? null);
}

export async function compressUserPhoto(dataUrl: string): Promise<string> {
  try {
    const base64Data = dataUrl.replace(/^data:image\/\w+;base64,/, "");
    const outputBuffer = await sharp(Buffer.from(base64Data, "base64"))
      .rotate()
      .resize({ width: STORED_PHOTO_MAX_WIDTH, withoutEnlargement: true })
      .jpeg({ quality: STORED_PHOTO_JPEG_QUALITY })
      .toBuffer();
    return `data:image/jpeg;base64,${outputBuffer.toString("base64")}`;
  } catch (error) {
    console.error("[LastMetersTestLog] failed to compress user photo for storage:", error);
    return dataUrl;
  }
}

/** Panorama grids are large — shrink before Mongo so the dashboard can load them. */
export async function compressPanoramaPhoto(dataUrl: string): Promise<string> {
  try {
    const base64Data = dataUrl.replace(/^data:image\/\w+;base64,/, "");
    const outputBuffer = await sharp(Buffer.from(base64Data, "base64"))
      .resize({ width: 1280, withoutEnlargement: true })
      .jpeg({ quality: 68 })
      .toBuffer();
    return `data:image/jpeg;base64,${outputBuffer.toString("base64")}`;
  } catch (error) {
    console.error("[LastMetersTestLog] failed to compress panorama for storage:", error);
    return dataUrl;
  }
}

/** The in-memory equivalent of a serverTs range filter. */
function inDateRange(
  row: lastMetersTestLogInterface,
  dateFilter?: Record<string, unknown>
): boolean {
  if (!dateFilter?.serverTs) return true;
  const range = dateFilter.serverTs as { $gte?: Date; $lte?: Date };
  const ts = new Date(row.serverTs).getTime();
  if (range.$gte && ts < range.$gte.getTime()) return false;
  if (range.$lte && ts > range.$lte.getTime()) return false;
  return true;
}

export class LastMetersTestLogService {
  /** Logs a run of this server's pipeline, stamped with its version and deployed commit. */
  async record(input: UnstampedLastMetersTestLog): Promise<string | undefined> {
    return this.save({
      ...input,
      pipelineVersion: LAST_METERS_PIPELINE_VERSION,
      deployedCommit: deployedCommit(),
    });
  }

  /**
   * Logs a run another server handled through the upstream proxy. This
   * server's version and commit say nothing about that run, so it gets the
   * upstream label and no commit.
   */
  async recordProxied(input: UnstampedLastMetersTestLog): Promise<string | undefined> {
    return this.save({ ...input, pipelineVersion: UPSTREAM_PIPELINE_VERSION });
  }

  private async save(
    input: Omit<lastMetersTestLogInterface, "serverTs">
  ): Promise<string | undefined> {
    const doc: lastMetersTestLogInterface = {
      ...input,
      userPhoto: input.userPhoto?.startsWith("data:")
        ? await compressUserPhoto(input.userPhoto)
        : input.userPhoto,
      panoramaPhoto: input.panoramaPhoto?.startsWith("data:")
        ? await compressPanoramaPhoto(input.panoramaPhoto)
        : input.panoramaPhoto,
      destinationPhoto: input.destinationPhoto?.startsWith("data:")
        ? await compressUserPhoto(input.destinationPhoto)
        : input.destinationPhoto,
      serverTs: new Date(),
    };
    try {
      if (isMongoConnected()) {
        const created = await lastMetersTestLogModel.create(doc);
        return String(created._id);
      }
      const memoryDoc = {
        ...doc,
        _id: `last_meters_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
      } as lastMetersTestLogInterface & { _id: string };
      pushMemoryLastMetersTest(memoryDoc);
      return memoryDoc._id;
    } catch (e) {
      console.error("[LastMetersTestLogService] record failed:", e);
      return undefined;
    }
  }

  /** Newest first. Dashboard retries are left out unless includeRetries is set. */
  async getData(
    limit: number,
    dateFilter?: Record<string, unknown>,
    includeRetries = false
  ): Promise<{ source: string; data: lastMetersTestLogInterface[] }> {
    if (isMongoConnected()) {
      const filter = {
        ...(dateFilter ?? {}),
        ...(includeRetries ? {} : { retryOf: { $exists: false } }),
      };
      const data = await lastMetersTestLogModel
        .aggregate<lastMetersTestLogInterface>([
          { $match: filter },
          { $sort: { serverTs: -1 } },
          { $limit: Math.max(1, Math.floor(limit)) },
          ...(includeRetries ? RETRY_PHOTO_STAGES : []),
        ])
        .allowDiskUse(true);
      return { source: "mongo", data };
    }

    let rows = [...memoryLastMetersTests].reverse();
    if (!includeRetries) rows = rows.filter((row) => !row.retryOf);
    rows = rows.filter((row) => inDateRange(row, dateFilter));
    return { source: "memory", data: rows.slice(0, limit).map(withRetryPhoto) };
  }

  /** How many dashboard retries ran in the date range. */
  async countRetriesInRange(dateFilter?: Record<string, unknown>): Promise<number> {
    if (isMongoConnected()) {
      return lastMetersTestLogModel.countDocuments({
        ...(dateFilter ?? {}),
        retryOf: { $exists: true },
      });
    }
    return memoryLastMetersTests.filter((row) => row.retryOf && inDateRange(row, dateFilter)).length;
  }

  /** Like getData, but without the base64 images. */
  async getSummaries(
    limit: number,
    dateFilter?: Record<string, unknown>,
    includeRetries = false
  ): Promise<{ source: string; data: LastMetersTestSummary[] }> {
    if (isMongoConnected()) {
      const data = await lastMetersTestLogModel
        .aggregate<LastMetersTestSummary>([
          {
            $match: {
              ...(dateFilter ?? {}),
              ...(includeRetries ? {} : { retryOf: { $exists: false } }),
            },
          },
          { $sort: { serverTs: -1 } },
          { $limit: Math.max(1, Math.floor(limit)) },
          IMAGE_STATS_STAGE,
          ...(includeRetries ? RETRY_PHOTO_STATS_STAGES : []),
          WITHOUT_IMAGES_STAGE,
        ])
        .allowDiskUse(true);
      return { source: "mongo", data };
    }

    const { source, data } = await this.getData(limit, dateFilter, includeRetries);
    return { source, data: data.map(toSummary) };
  }

  /**
   * One trial as stored. A retry has no photo of its own; callers that show
   * it fill it from the original they load anyway (withOriginalPhoto), so the
   * photo is read once.
   */
  async getById(
    id: string,
    options?: { includeStreetView?: boolean }
  ): Promise<lastMetersTestLogInterface | null> {
    if (isMongoConnected()) {
      if (!mongoose.isValidObjectId(id)) return null;
      const projection = options?.includeStreetView ? {} : { panoramaPhoto: 0, destinationPhoto: 0 };
      return lastMetersTestLogModel.findById(id, projection).lean<lastMetersTestLogInterface>();
    }
    const row = this.findMemoryRow(id);
    if (!row) return null;
    if (options?.includeStreetView) return { ...row };
    const rest = { ...row };
    delete rest.panoramaPhoto;
    delete rest.destinationPhoto;
    return rest;
  }

  /** One trial's summary: what a response without images needs, never the images. */
  async getSummaryById(id: string): Promise<LastMetersTestSummary | null> {
    const [summary] = await this.getSummariesByIds([id]);
    return summary ?? null;
  }

  /** Summaries of specific trials, such as originals of retries on a list page. */
  async getSummariesByIds(ids: string[]): Promise<LastMetersTestSummary[]> {
    const unique = [...new Set(ids)];
    if (!unique.length) return [];
    if (isMongoConnected()) {
      const valid = unique
        .filter((id) => mongoose.isValidObjectId(id))
        .map((id) => new mongoose.Types.ObjectId(id));
      return lastMetersTestLogModel.aggregate<LastMetersTestSummary>([
        { $match: { _id: { $in: valid } } },
        IMAGE_STATS_STAGE,
        ...RETRY_PHOTO_STATS_STAGES,
        WITHOUT_IMAGES_STAGE,
      ]);
    }
    return memoryLastMetersTests
      .filter((row) => unique.includes(rowId(row)))
      .map((row) => toSummary(withRetryPhoto(row)));
  }

  /** Every retry of an original test, oldest first, without images. */
  async getRetries(originalId: string): Promise<lastMetersTestLogInterface[]> {
    if (isMongoConnected()) {
      return lastMetersTestLogModel
        .find({ retryOf: originalId })
        .select(LAST_METERS_TEST_IMAGE_FIELDS.map((field) => `-${field}`).join(" "))
        .sort({ serverTs: 1 })
        .lean();
    }
    return memoryLastMetersTests
      .filter((row) => row.retryOf === originalId)
      .sort((a, b) => new Date(a.serverTs).getTime() - new Date(b.serverTs).getTime())
      .map(withoutImages);
  }

  /** How many retries each original has, for the dashboard row badges. */
  async countRetries(originalIds: string[]): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    if (!originalIds.length) return counts;
    if (isMongoConnected()) {
      const groups = await lastMetersTestLogModel.aggregate<{ _id: string; count: number }>([
        { $match: { retryOf: { $in: originalIds } } },
        { $group: { _id: "$retryOf", count: { $sum: 1 } } },
      ]);
      groups.forEach((group) => counts.set(group._id, group.count));
      return counts;
    }
    const wanted = new Set(originalIds);
    memoryLastMetersTests.forEach((row) => {
      if (row.retryOf && wanted.has(row.retryOf)) {
        counts.set(row.retryOf, (counts.get(row.retryOf) ?? 0) + 1);
      }
    });
    return counts;
  }

  async updateReview(
    id: string,
    review: Pick<
      lastMetersTestLogInterface,
      "reviewerStatus" | "reviewerNotes" | "reviewOutcome" | "turnCorrectness" | "entranceCorrectness"
    >
  ): Promise<{ source: string; data: lastMetersTestLogInterface | null }> {
    const update: Partial<lastMetersTestLogInterface> = {
      reviewerStatus: review.reviewerStatus ?? "untested",
      reviewerNotes: review.reviewerNotes ?? "",
      reviewedAt: new Date(),
    };
    if (review.reviewOutcome) update.reviewOutcome = review.reviewOutcome;
    if (review.turnCorrectness) update.turnCorrectness = review.turnCorrectness;
    if (review.entranceCorrectness) update.entranceCorrectness = review.entranceCorrectness;

    if (isMongoConnected()) {
      const data = await lastMetersTestLogModel
        .findByIdAndUpdate(id, update, { new: true })
        .lean();
      return { source: "mongo", data };
    }

    const row = this.findMemoryRow(id);
    if (!row) return { source: "memory", data: null };
    Object.assign(row, update);
    return { source: "memory", data: row };
  }

  /** Adds a review-only panorama to a trial that returned before matching. */
  async attachPanorama(
    id: string,
    panorama: Pick<
      lastMetersTestLogInterface,
      "panoramaPhoto" | "panoramaDate" | "panoramaStatus" | "panoId" | "panoramaCopyright" | "panoramaAgeYears" | "panoramaValidation"
    > & { panoramaHeadings?: number[] }
  ): Promise<void> {
    const update: Partial<lastMetersTestLogInterface> = {
      ...panorama,
      panoramaSource: "background",
      panoramaPhoto: panorama.panoramaPhoto?.startsWith("data:")
        ? await compressPanoramaPhoto(panorama.panoramaPhoto)
        : panorama.panoramaPhoto,
    };
    try {
      if (isMongoConnected()) {
        await lastMetersTestLogModel.findByIdAndUpdate(id, update);
        return;
      }
      const row = this.findMemoryRow(id);
      if (row) Object.assign(row, update);
    } catch (e) {
      console.error("[LastMetersTestLogService] attachPanorama failed:", e);
    }
  }

  private findMemoryRow(id: string): lastMetersTestLogInterface | undefined {
    return memoryLastMetersTests.find((entry) => rowId(entry) === id);
  }
}

export const lastMetersTestLogService = new LastMetersTestLogService();
