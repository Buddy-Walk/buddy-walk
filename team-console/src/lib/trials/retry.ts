import { v7 as uuidv7 } from "uuid";
import { z } from "zod";

import {
  PANORAMA_MODES,
  retryErrorSchema,
  retryResponseSchema,
  type PanoramaMode,
  type RetryAvailability,
  type RetryResult,
  type RunningRetry,
  type Trial,
} from "./schema";

const POLL_MS = 15000;
const RESEND_DELAY_MS = 5000;
// How long to keep sending while the server can't be reached. A little past the
// server's 2-minute lease, so a restarted server reports the run as interrupted.
const UNREACHABLE_FOR_MS = 3 * 60 * 1000;

/** The id of the retry history section, so a link can open a Trial scrolled to it. */
export const RETRY_HISTORY_HASH = "retry-history";

/** Until the server says otherwise, as when the list hasn't loaded. */
export const RETRIES_ON: RetryAvailability = { available: true };

/** A retry of a retry replays the same original, so runs are grouped by it. */
export const originalIdOf = (trial: Pick<Trial, "_id" | "retryOf">) => trial.retryOf || trial._id;

/** Why this Trial can't be retried, or "" when it can. */
export function retryBlockedReason(
  trial: Pick<Trial, "replay">,
  availability: RetryAvailability,
): string {
  if (!availability.available) return availability.reason || "Retries are off on this server.";
  if (trial.replay.status !== "not_replayable") return "";
  return trial.replay.reason || "This Trial cannot be replayed.";
}

/** How often to reload while a retry runs, whether the server or this tab reports it. */
export function retryPollInterval(
  reported: (RunningRetry | undefined)[],
  runningHere: boolean,
): number | false {
  return runningHere || reported.some(Boolean) ? POLL_MS : false;
}

export function elapsedText(startedAt: number, now: number) {
  return `${Math.max(0, Math.round((now - startedAt) / 1000))}s`;
}

/** A new key for one retry. Every resend of that retry, even after a reload, reuses it. */
export const newIdempotencyKey = () => uuidv7();

/** What mobile/server said about one send of a retry. */
export type RetryAnswer =
  | { ok: true; trialId: string; result?: RetryResult }
  | { ok: false; message: string; code?: string; resend: boolean };

export type FinishedRetry = Extract<RetryAnswer, { ok: true }>;

/**
 * Reads mobile/server's response to one send. A gateway error without its JSON
 * body came from a proxy, not the retry, so it says nothing about the run.
 */
export function retryAnswerFrom(status: number, body: unknown): RetryAnswer {
  if (status >= 200 && status < 300) {
    const finished = retryResponseSchema.safeParse(body);
    if (!finished.success) {
      return {
        ok: false,
        message: "mobile/server's answer has an unexpected shape. Check the retry history.",
        resend: false,
      };
    }
    return { ok: true, trialId: finished.data.testLogId, result: finished.data.data ?? {} };
  }
  const { error, code } = retryErrorSchema.parse(body);
  return {
    ok: false,
    message: error || `HTTP ${status}`,
    ...(code ? { code } : {}),
    resend: !error && status >= 502 && status <= 504,
  };
}

/** A retry that did not run, with mobile/server's reason. */
export class RetryRefused extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

/** What is sent for a retry, the same on every send. */
export interface RetryRequest {
  trialId: string;
  panoramaMode: PanoramaMode;
  idempotencyKey: string;
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Sends a retry until it has a final answer. Every send repeats its idempotency
 * key, so asking again returns the first run's result instead of starting
 * another. A run the server reports in progress is still renewing its lease, so
 * it is waited for however long it takes; an unreachable server is given up on.
 */
export async function sendUntilAnswered(
  run: RetryRun,
  post: (request: RetryRequest) => Promise<RetryAnswer>,
  {
    wait = delay,
    now = Date.now,
  }: { wait?: (ms: number) => Promise<unknown>; now?: () => number } = {},
): Promise<FinishedRetry> {
  const request: RetryRequest = {
    trialId: run.trialId,
    panoramaMode: run.panoramaMode,
    idempotencyKey: run.key,
  };
  let lastHeardAt = now();
  for (;;) {
    let unreachable: unknown;
    try {
      const answer = await post(request);
      if (answer.ok) return answer;
      if (answer.code === "retry_in_progress") lastHeardAt = now();
      else if (!answer.resend) throw new RetryRefused(answer.message, answer.code);
      unreachable = new RetryRefused(answer.message, answer.code);
    } catch (error) {
      if (error instanceof RetryRefused) throw error;
      unreachable = error;
    }
    if (now() - lastHeardAt > UNREACHABLE_FOR_MS) throw unreachable;
    await wait(RESEND_DELAY_MS);
  }
}

const retryRunSchema = z.object({
  key: z.string().min(1),
  trialId: z.string(),
  originalId: z.string(),
  name: z.string(),
  panoramaMode: z.enum(PANORAMA_MODES),
  startedAt: z.number(),
});
/** One retry being sent, identified by its key across resends and reloads. */
export type RetryRun = z.output<typeof retryRunSchema>;

// Retries this tab sent that have no final answer yet, by original. Kept per tab,
// so a reload sends them again and shows their result, while a closed tab can't
// send a key the server never received on some later visit, starting a paid run.
const PENDING_KEY = "trials.pendingRetries";

function readPending(): Record<string, unknown> {
  try {
    return z
      .record(z.string(), z.unknown())
      .parse(JSON.parse(sessionStorage.getItem(PENDING_KEY) ?? "{}"));
  } catch {
    return {};
  }
}

function writePending(pending: Record<string, unknown>) {
  try {
    sessionStorage.setItem(PENDING_KEY, JSON.stringify(pending));
  } catch {
    // Without storage, a reload only loses the result toast; the server still dedupes.
  }
}

export function readPendingRetries(): RetryRun[] {
  return Object.values(readPending()).flatMap((entry) => {
    const parsed = retryRunSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}

export function savePendingRetry(run: RetryRun) {
  writePending({ ...readPending(), [run.originalId]: run });
}

export function forgetPendingRetry(originalId: string) {
  const { [originalId]: _finished, ...rest } = readPending();
  writePending(rest);
}
