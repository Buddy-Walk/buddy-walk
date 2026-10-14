import { canRunLocalLastMile } from "../config/serverMode";
import type {
  lastMileTestLogInterface,
  RetryPanoramaMode,
} from "../database/models/lastMileTestLog";
import { assessReplay, replayRequest } from "../utils/lastMileReplay";
import { lastMileRetryRunService, type RetryRun } from "./lastMileRetryRuns";
import { lastMileTestLogService } from "./lastMileTestLog";
import { fetchStreetViewPanoramaById, OpenAIService } from "./openAI";

/**
 * A retry that could not run; status is the HTTP status to answer with, and
 * code names the refusals the dashboard handles specially.
 */
export class LastMileRetryError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

/**
 * Every retry makes paid OpenAI and Google calls and holds images in memory,
 * so this server runs at most `maxConcurrent` at once. Field tests share the
 * same instance and API quota.
 */
export class RetryLimiter {
  private running = 0;

  constructor(private readonly maxConcurrent = 3) {}

  /** Claims a slot; call the returned function when the retry finishes. */
  acquire(): () => void {
    if (this.running >= this.maxConcurrent) {
      throw new LastMileRetryError(
        429,
        `${this.maxConcurrent} retries are already running. Wait for one to finish.`,
        "retry_capacity",
      );
    }
    this.running += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.running -= 1;
    };
  }
}

/** The paid outside calls a retry makes; tests pass stand-ins for these. */
export interface RetryDependencies {
  runLastMeters: OpenAIService["runLastMeters"];
  fetchPanoramaById: typeof fetchStreetViewPanoramaById;
  limiter: RetryLimiter;
  runs: Pick<typeof lastMileRetryRunService, "find" | "claim" | "finish">;
}

const pipeline = new OpenAIService();
const realDependencies: RetryDependencies = {
  runLastMeters: (request, image, options) => pipeline.runLastMeters(request, image, options),
  fetchPanoramaById: fetchStreetViewPanoramaById,
  limiter: new RetryLimiter(),
  runs: lastMileRetryRunService,
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

export interface RetryRequest {
  /** The test to retry; a retry's id replays its original. */
  id: string;
  panoramaMode: RetryPanoramaMode;
  /** The client's UUIDv7 for this retry; re-sending it never runs twice. */
  idempotencyKey: string;
}

export interface RetryResult {
  testLogId: string;
  log: lastMileTestLogInterface | null;
  defaultsApplied: string[];
  /** True when the key had already run and this is its saved result. */
  replayed: boolean;
}

const UNEXPECTED_FAILURE =
  "The retry failed unexpectedly. Check the server logs. The original trial was not changed.";

/**
 * The saved result of a key that was used before. A key is bound to the
 * request it first came with, so a different test or mode is refused.
 */
async function resultOfRun(run: RetryRun, request: RetryRequest): Promise<RetryResult> {
  if (run.requestedId !== request.id || run.panoramaMode !== request.panoramaMode) {
    throw new LastMileRetryError(
      422,
      "This idempotency key was already used for a different retry. Send a new key.",
      "idempotency_key_reused",
    );
  }
  if (run.status === "running") {
    throw new LastMileRetryError(
      409,
      "This retry is still running. Send the same request again later for its result.",
      "retry_in_progress",
    );
  }
  if (run.status === "failed" || !run.testLogId) {
    throw new LastMileRetryError(
      run.errorStatus ?? 500,
      run.errorMessage ?? UNEXPECTED_FAILURE,
      run.errorCode,
    );
  }
  return {
    testLogId: run.testLogId,
    log: await lastMileTestLogService.getById(run.testLogId),
    defaultsApplied: run.defaultsApplied ?? [],
    replayed: true,
  };
}

/**
 * Re-runs a past trial through the current pipeline and saves the result as
 * a new log linked to the original. Fresh mode searches for a panorama
 * exactly as a field test would; original mode pins the original's panorama.
 *
 * Idempotent per key: a key that already ran answers with its saved result
 * or error, and one retry per original runs at a time. Refusals before the
 * run starts (validation, capacity) are not saved, so the same key can be
 * sent again once the cause is gone.
 */
export async function retryLastMileTest(
  request: RetryRequest,
  dependencies: RetryDependencies = realDependencies,
): Promise<RetryResult> {
  const { id, panoramaMode, idempotencyKey } = request;
  const previous = await dependencies.runs.find(idempotencyKey);
  if (previous) return resultOfRun(previous, request);

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
    const claim = await dependencies.runs.claim({
      _id: idempotencyKey,
      requestedId: id,
      originalId,
      panoramaMode,
    });
    if (!claim.claimed) {
      if (claim.conflict === "key") return resultOfRun(claim.existing, request);
      throw new LastMileRetryError(
        409,
        "A retry of this test is already running. Wait for it to finish.",
        "original_retry_running",
      );
    }

    let outcome: RetryResult;
    try {
      outcome = await runRetry(original, originalId, panoramaMode, pinnedPanoId, assessment, dependencies);
    } catch (error) {
      const failure =
        error instanceof LastMileRetryError
          ? error
          : new LastMileRetryError(500, UNEXPECTED_FAILURE);
      if (!(error instanceof LastMileRetryError)) {
        console.error("[LastMileRetry] retry failed:", error);
      }
      await saveOutcome(dependencies, idempotencyKey, {
        status: "failed",
        errorStatus: failure.status,
        errorCode: failure.code,
        errorMessage: failure.message,
      });
      throw failure;
    }
    await saveOutcome(dependencies, idempotencyKey, {
      status: "succeeded",
      testLogId: outcome.testLogId,
      defaultsApplied: outcome.defaultsApplied,
    });
    return outcome;
  } finally {
    release();
  }
}

/**
 * A run that cannot be marked finished stays "running" until its lease runs
 * out and is then reported as interrupted, so this logs instead of throwing
 * over a result the caller already has.
 */
async function saveOutcome(
  dependencies: RetryDependencies,
  key: string,
  outcome: Parameters<RetryDependencies["runs"]["finish"]>[1],
): Promise<void> {
  try {
    await dependencies.runs.finish(key, outcome);
  } catch (error) {
    console.error(`[LastMileRetry] could not save the outcome of retry ${key}:`, error);
  }
}

async function runRetry(
  original: lastMileTestLogInterface,
  originalId: string,
  panoramaMode: RetryPanoramaMode,
  pinnedPanoId: string | undefined,
  assessment: ReturnType<typeof assessReplay>,
  dependencies: RetryDependencies,
): Promise<RetryResult> {
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
    replayRequest(assessment.input!),
    original.userPhoto!,
    {
      pinnedPanoId,
      retry: {
        retryOf: originalId,
        panoramaMode,
        defaultsApplied: assessment.defaultsApplied,
        replayInput: assessment.input!,
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
    defaultsApplied: assessment.defaultsApplied,
    replayed: false,
  };
}
