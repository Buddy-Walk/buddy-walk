import lastMileRetryRunModel, {
  type lastMileRetryRunInterface,
} from "../database/models/lastMileRetryRun";
import { isMongoConnected, memoryRetryRuns } from "../database/usageStore";

/**
 * How long a run stays "running" without a heartbeat. The server running it
 * renews the lease every RETRY_HEARTBEAT_MS, however long the run takes, so a
 * run whose lease ran out was cut off by a restart or crash.
 */
export const RETRY_LEASE_MS = 2 * 60_000;
export const RETRY_HEARTBEAT_MS = 30_000;

export const INTERRUPTED_MESSAGE =
  "The server stopped before this retry finished, so no result was saved. Start a new retry.";

export type RetryRun = lastMileRetryRunInterface;
export type NewRetryRun = Pick<RetryRun, "_id" | "requestedId" | "originalId" | "panoramaMode">;
export type RetryRunOutcome =
  | { status: "succeeded"; testLogId: string; defaultsApplied: string[] }
  | { status: "failed"; errorStatus: number; errorCode?: string; errorMessage: string };

/** Why a run could not be claimed, with the run that holds the slot. */
export type ClaimResult =
  | { claimed: true; run: RetryRun }
  | { claimed: false; conflict: "key" | "original"; existing: RetryRun };

const DUPLICATE_KEY = 11000;

function isLive(run: RetryRun, now: number): boolean {
  return run.status === "running" && new Date(run.leaseExpiresAt).getTime() > now;
}

function interruptedUpdate(now: number): Partial<RetryRun> {
  return {
    status: "failed",
    finishedAt: new Date(now),
    errorStatus: 500,
    errorCode: "retry_interrupted",
    errorMessage: INTERRUPTED_MESSAGE,
  };
}

/**
 * Dashboard retry runs. The idempotency key is the run's _id, and a unique
 * partial index on originalId (status "running") lets one retry per original
 * run at a time, across server instances.
 */
export class LastMileRetryRunService {
  private oneRunPerOriginalIndexReady = false;

  /**
   * Creates the unique partial index behind "one running retry per
   * original". Until it exists, retries stay off while Mongo is in use.
   */
  async ensureIndexes(): Promise<void> {
    await lastMileRetryRunModel.collection.createIndex(
      { originalId: 1 },
      { name: "one_running_retry_per_original", unique: true, partialFilterExpression: { status: "running" } }
    );
    this.oneRunPerOriginalIndexReady = true;
  }

  /** Whether claim() can keep one retry per original running at a time. */
  canEnforceOneRunPerOriginal(): boolean {
    return !isMongoConnected() || this.oneRunPerOriginalIndexReady;
  }

  /** The run for this key; a run whose lease ran out is marked interrupted. */
  async find(key: string, now = Date.now()): Promise<RetryRun | null> {
    if (isMongoConnected()) {
      const run = await lastMileRetryRunModel.findById(key).lean();
      if (!run || run.status !== "running" || isLive(run, now)) return run ?? null;
      return (
        (await lastMileRetryRunModel
          .findOneAndUpdate({ _id: key, status: "running" }, interruptedUpdate(now), { new: true })
          .lean()) ?? (await lastMileRetryRunModel.findById(key).lean())
      );
    }
    const run = memoryRetryRuns.get(key);
    if (!run) return null;
    if (run.status === "running" && !isLive(run, now)) Object.assign(run, interruptedUpdate(now));
    return { ...run };
  }

  /**
   * Records a new running run, unless the key was used already or another
   * retry of the same original is still running.
   */
  async claim(input: NewRetryRun, now = Date.now()): Promise<ClaimResult> {
    const run: RetryRun = {
      ...input,
      status: "running",
      startedAt: new Date(now),
      leaseExpiresAt: new Date(now + RETRY_LEASE_MS),
    };
    if (!isMongoConnected()) return this.claimInMemory(run, now);

    await lastMileRetryRunModel.updateMany(
      { originalId: run.originalId, status: "running", leaseExpiresAt: { $lte: new Date(now) } },
      interruptedUpdate(now)
    );
    try {
      await lastMileRetryRunModel.create(run);
      return { claimed: true, run };
    } catch (error: any) {
      if (error?.code !== DUPLICATE_KEY) throw error;
      const sameKey = await this.find(run._id, now);
      if (sameKey) return { claimed: false, conflict: "key", existing: sameKey };
      const running = await lastMileRetryRunModel
        .findOne({ originalId: run.originalId, status: "running" })
        .lean();
      // The other run finished between the insert and this read; the caller
      // can send the request again.
      if (!running) throw error;
      return { claimed: false, conflict: "original", existing: running };
    }
  }

