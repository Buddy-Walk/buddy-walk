/**
 * Replay contract for Last Meters trials.
 *
 * Every test log stores a versioned snapshot of exactly what the pipeline
 * received, so a past trial can be re-run from the dashboard without
 * rebuilding the request from output fields. When the pipeline's inputs
 * change, bump REPLAY_INPUT_VERSION and add an upgrade step below; an upgrade
 * may fill a value it can justify (listed back to the reviewer) or block the
 * replay with a reason, but it must never invent data.
 */
import { createHash } from "node:crypto";
import { type LastMileSensors, validPoint } from "../../src/utils/lastMileSafety";

/** Bump by hand whenever a change could alter Last Meters results. */
export const LAST_METERS_PIPELINE_VERSION = "3.0.0-safety-gated";

/** Version label for runs another server handled through the upstream proxy. */
export const UPSTREAM_PIPELINE_VERSION = "upstream-proxy";

/** Version of the replay input snapshot written by this server. */
export const REPLAY_INPUT_VERSION = 1;

/** The user photo is stored at this width (JPEG quality below), not as sent. */
export const STORED_PHOTO_MAX_WIDTH = 1024;
export const STORED_PHOTO_JPEG_QUALITY = 76;

/** What the pipeline needs for one run, besides the photo. */
export interface LastMetersRequestInput {
  destination: string;
  lat: number;
  lng: number;
  /** Phone compass heading in degrees, as the app reported it. */
  deviceHeading?: number;
  gpsAccuracyMeters?: number;
  compassAccuracyLevel?: number;
  /** Capture timestamps and live readings the safety gate checks. */
  sensors?: LastMileSensors;
}

/** Version 1 snapshot. The photo itself lives on the log's userPhoto. */
export interface ReplayInput {
  schemaVersion: typeof REPLAY_INPUT_VERSION;
  /** When the server received the request; replays evaluate sensor freshness at this time. */
  receivedAt: number;
  lat: number;
  lng: number;
  destination: string;
  heading?: number;
  gpsAccuracyMeters?: number;
  compassAccuracyLevel?: number;
  sensors?: LastMileSensors;
  /** Hash of the photo as the app sent it, before it was compressed for storage. */
  originalPhotoSha256: string;
  photoRepresentation: "stored-compressed";
}

/** A snapshot as stored, possibly from an older or newer server. */
export type StoredReplayInput = { schemaVersion: number } & Record<string, unknown>;

export type ReplayStatus = "replayable" | "replayable_with_defaults" | "not_replayable";

export interface ReplayAssessment {
  status: ReplayStatus;
  /** Why the trial cannot be replayed. Set only when not_replayable. */
  reason?: string;
  /** True when the snapshot is from a pipeline this server cannot interpret. */
  incompatible?: boolean;
  /** Version the snapshot was recorded at; 0 means derived from a log written before snapshots. */
  sourceVersion?: number;
  /** Values an upgrade filled in, described for the reviewer. */
  defaultsApplied: string[];
  /** The snapshot upgraded to REPLAY_INPUT_VERSION, ready to run. */
  input?: ReplayInput;
  originalPanorama: { available: boolean; panoId?: string; panoramaDate?: string; reason?: string };
}

/** The log fields a replay assessment reads. */
export interface ReplayableLog {
  replayInput?: StoredReplayInput | ReplayInput;
  destination?: string;
  lat?: number;
  lng?: number;
  deviceHeading?: number;
  gpsAccuracyMeters?: number;
  compassAccuracyLevel?: number;
  userPhoto?: string;
  /** Whether the user photo can be replayed, for rows read without the photo. */
  userPhotoReplayable?: boolean;
  panoId?: string;
  panoramaDate?: string;
  testScenario?: string;
}

type UpgradeResult =
  | { ok: true; input: StoredReplayInput; defaultsApplied: string[] }
  | { ok: false; reason: string };

export type ReplayUpgrade = (input: StoredReplayInput) => UpgradeResult;

/**
 * Upgrade steps keyed by the version they upgrade from. Logs written before
 * snapshots existed (version 0) never recorded the capture timestamps the
 * safety gate requires, and the gate withholds every turn without them, so
 * they cannot be brought to version 1.
 */
