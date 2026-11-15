/**
 * Where a Reading sits in its frame, as fractions (0-1) of the upright frame's width and height,
 * measured from the top-left corner.
 */
export type Box = {
  x: number;
  y: number;
  width: number;
  height: number;
};

/** One piece of text the camera recognised in one frame (see `CONTEXT.md`). */
export type Reading = {
  text: string;
  box: Box;
  /** When the camera captured the frame, in milliseconds on the camera's clock (not wall-clock time). */
  frameTimestamp: number;
  /** How long the frame took to read, in milliseconds: turning it upright for ML Kit, then recognising its text. */
  recognitionMs: number;
};

export type Size = { width: number; height: number };

/** The Readings of one processed frame, which may be none. */
export type FrameReadings = {
  readings: Reading[];
  /** The upright frame's size in pixels, so a view can match its aspect ratio. */
  frameSize: Size;
};
