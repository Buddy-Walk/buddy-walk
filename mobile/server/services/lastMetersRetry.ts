import { canRunLocalLastMeters } from "../config/serverMode";
import type {
  lastMetersTestLogInterface,
  RetryPanoramaMode,
} from "../database/models/lastMetersTestLog";
import { assessReplay, replayRequest } from "../utils/lastMetersReplay";
import { rowId } from "../utils/lastMetersTestRow";
import { lastMetersRetryRunService, withRenewedLease, type RetryRun } from "./lastMetersRetryRuns";
import { lastMetersTestLogService, type LastMetersTestSummary } from "./lastMetersTestLog";
import { LastMetersService } from "./lastMetersService";
import { fetchStreetViewPanoramaById, type StreetViewMetadata } from "./streetViewPanorama";

/**
 * A retry that could not run; status is the HTTP status to answer with, and
 * code names the refusals the dashboard handles specially.
 */
export class LastMetersRetryError extends Error {
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
      throw new LastMetersRetryError(
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
  runLastMeters: LastMetersService["runLastMeters"];
  fetchPanoramaById: typeof fetchStreetViewPanoramaById;
  limiter: RetryLimiter;
  runs: Pick<typeof lastMetersRetryRunService, "find" | "claim" | "renew" | "finish">;
  /** How long a retry may run before it is given up; see RETRY_MAX_RUN_MS. */
  maxRunMs: number;
}

/**
 * A retry normally takes under a minute. One still running after this long
 * is given up so its test can be retried again, though its calls can't be
 * cancelled and run on until they settle.
 */
export const RETRY_MAX_RUN_MS = 10 * 60_000;

const pipeline = new LastMetersService();
const realDependencies: RetryDependencies = {
  runLastMeters: (request, image, options) => pipeline.runLastMeters(request, image, options),
  fetchPanoramaById: fetchStreetViewPanoramaById,
  limiter: new RetryLimiter(),
  runs: lastMetersRetryRunService,
  maxRunMs: RETRY_MAX_RUN_MS,
};

/** Whether this server can run paid retries at all. */
export function retryAvailability(): { available: boolean; reason?: string } {
  if (!process.env.ADMIN_TOKEN?.trim()) {
    return {
      available: false,
      reason: "Set ADMIN_TOKEN on this server before enabling retries, which make paid API calls.",
    };
  }
  if (!canRunLocalLastMeters()) {
    return {
      available: false,
      reason:
        "Set OPENAI_API_KEY and GOOGLE_MAPS_API_KEY (or GOOGLE_API_KEY) on this server to run Last Meters retries.",
    };
  }
  if (!lastMetersRetryRunService.canEnforceOneRunPerOriginal()) {
    return {
      available: false,
      reason:
        "The database index that keeps one retry per test running could not be created, so retries are off. Check the server logs.",
    };
  }
  return { available: true };
}

/**
 * A retry replays its original's inputs, so the original is what gets
 * assessed and what a retry of a retry links to. The id is the stored row's,
 * not the request's: Mongo finds an ObjectId in any letter case, and the
 * one-run-per-original lock and retryOf links need a single spelling.
 */
export async function findOriginal(
  row: lastMetersTestLogInterface,
): Promise<{ originalId: string; original: lastMetersTestLogInterface | null }> {
  if (!row.retryOf) return { originalId: rowId(row), original: row };
  return {
    originalId: row.retryOf,
    original: await lastMetersTestLogService.getById(row.retryOf),
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
  /** The saved log without images, since the retry response leaves them out. */
  log: LastMetersTestSummary | null;
  defaultsApplied: string[];
  /** True when the key had already run and this is its saved result. */
  replayed: boolean;
}

/**
 * Fails with a 504 once maxMs passes without the work settling. The work
 * itself keeps going, since its outside calls can't be cancelled.
 */
function withDeadline<T>(work: Promise<T>, maxMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new LastMetersRetryError(
          504,
          `The retry ran for over ${Math.round(maxMs / 60_000)} minutes and was given up. If it finishes later, it shows up in this test's history.`,
          "retry_timed_out",
        ),
      );
    }, maxMs);
    timer.unref?.();
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

/** Shown for any retry failure that has no message of its own. */
export const UNEXPECTED_RETRY_FAILURE =
  "The retry failed unexpectedly. Check the server logs. The original trial was not changed.";

/**
 * The saved result of a key that was used before. A key is bound to the
 * request it first came with, so a different test or mode is refused.
 */
