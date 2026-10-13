import { canRunLocalLastMile } from "../config/serverMode";
import type {
  lastMileTestLogInterface,
  RetryPanoramaMode,
} from "../database/models/lastMileTestLog";
import { assessReplay, replayRequest, type ReplayAssessment } from "../utils/lastMileReplay";
import { lastMileTestLogService } from "./lastMileTestLog";
import { fetchStreetViewPanoramaById, OpenAIService } from "./openAI";

/** A retry that could not run; status is the HTTP status to answer with. */
export class LastMileRetryError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Every retry makes paid OpenAI and Google calls, so only one runs at a time
 * and at most `perMinute` start in any minute.
 */
export class RetryLimiter {
  private active = false;
  private started: number[] = [];

  constructor(
    private readonly perMinute = 3,
    private readonly now: () => number = Date.now,
  ) {}

  /** Claims a slot; call the returned function when the retry finishes. */
  acquire(): () => void {
    const now = this.now();
    this.started = this.started.filter((time) => now - time < 60_000);
    if (this.active) {
      throw new LastMileRetryError(429, "Another retry is still running. Wait for it to finish.");
    }
    if (this.started.length >= this.perMinute) {
      throw new LastMileRetryError(
        429,
        `At most ${this.perMinute} retries can start per minute. Wait before retrying.`,
      );
    }
    this.active = true;
    this.started.push(now);
    return () => {
      this.active = false;
    };
  }
}

/** The paid outside calls a retry makes; tests pass stand-ins for these. */
export interface RetryDependencies {
  runLastMeters: OpenAIService["runLastMeters"];
  fetchPanoramaById: typeof fetchStreetViewPanoramaById;
  limiter: RetryLimiter;
}

const pipeline = new OpenAIService();
const realDependencies: RetryDependencies = {
  runLastMeters: (request, image, options) => pipeline.runLastMeters(request, image, options),
  fetchPanoramaById: fetchStreetViewPanoramaById,
  limiter: new RetryLimiter(),
};

/** Whether this server can run paid retries at all. */
export function retryAvailability(): { available: boolean; reason?: string } {
  if (!process.env.ADMIN_TOKEN?.trim()) {
    return {
      available: false,
      reason: "Set ADMIN_TOKEN on this server before enabling retries, which make paid API calls.",
    };
  }
  return canRunLocalLastMile()
    ? { available: true }
    : {
        available: false,
        reason:
          "This server is missing OPENAI_API_KEY or GOOGLE_API_KEY, so it cannot run Last Meters.",
      };
}

/**
 * A retry replays its original's inputs, so the original is what gets
 * assessed and what a retry of a retry links to.
 */
export async function findOriginal(
  id: string,
  row: lastMileTestLogInterface,
): Promise<{ originalId: string; original: lastMileTestLogInterface | null }> {
  if (!row.retryOf) return { originalId: id, original: row };
  return {
    originalId: row.retryOf,
    original: await lastMileTestLogService.getById(row.retryOf),
  };
}

/**
 * Re-runs a past trial through the current pipeline and saves the result as
 * a new log linked to the original. Fresh mode searches for a panorama
 * exactly as a field test would; original mode pins the original's panorama.
 */
export async function retryLastMileTest(
  id: string,
  panoramaMode: RetryPanoramaMode,
  dependencies: RetryDependencies = realDependencies,
): Promise<{
  testLogId: string;
  log: lastMileTestLogInterface | null;
  assessment: ReplayAssessment;
}> {
  const availability = retryAvailability();
  if (!availability.available) {
    throw new LastMileRetryError(503, availability.reason ?? "Last Meters is unavailable.");
  }

  const row = await lastMileTestLogService.getById(id);
  if (!row) throw new LastMileRetryError(404, "Last Meters test log not found.");
  const { originalId, original } = await findOriginal(id, row);
  if (!original) {
    throw new LastMileRetryError(404, "The original test this retry belongs to no longer exists.");
  }

  const assessment = assessReplay(original);
  if (!assessment.input || !original.userPhoto) {
    throw new LastMileRetryError(409, assessment.reason ?? "This test cannot be replayed.");
  }
  const pinnedPanoId =
    panoramaMode === "original" ? assessment.originalPanorama.panoId : undefined;
  if (panoramaMode === "original" && !pinnedPanoId) {
    throw new LastMileRetryError(
      409,
      assessment.originalPanorama.reason ?? "The original panorama is unknown.",
    );
  }

  const release = dependencies.limiter.acquire();
  try {
    if (pinnedPanoId) {
      try {
        await dependencies.fetchPanoramaById(pinnedPanoId);
      } catch (error: any) {
        const retired =
          typeof error?.code === "string" && error.code.startsWith("STREET_VIEW_PANO_");
        throw new LastMileRetryError(
          retired ? 409 : 502,
          retired
            ? `${error.message} Retry with a fresh panorama instead.`
            : `Could not reach Google Street View to check the original panorama: ${error?.message ?? "unknown error"}.`,
        );
      }
    }

    const result = await dependencies.runLastMeters(
      replayRequest(assessment.input),
      original.userPhoto,
      {
        pinnedPanoId,
        retry: {
          retryOf: originalId,
          panoramaMode,
          defaultsApplied: assessment.defaultsApplied,
          replayInput: assessment.input,
        },
      },
    );
    // Approach and aligned trials attach their panorama after answering; wait
    // for it so the history shows which panorama this retry got.
    if (result.kind === "response") await result.reviewPanorama;
    if (!result.testLogId) {
      throw new LastMileRetryError(500, "The retry ran but its result could not be saved.");
    }

    return {
      testLogId: result.testLogId,
      log: await lastMileTestLogService.getById(result.testLogId),
      assessment,
    };
  } finally {
    release();
  }
}
