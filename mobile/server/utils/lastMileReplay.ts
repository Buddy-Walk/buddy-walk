import { createHash } from "node:crypto";
import type { LastMileSensors } from "../../src/utils/lastMileSafety";

export const LAST_MILE_PIPELINE_VERSION = "3.0.0-safety-gated";
// Original-input logging retained for audit and Mykael's pending retry flow
// (#35). Keep this stored schema intact; his branch owns assessment/execution.
export interface ReplayInput {
  schemaVersion: 1;
  receivedAt: number;
  lat: number; lng: number; destination: string;
  heading?: number; gpsAccuracyMeters?: number; compassAccuracyLevel?: number;
  sensors?: LastMileSensors;
  originalPhotoSha256: string;
  photoRepresentation: "stored-compressed";
}
export function photoHash(photo: string): string { return createHash("sha256").update(photo).digest("hex"); }