async function resultOfRun(run: RetryRun, request: RetryRequest): Promise<RetryResult> {
  if (run.requestedId !== request.id || run.panoramaMode !== request.panoramaMode) {
    throw new LastMetersRetryError(
      422,
      "This idempotency key was already used for a different retry. Send a new key.",
      "idempotency_key_reused",
    );
  }
  if (run.status === "running") {
    throw new LastMetersRetryError(
      409,
      "This retry is still running. Send the same request again later for its result.",
      "retry_in_progress",
    );
  }
  if (run.status === "failed" || !run.testLogId) {
    throw new LastMetersRetryError(
      run.errorStatus ?? 500,
      run.errorMessage ?? UNEXPECTED_RETRY_FAILURE,
      run.errorCode,
    );
  }
  return {
    testLogId: run.testLogId,
    log: await lastMetersTestLogService.getSummaryById(run.testLogId),
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
export async function retryLastMetersTest(
  request: RetryRequest,
  dependencies: RetryDependencies = realDependencies,
): Promise<RetryResult> {
  const { id, panoramaMode, idempotencyKey } = request;
  const previous = await dependencies.runs.find(idempotencyKey);
  if (previous) return resultOfRun(previous, request);

  const availability = retryAvailability();
  if (!availability.available) {
    throw new LastMetersRetryError(503, availability.reason ?? "Last Meters is unavailable.");
  }

  const row = await lastMetersTestLogService.getById(id);
  if (!row) throw new LastMetersRetryError(404, "Last Meters test log not found.");
  const { originalId, original } = await findOriginal(row);
  if (!original) {
    throw new LastMetersRetryError(404, "The original test this retry belongs to no longer exists.");
  }

  const assessment = assessReplay(original);
  if (!assessment.input || !original.userPhoto) {
    throw new LastMetersRetryError(409, assessment.reason ?? "This test cannot be replayed.");
  }
  const pinnedPanoId =
    panoramaMode === "original" ? assessment.originalPanorama.panoId : undefined;
  if (panoramaMode === "original" && !pinnedPanoId) {
    throw new LastMetersRetryError(
      409,
      assessment.originalPanorama.reason ?? "The original panorama is unknown.",
    );
  }

  const release = dependencies.limiter.acquire();
  let work: Promise<RetryResult> | undefined;
  try {
    const claim = await dependencies.runs.claim({
      _id: idempotencyKey,
      requestedId: id,
      originalId,
      panoramaMode,
    });
    if (!claim.claimed) {
      if (claim.conflict === "key") return resultOfRun(claim.existing, request);
      throw new LastMetersRetryError(
        409,
        "A retry of this test is already running. Wait for it to finish.",
        "original_retry_running",
      );
    }

    let outcome: RetryResult;
    try {
      // Past the deadline the lease stops being renewed and the run is saved
      // as failed, which frees its original for a new retry.
      outcome = await withRenewedLease(dependencies.runs, idempotencyKey, () => {
        work = runRetry(original, originalId, panoramaMode, pinnedPanoId, assessment, dependencies);
        return withDeadline(work, dependencies.maxRunMs);
      });
    } catch (error) {
      const failure =
        error instanceof LastMetersRetryError
          ? error
          : new LastMetersRetryError(500, UNEXPECTED_RETRY_FAILURE);
      if (!(error instanceof LastMetersRetryError)) {
        console.error("[LastMetersRetry] retry failed:", error);
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
    // A run that was given up still makes paid calls, so it keeps its
    // capacity slot until they settle.
    if (work) work.then(release, release);
    else release();
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
    if (!(await dependencies.runs.finish(key, outcome))) {
      console.warn(`[LastMetersRetry] retry ${key} finished after it was marked interrupted; its outcome was not saved.`);
    }
  } catch (error) {
    console.error(`[LastMetersRetry] could not save the outcome of retry ${key}:`, error);
  }
}

async function runRetry(
  original: lastMetersTestLogInterface,
  originalId: string,
  panoramaMode: RetryPanoramaMode,
  pinnedPanoId: string | undefined,
  assessment: ReturnType<typeof assessReplay>,
  dependencies: RetryDependencies,
): Promise<RetryResult> {
  // Checked here, before any paid call, and then handed to the pipeline so
  // it runs on exactly this metadata instead of looking the panorama up again.
  let pinnedPanorama: StreetViewMetadata | undefined;
  if (pinnedPanoId) {
    try {
      pinnedPanorama = await dependencies.fetchPanoramaById(pinnedPanoId);
    } catch (error: any) {
      const retired =
        typeof error?.code === "string" && error.code.startsWith("STREET_VIEW_PANO_");
      if (retired) {
        throw new LastMetersRetryError(
          409,
          `${error.message} Retry with a fresh panorama instead.`,
          "original_panorama_retired",
        );
      }
      throw new LastMetersRetryError(
        502,
        `Could not check the original panorama with Google Street View: ${error?.message ?? "unknown error"}.`,
      );
    }
  }

  const result = await dependencies.runLastMeters(
    replayRequest(assessment.input!),
    original.userPhoto!,
    {
      pinnedPanorama,
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
    throw new LastMetersRetryError(500, "The retry ran but its result could not be saved.");
  }

  return {
    testLogId: result.testLogId,
    log: await lastMetersTestLogService.getSummaryById(result.testLogId),
    defaultsApplied: assessment.defaultsApplied,
    replayed: false,
  };
}
