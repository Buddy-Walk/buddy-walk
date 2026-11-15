import type { Box, Reading, Size } from './Reading';

/** Where ocr-plus found a line, in pixels of the upright frame. */
type LineFrame = { boundingCenterX: number; boundingCenterY: number; width: number; height: number };

/** The parts of an ocr-plus result that Readings are built from. */
export type RecognizedText = {
  blocks: { lines: { lineText: string; lineFrame: LineFrame }[] }[];
};

/** The parts of a frame that Readings need. */
export type FrameInfo = Size & {
  /** How the buffer is rotated relative to upright. */
  orientation: 'up' | 'right' | 'down' | 'left';
  /** Unix time in milliseconds, as in `Reading.frameTimestamp`. */
  timestamp: number;
};

// Each worklet must come after the worklets it calls. The worklets Babel plugin captures a
// worklet's callees where it is declared, so a callee declared further down is captured as
// undefined and the call throws on the frame thread.

function clamp(value: number, max: number) {
  'worklet';
  return Math.min(Math.max(value, 0), max);
}

// ocr-plus 2.1.2 computes the frame's x and y wrongly, so the box is built from its center and size.
function toBox(lineFrame: LineFrame, size: Size): Box {
  'worklet';
  const left = clamp(lineFrame.boundingCenterX - lineFrame.width / 2, size.width);
  const right = clamp(lineFrame.boundingCenterX + lineFrame.width / 2, size.width);
  const top = clamp(lineFrame.boundingCenterY - lineFrame.height / 2, size.height);
  const bottom = clamp(lineFrame.boundingCenterY + lineFrame.height / 2, size.height);
  return {
    x: left / size.width,
    y: top / size.height,
    width: (right - left) / size.width,
    height: (bottom - top) / size.height,
  };
}

/**
 * The size of the frame once ocr-plus has turned it upright, which is the space its boxes are in.
 * A frame rotated a quarter turn has its width and height swapped.
 */
export function uprightSize(frame: Pick<FrameInfo, 'width' | 'height' | 'orientation'>): Size {
  'worklet';
  const quarterTurn = frame.orientation === 'left' || frame.orientation === 'right';
  return quarterTurn ? { width: frame.height, height: frame.width } : { width: frame.width, height: frame.height };
}

/** Turns one frame's ocr-plus result into Readings, one per recognised line. */
export function toReadings(recognized: RecognizedText, frame: FrameInfo, recognitionMs: number): Reading[] {
  'worklet';
  const size = uprightSize(frame);
  const readings: Reading[] = [];
  for (const block of recognized.blocks) {
    for (const line of block.lines) {
      const text = line.lineText.trim();
      if (text === '') continue;
      readings.push({
        text,
        box: toBox(line.lineFrame, size),
        frameTimestamp: frame.timestamp,
        recognitionMs,
      });
    }
  }
  return readings;
}
