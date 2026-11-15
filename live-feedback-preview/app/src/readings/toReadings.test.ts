import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import { loadAsMetroBundles } from '../testing/loadAsMetroBundles';
import * as asWritten from './toReadings';
import type { RecognizedText } from './toReadings';

// toReadings runs on the camera's frame thread as a worklet, so it is also tested as the
// worklets plugin compiles it.
const asMetroBundles = loadAsMetroBundles(join(import.meta.dir, 'toReadings.ts')) as typeof asWritten;

function line(lineText: string, centerX: number, centerY: number, width: number, height: number) {
  // x and y are deliberately wrong, as ocr-plus 2.1.2 reports them: only the center and size are right.
  return { lineText, lineFrame: { boundingCenterX: centerX, boundingCenterY: centerY, width, height, x: -999, y: -999 } };
}

function recognized(...lines: ReturnType<typeof line>[]): RecognizedText {
  return { blocks: [{ lines }] };
}

describe.each([
  ['as written', asWritten],
  ['as Metro bundles it', asMetroBundles],
])('toReadings %s', (_, { toReadings }) => {
  test('gives one Reading per line, with its box as fractions of the upright frame', () => {
    const readings = toReadings(
      recognized(line('34', 360, 640, 144, 64), line("Joe's Pizza", 360, 320, 360, 128)),
      { width: 1280, height: 720, orientation: 'right', timestamp: 12.5 },
      42,
    );

    expect(readings).toEqual([
      { text: '34', box: { x: 0.4, y: 0.475, width: 0.2, height: 0.05 }, frameTimestamp: 12500, recognitionMs: 42 },
      { text: "Joe's Pizza", box: { x: 0.25, y: 0.2, width: 0.5, height: 0.1 }, frameTimestamp: 12500, recognitionMs: 42 },
    ]);
  });

  test('keeps the buffer size when the frame is already upright', () => {
    const [reading] = toReadings(
      recognized(line('OPEN', 640, 360, 256, 72)),
      { width: 1280, height: 720, orientation: 'up', timestamp: 1 },
      10,
    );

    expect(reading.box).toEqual({ x: 0.4, y: 0.45, width: 0.2, height: 0.1 });
  });

  test('reads lines from every block', () => {
    const readings = toReadings(
      { blocks: [{ lines: [line('12', 100, 100, 20, 20)] }, { lines: [line('14', 300, 100, 20, 20)] }] },
      { width: 1280, height: 720, orientation: 'right', timestamp: 0 },
      5,
    );

    expect(readings.map((reading) => reading.text)).toEqual(['12', '14']);
  });

  test('trims text and drops lines with no text', () => {
    const readings = toReadings(
      recognized(line('  34  ', 360, 640, 144, 64), line('   ', 360, 320, 100, 100)),
      { width: 1280, height: 720, orientation: 'right', timestamp: 0 },
      5,
    );

    expect(readings.map((reading) => reading.text)).toEqual(['34']);
  });

  test('clips boxes that reach past the frame edge', () => {
    const [reading] = toReadings(
      recognized(line('PHARMACY', 36, 1260, 144, 64)),
      { width: 1280, height: 720, orientation: 'right', timestamp: 0 },
      5,
    );

    expect(reading.box).toEqual({ x: 0, y: 0.959375, width: 0.15, height: 0.040625 });
  });
});
