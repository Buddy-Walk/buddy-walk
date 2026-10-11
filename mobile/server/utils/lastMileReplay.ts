import { createHash } from "node:crypto";
import { LastMileSensors, validPoint } from "../../src/utils/lastMileSafety";

export const LAST_MILE_PIPELINE_VERSION = "3.0.0-safety-gated";
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
export function replayCompatibility(row: { replayInput?: ReplayInput; userPhoto?: string }): { replayable: boolean; reason: string } {
  const input = row.replayInput;
  if (input?.schemaVersion !== 1) return { replayable: false, reason: "Missing or unsupported replay-input version; legacy output fields are not substituted." };
  if (!validPoint(input) || typeof input.destination !== "string" || !input.destination.trim() || !Number.isFinite(input.receivedAt) || !input.sensors) {
    return { replayable: false, reason: "Capture metadata or required original inputs were not recorded." };
  }
  if (!row.userPhoto?.startsWith("data:image/")) return { replayable: false, reason: "Stored user photo is unavailable." };
  return { replayable: true, reason: "Uses the stored compressed photo and fresh provider data. Results are not a field test or live navigation." };
}