export const REPLAY_INPUT_UPGRADES: Record<number, ReplayUpgrade> = {
  0: () => ({
    ok: false,
    reason:
      "This test was recorded before the app saved the phone's capture timestamps. " +
      "A retry needs them, or every turn is withheld.",
  }),
};

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function photoHash(photo: string): string {
  return createHash("sha256").update(photo).digest("hex");
}

/** A data URL with an actual image payload, not the empty "data:," placeholder. */
export function hasReplayablePhoto(value: unknown): boolean {
  return typeof value === "string" && /^data:image\/[\w.+-]+;base64,./.test(value);
}

/** The deployed commit on Render, when available. */
export function deployedCommit(): string {
  return (
    process.env.RENDER_GIT_COMMIT?.trim() || process.env.GIT_COMMIT?.trim() || "local-unversioned"
  );
}

/**
 * Reads the Last Meters request fields from a request body. Returns undefined
 * when the destination or coordinates are unusable.
 */
export function parseLastMetersRequest(body: unknown): LastMetersRequestInput | undefined {
  const record = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const destination = typeof record.destination === "string" ? record.destination.trim() : "";
  const lat = finiteNumber(record.lat);
  const lng = finiteNumber(record.lng);
  if (!destination || lat === undefined || lng === undefined || !validPoint({ lat, lng })) {
    return undefined;
  }
  const sensors = record.sensors;
  return {
    destination,
    lat,
    lng,
    deviceHeading: finiteNumber(record.heading),
    gpsAccuracyMeters: finiteNumber(record.gpsAccuracyMeters),
    compassAccuracyLevel: finiteNumber(record.compassAccuracyLevel),
    // Checked field by field by the safety gate, which withholds on anything invalid.
    sensors: sensors && typeof sensors === "object" ? (sensors as LastMileSensors) : undefined,
  };
}

export function buildReplayInput(
  request: LastMetersRequestInput,
  photo: string,
  receivedAt: number,
): ReplayInput {
  return {
    schemaVersion: REPLAY_INPUT_VERSION,
    receivedAt,
    lat: request.lat,
    lng: request.lng,
    destination: request.destination,
    heading: request.deviceHeading,
    gpsAccuracyMeters: request.gpsAccuracyMeters,
    compassAccuracyLevel: request.compassAccuracyLevel,
    sensors: request.sensors,
    originalPhotoSha256: photoHash(photo),
    photoRepresentation: "stored-compressed",
  };
}

/** The pipeline request a snapshot describes. */
export function replayRequest(input: ReplayInput): LastMetersRequestInput {
  return {
    destination: input.destination,
    lat: input.lat,
    lng: input.lng,
    deviceHeading: input.heading,
    gpsAccuracyMeters: input.gpsAccuracyMeters,
    compassAccuracyLevel: input.compassAccuracyLevel,
    sensors: input.sensors,
  };
}

/** Version 0: the request values a pre-snapshot log recorded on the row itself. */
function legacyReplayInput(log: ReplayableLog): StoredReplayInput {
  return {
    schemaVersion: 0,
    destination: log.destination,
    lat: log.lat,
    lng: log.lng,
    heading: log.deviceHeading,
    gpsAccuracyMeters: log.gpsAccuracyMeters,
    compassAccuracyLevel: log.compassAccuracyLevel,
  };
}

/** Walks a stored snapshot up to the current version, one step at a time. */
export function upgradeReplayInput(
  stored: StoredReplayInput,
  upgrades: Record<number, ReplayUpgrade> = REPLAY_INPUT_UPGRADES,
  currentVersion: number = REPLAY_INPUT_VERSION,
): UpgradeResult & { incompatible?: boolean } {
  if (!Number.isInteger(stored.schemaVersion) || stored.schemaVersion < 0) {
    return { ok: false, reason: "The replay snapshot has no valid version.", incompatible: true };
  }
  if (stored.schemaVersion > currentVersion) {
    return {
      ok: false,
      reason:
        `Recorded by a newer pipeline (replay input v${stored.schemaVersion}); ` +
        `this server understands up to v${currentVersion}.`,
      incompatible: true,
    };
  }
  let input = stored;
  const defaultsApplied: string[] = [];
  while (input.schemaVersion < currentVersion) {
    const upgrade = upgrades[input.schemaVersion];
    if (!upgrade) {
      return {
        ok: false,
        reason: `No upgrade from replay input v${input.schemaVersion} to the current pipeline.`,
        incompatible: true,
      };
    }
    const from = input.schemaVersion;
    const step = upgrade(input);
    if (!step.ok) return { ...step, incompatible: true };
    if (step.input.schemaVersion <= from) {
      return {
        ok: false,
        reason: `The upgrade from replay input v${from} did not advance the version.`,
        incompatible: true,
      };
    }
    input = step.input;
    defaultsApplied.push(...step.defaultsApplied);
  }
  return { ok: true, input, defaultsApplied };
}

