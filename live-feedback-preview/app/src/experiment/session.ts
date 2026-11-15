import type { Reading } from '../readings/Reading';
import type { MarkFields } from './markForm';

/**
 * An experiment session: one stretch of street the tester records for the first experiment (#106).
 * It is not a Trial: there is no Destination brief and no Matches, and nothing goes to a server.
 *
 * This is the shape of the exported `session.json`, documented in the app README.
 * Bump `SESSION_VERSION` whenever the shape changes.
 */
export const SESSION_VERSION = 1;

export type ExperimentSession = {
  version: typeof SESSION_VERSION;
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
  marks: Mark[];
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

/** A target the tester marked: the frame at the tap, its Readings, and what the tester filled in. */
export type Mark = MarkFields & {
  /** ISO 8601 time of the tap. */
  markedAt: string;
  /** The frame's JPEG, next to `session.json`. */
  frameFile: string;
  heading: Heading | null;
  readings: Reading[];
};

export type SessionInfo = Pick<ExperimentSession, 'device' | 'app'>;
