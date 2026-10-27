import mongoose, { Schema } from "mongoose";
import { RETRY_PANORAMA_MODES, type RetryPanoramaMode } from "./lastMileTestLog";

export const RETRY_RUN_STATUSES = ["running", "succeeded", "failed"] as const;
export type RetryRunStatus = (typeof RETRY_RUN_STATUSES)[number];

/**
 * One dashboard retry request, keyed by the client's UUIDv7 idempotency key.
 * A re-sent request with the same key gets this run's result instead of
 * starting another paid run.
 */
export interface lastMileRetryRunInterface {
  /** The Idempotency-Key header, a lowercase UUIDv7. */
  _id: string;
  /** The test id the request named; a retry's id resolves to its original. */
  requestedId: string;
  originalId: string;
  panoramaMode: RetryPanoramaMode;
  status: RetryRunStatus;
  startedAt: Date;
  /** A running run past this time is treated as interrupted by a restart. */
  leaseExpiresAt: Date;
  finishedAt?: Date;
  testLogId?: string;
  defaultsApplied?: string[];
  errorStatus?: number;
  errorCode?: string;
  errorMessage?: string;
}

const LastMileRetryRunSchema = new Schema<lastMileRetryRunInterface>(
  {
    _id: { type: String, required: true },
    requestedId: { type: String, required: true },
    originalId: { type: String, required: true },
    panoramaMode: { type: String, enum: [...RETRY_PANORAMA_MODES], required: true },
    status: { type: String, enum: [...RETRY_RUN_STATUSES], required: true },
    startedAt: { type: Date, required: true },
    leaseExpiresAt: { type: Date, required: true },
    finishedAt: Date,
    testLogId: String,
    defaultsApplied: [String],
    errorStatus: Number,
    errorCode: String,
    errorMessage: String,
  },
  { versionKey: false }
);

export default mongoose.model<lastMileRetryRunInterface>(
  "LastMileRetryRun",
  LastMileRetryRunSchema,
  "last_mile_retry_run"
);
