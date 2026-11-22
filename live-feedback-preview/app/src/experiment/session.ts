import type { Reading } from '../readings/Reading';
import type { MarkFields } from './markForm';

/**
 * An experiment session: one stretch of street the tester records for the first experiment (#106).
 * It is not a Trial: there is no Destination brief and no Matches, and nothing goes to a server.
 *
 * This is the shape of the exported `session.json`, documented in the app README.
 * Bump `SESSION_VERSION` whenever the shape changes.
 * Sessions keep the version they were recorded in, so one on the phone from an older version exports as it was.
 */
export const SESSION_VERSION = 3;

export type SessionVersion = 1 | 2 | typeof SESSION_VERSION;

export type ExperimentSession = {
  version: SessionVersion;
  id: string;
  device: { model: string | null; osVersion: string | null };
  app: { version: string | null; build: string | null };
  /** ISO 8601 times. `endedAt` is null when the session was cut off, for example by the app being killed. */
  startedAt: string;
  endedAt: string | null;
  framesProcessed: number;
  /** Frames processed per second over the session, or null if no time passed. */
  framesPerSecond: number | null;
  readings: LoggedReading[];
  marks: StoredMark[];
};

/** The phone's compass heading when a frame was read. */
export type Heading = {
  /** Degrees from true north, or null when iOS can't give one (for example without location permission). */
  trueDegrees: number | null;
  /** Degrees from magnetic north. */
  magneticDegrees: number;
  /** iOS calibration level, from 0 (over 50° uncertainty) to 3 (under 20°). */
  accuracy: 0 | 1 | 2 | 3;
};

export type LoggedReading = Reading & { heading: Heading | null };

/** A target the tester marked: the first frame read after the tap, its Readings, and what the tester filled in. */
export type Mark = MarkFields & {
  /** ISO 8601 time of the frame, the same moment as its Readings' `frameTimestamp`. */
  markedAt: string;
  /** The frame's JPEG, next to `session.json`. */
  frameFile: string;
  heading: Heading | null;
  readings: Reading[];
};

/**
 * A Mark as a session holds it.
 * Version 1 sessions stored a door number's `targetKind` as `street-number`,
 * and version 1 and 2 Marks have no `conditions` or `otherCondition`.
 */
export type StoredMark = Omit<Mark, 'targetKind' | 'conditions' | 'otherCondition'> & {
  targetKind: Mark['targetKind'] | 'street-number';
} & Partial<Pick<Mark, 'conditions' | 'otherCondition'>>;

export type SessionInfo = Pick<ExperimentSession, 'device' | 'app'>;