  /**
   * Extends a running run's lease. Returns false once the run is no longer
   * running, such as after it was marked interrupted.
   */
  async renew(key: string, now = Date.now()): Promise<boolean> {
    const leaseExpiresAt = new Date(now + RETRY_LEASE_MS);
    if (isMongoConnected()) {
      const result = await lastMileRetryRunModel.updateOne({ _id: key, status: "running" }, { leaseExpiresAt });
      return result.matchedCount > 0;
    }
    const run = memoryRetryRuns.get(key);
    if (run?.status !== "running") return false;
    run.leaseExpiresAt = leaseExpiresAt;
    return true;
  }

  /**
   * Records how a run ended. A run already marked interrupted keeps that
   * status, since the client was told so and the original may have been
   * retried since; returns false in that case.
   */
  async finish(key: string, outcome: RetryRunOutcome, now = Date.now()): Promise<boolean> {
    const update = { ...outcome, finishedAt: new Date(now) };
    if (isMongoConnected()) {
      const result = await lastMileRetryRunModel.updateOne({ _id: key, status: "running" }, update);
      return result.matchedCount > 0;
    }
    const run = memoryRetryRuns.get(key);
    if (run?.status !== "running") return false;
    Object.assign(run, update);
    return true;
  }

  /** The live run of each original that has one. */
  async running(originalIds: string[], now = Date.now()): Promise<Map<string, RetryRun>> {
    const byOriginal = new Map<string, RetryRun>();
    if (!originalIds.length) return byOriginal;
    const runs = isMongoConnected()
      ? await lastMileRetryRunModel
          .find({
            originalId: { $in: [...new Set(originalIds)] },
            status: "running",
            leaseExpiresAt: { $gt: new Date(now) },
          })
          .lean()
      : [...memoryRetryRuns.values()].filter(
          (run) => originalIds.includes(run.originalId) && isLive(run, now)
        );
    runs.forEach((run) => byOriginal.set(run.originalId, run));
    return byOriginal;
  }

  private claimInMemory(run: RetryRun, now: number): ClaimResult {
    const sameKey = memoryRetryRuns.get(run._id);
    if (sameKey) {
      if (sameKey.status === "running" && !isLive(sameKey, now)) {
        Object.assign(sameKey, interruptedUpdate(now));
      }
      return { claimed: false, conflict: "key", existing: { ...sameKey } };
    }
    for (const other of memoryRetryRuns.values()) {
      if (other.originalId !== run.originalId || other.status !== "running") continue;
      if (isLive(other, now)) return { claimed: false, conflict: "original", existing: { ...other } };
      Object.assign(other, interruptedUpdate(now));
    }
    memoryRetryRuns.set(run._id, run);
    return { claimed: true, run: { ...run } };
  }
}

/**
 * Does the run's work while renewing its lease, so a slow run is never taken
 * for an interrupted one.
 */
export async function withRenewedLease<T>(
  runs: Pick<LastMileRetryRunService, "renew">,
  key: string,
  work: () => Promise<T>,
  intervalMs = RETRY_HEARTBEAT_MS,
): Promise<T> {
  const timer = setInterval(() => {
    runs.renew(key).then(
      (running) => {
        if (running) return;
        clearInterval(timer);
        console.warn(`[LastMileRetry] retry ${key} was marked interrupted while it was still running.`);
      },
      (error) => console.error(`[LastMileRetry] could not renew the lease of retry ${key}:`, error),
    );
  }, intervalMs);
  timer.unref?.();
  try {
    return await work();
  } finally {
    clearInterval(timer);
  }
}

export const lastMileRetryRunService = new LastMileRetryRunService();
