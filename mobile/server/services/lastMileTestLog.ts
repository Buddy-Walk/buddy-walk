import sharp from "sharp";
import lastMileTestLogModel, {
  lastMileTestLogInterface,
} from "../database/models/lastMileTestLog";
import {
  isMongoConnected,
  memoryLastMileTests,
  pushMemoryLastMileTest,
} from "../database/usageStore";
import {
  imageStatsOf,
  LAST_MILE_TEST_IMAGE_FIELDS,
  type LastMileTestImageField,
  type LastMileTestImageStats,
} from "../utils/lastMileTestRow";

export type LastMileTestSummary = Omit<lastMileTestLogInterface, LastMileTestImageField> &
  LastMileTestImageStats;

/**
 * Image lengths and data-URL checks computed inside MongoDB. Each trial carries
 * about 1 MB of base64 images, and pulling them for a whole list exhausts the
 * Render free instance's memory and CPU.
 */
const IMAGE_STATS_STAGE = {
  $addFields: {
    imageStats: Object.fromEntries(
      LAST_MILE_TEST_IMAGE_FIELDS.map((field) => {
        const value = { $ifNull: [`$${field}`, ""] };
        return [
          field,
          {
            length: { $strLenCP: value },
            stored: { $eq: [{ $substrCP: [value, 0, 5] }, "data:"] },
          },
        ] as const;
      })
    ),
  },
};

export async function compressUserPhoto(dataUrl: string): Promise<string> {
  try {
    const base64Data = dataUrl.replace(/^data:image\/\w+;base64,/, "");
    const outputBuffer = await sharp(Buffer.from(base64Data, "base64"))
      .rotate()
      .resize({ width: 1024, withoutEnlargement: true })
      .jpeg({ quality: 76 })
      .toBuffer();
    return `data:image/jpeg;base64,${outputBuffer.toString("base64")}`;
  } catch (error) {
    console.error("[LastMileTestLog] failed to compress user photo for storage:", error);
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
    console.error("[LastMileTestLog] failed to compress panorama for storage:", error);
    return dataUrl;
  }
}

export class LastMileTestLogService {
  async record(input: Omit<lastMileTestLogInterface, "serverTs">): Promise<string | undefined> {
    const doc: lastMileTestLogInterface = {
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
        const created = await lastMileTestLogModel.create(doc);
        return String(created._id);
      }
      const memoryDoc = {
        ...doc,
        _id: `last_mile_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
      } as lastMileTestLogInterface & { _id: string };
      pushMemoryLastMileTest(memoryDoc);
      return memoryDoc._id;
    } catch (e) {
      console.error("[LastMileTestLogService] record failed:", e);
      return undefined;
    }
  }

  async getData(
    limit: number,
    dateFilter?: Record<string, unknown>
  ): Promise<{ source: string; data: lastMileTestLogInterface[] }> {
    if (isMongoConnected()) {
      const data = await lastMileTestLogModel
        .find(dateFilter ?? {})
        .sort({ serverTs: -1 })
        .limit(limit)
        .allowDiskUse(true)
        .lean();
      return { source: "mongo", data };
    }

    let rows = [...memoryLastMileTests].reverse();
    if (dateFilter?.serverTs) {
      const range = dateFilter.serverTs as { $gte?: Date; $lte?: Date };
      rows = rows.filter((row) => {
        const ts = new Date(row.serverTs).getTime();
        if (range.$gte && ts < range.$gte.getTime()) return false;
        if (range.$lte && ts > range.$lte.getTime()) return false;
        return true;
      });
    }
    return { source: "memory", data: rows.slice(0, limit) };
  }

  /** Like getData, but without the base64 images. */
  async getSummaries(
    limit: number,
    dateFilter?: Record<string, unknown>
  ): Promise<{ source: string; data: LastMileTestSummary[] }> {
    if (isMongoConnected()) {
      const data = await lastMileTestLogModel
        .aggregate<LastMileTestSummary>([
          { $match: dateFilter ?? {} },
          { $sort: { serverTs: -1 } },
          { $limit: Math.max(1, Math.floor(limit)) },
          IMAGE_STATS_STAGE,
          { $project: Object.fromEntries(LAST_MILE_TEST_IMAGE_FIELDS.map((field) => [field, 0] as const)) },
        ])
        .allowDiskUse(true);
      return { source: "mongo", data };
    }

    const { source, data } = await this.getData(limit, dateFilter);
    return {
      source,
      data: data.map((row) => {
        const { userPhoto, panoramaPhoto, destinationPhoto, ...rest } = row;
        return { ...rest, imageStats: imageStatsOf({ userPhoto, panoramaPhoto, destinationPhoto }) };
      }),
    };
  }

  async getById(
    id: string,
    options?: { includeStreetView?: boolean }
  ): Promise<lastMileTestLogInterface | null> {
    if (isMongoConnected()) {
      let query = lastMileTestLogModel.findById(id);
      if (!options?.includeStreetView) {
        query = query.select("-panoramaPhoto -destinationPhoto");
      }
      const data = await query.lean();
      return data ?? null;
    }
    const row = memoryLastMileTests.find((entry) => {
      const maybeId = (entry as lastMileTestLogInterface & { _id?: unknown })._id;
      return String(maybeId ?? "") === id;
    });
    if (!row) return null;
    if (options?.includeStreetView) return row;
    const rest = { ...row };
    delete rest.panoramaPhoto;
    delete rest.destinationPhoto;
    return rest;
  }

  async updateReview(
    id: string,
    review: Pick<
      lastMileTestLogInterface,
      "reviewerStatus" | "reviewerNotes" | "reviewOutcome" | "turnCorrectness" | "entranceCorrectness"
    >
  ): Promise<{ source: string; data: lastMileTestLogInterface | null }> {
    const update: Partial<lastMileTestLogInterface> = {
      reviewerStatus: review.reviewerStatus ?? "untested",
      reviewerNotes: review.reviewerNotes ?? "",
      reviewedAt: new Date(),
    };
    if (review.reviewOutcome) update.reviewOutcome = review.reviewOutcome;
    if (review.turnCorrectness) update.turnCorrectness = review.turnCorrectness;
    if (review.entranceCorrectness) update.entranceCorrectness = review.entranceCorrectness;

    if (isMongoConnected()) {
      const data = await lastMileTestLogModel
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
      lastMileTestLogInterface,
      "panoramaPhoto" | "panoramaDate" | "panoramaStatus" | "panoId" | "panoramaCopyright" | "panoramaAgeYears"
    > & { panoramaHeadings?: number[] }
  ): Promise<void> {
    const update: Partial<lastMileTestLogInterface> = {
      ...panorama,
      panoramaSource: "background",
      panoramaPhoto: panorama.panoramaPhoto?.startsWith("data:")
        ? await compressPanoramaPhoto(panorama.panoramaPhoto)
        : panorama.panoramaPhoto,
    };
    try {
      if (isMongoConnected()) {
        await lastMileTestLogModel.findByIdAndUpdate(id, update);
        return;
      }
      const row = this.findMemoryRow(id);
      if (row) Object.assign(row, update);
    } catch (e) {
      console.error("[LastMileTestLogService] attachPanorama failed:", e);
    }
  }

  private findMemoryRow(id: string): lastMileTestLogInterface | undefined {
    return memoryLastMileTests.find((entry) => {
      const maybeId = (entry as lastMileTestLogInterface & { _id?: unknown })._id;
      return String(maybeId ?? "") === id;
    });
  }
}

export const lastMileTestLogService = new LastMileTestLogService();