/** Checks an upgraded snapshot has every value the current pipeline requires. */
function validateCurrentInput(input: StoredReplayInput): ReplayInput | string {
  const destination = typeof input.destination === "string" ? input.destination.trim() : "";
  if (!destination) return "No destination was recorded.";
  const lat = finiteNumber(input.lat);
  const lng = finiteNumber(input.lng);
  // 0,0 is what a failed proxy log records when the request had no coordinates.
  if (lat === undefined || lng === undefined || (lat === 0 && lng === 0) || !validPoint({ lat, lng })) {
    return "No GPS coordinates were recorded.";
  }
  const receivedAt = finiteNumber(input.receivedAt);
  if (receivedAt === undefined) return "The time the request was received was not recorded.";
  if (!input.sensors || typeof input.sensors !== "object") {
    return "The phone's capture timestamps weren't recorded for this test. A retry needs them, or every turn is withheld.";
  }
  return {
    schemaVersion: REPLAY_INPUT_VERSION,
    receivedAt,
    lat,
    lng,
    destination,
    heading: finiteNumber(input.heading),
    gpsAccuracyMeters: finiteNumber(input.gpsAccuracyMeters),
    compassAccuracyLevel: finiteNumber(input.compassAccuracyLevel),
    sensors: input.sensors as LastMileSensors,
    originalPhotoSha256:
      typeof input.originalPhotoSha256 === "string" ? input.originalPhotoSha256 : "",
    photoRepresentation: "stored-compressed",
  };
}

/**
 * Decides whether a logged trial can be re-run by the current pipeline.
 * For a retry, pass the original trial: retries replay the original's inputs.
 */
export function assessReplay(
  log: ReplayableLog,
  upgrades: Record<number, ReplayUpgrade> = REPLAY_INPUT_UPGRADES,
  currentVersion: number = REPLAY_INPUT_VERSION,
): ReplayAssessment {
  const originalPanorama: ReplayAssessment["originalPanorama"] = log.panoId
    ? { available: true, panoId: log.panoId, ...(log.panoramaDate ? { panoramaDate: log.panoramaDate } : {}) }
    : {
        available: false,
        reason: "The original test did not record a Street View pano ID.",
      };
  const blocked = (reason: string, sourceVersion?: number, incompatible?: boolean): ReplayAssessment => ({
    status: "not_replayable",
    reason,
    incompatible,
    sourceVersion,
    defaultsApplied: [],
    originalPanorama,
  });

  if (log.testScenario === "question_routed") {
    return blocked(
      "Not a Last Meters trial: the input was a question and went to the question flow.",
    );
  }

  const stored = (log.replayInput as StoredReplayInput | undefined) ?? legacyReplayInput(log);
  const sourceVersion = Number.isInteger(stored.schemaVersion) ? stored.schemaVersion : undefined;
  const upgraded = upgradeReplayInput(stored, upgrades, currentVersion);
  if (!upgraded.ok) return blocked(upgraded.reason, sourceVersion, upgraded.incompatible);

  const input = validateCurrentInput(upgraded.input);
  if (typeof input === "string") return blocked(input, sourceVersion);
  const photoStored =
    log.userPhoto !== undefined ? hasReplayablePhoto(log.userPhoto) : log.userPhotoReplayable === true;
  if (!photoStored) {
    return blocked("No user photo was stored for this test.", sourceVersion);
  }

  return {
    status: upgraded.defaultsApplied.length ? "replayable_with_defaults" : "replayable",
    sourceVersion,
    defaultsApplied: upgraded.defaultsApplied,
    input,
    originalPanorama,
  };
}
