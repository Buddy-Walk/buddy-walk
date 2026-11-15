import { describe, expect, test } from 'bun:test';
import { strFromU8, unzipSync } from 'fflate';

import type { Reading } from '../readings/Reading';
import { createSessionStore } from './sessionStore';
import { diskSessionsRoot } from './testing/diskSessionsRoot';

const info = {
  device: { model: 'iPhone 15', osVersion: '26.1' },
  app: { version: '1.0.0', build: '3' },
};

const heading = { trueDegrees: 92, magneticDegrees: 80, accuracy: 3 } as const;

function reading(text: string, frameTimestamp: number): Reading {
  return { text, box: { x: 0.1, y: 0.2, width: 0.3, height: 0.05 }, frameTimestamp, recognitionMs: 40 };
}

const frameSize = { width: 720, height: 1280 };

/** A clock the test moves by hand. */
function manualClock(start: string) {
  let now = Date.parse(start);
  return {
    now: () => new Date(now),
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('session store', () => {
  test('reloads a stopped session with its Readings, headings and frame rate', () => {
    const clock = manualClock('2026-11-15T14:00:00.000Z');
    const store = createSessionStore(diskSessionsRoot(), clock);

    const recorder = store.start(info);
    clock.advance(500);
    recorder.addFrame({ readings: [reading('34', 1000)], frameSize }, heading);
    clock.advance(500);
    recorder.addFrame({ readings: [], frameSize }, heading);
    clock.advance(500);
    recorder.addFrame({ readings: [reading('OPEN', 2000), reading('34', 2000)], frameSize }, null);
    clock.advance(500);
    recorder.addFrame({ readings: [], frameSize }, heading);
    recorder.stop();

    expect(store.load(recorder.id)).toEqual({
      version: 1,
      id: recorder.id,
      device: { model: 'iPhone 15', osVersion: '26.1' },
      app: { version: '1.0.0', build: '3' },
      startedAt: '2026-11-15T14:00:00.000Z',
      endedAt: '2026-11-15T14:00:02.000Z',
      framesProcessed: 4,
      framesPerSecond: 2,
      readings: [
        { ...reading('34', 1000), heading },
        { ...reading('OPEN', 2000), heading: null },
        { ...reading('34', 2000), heading: null },
      ],
      marks: [],
    });
  });

  test('leaves time with the camera paused, such as in the background, out of the frame rate', () => {
    const clock = manualClock('2026-11-15T14:00:00.000Z');
    const store = createSessionStore(diskSessionsRoot(), clock);

    const recorder = store.start(info);
    clock.advance(1000);
    recorder.addFrame({ readings: [], frameSize }, heading);
    recorder.pause();
    clock.advance(60_000);
    recorder.resume();
    clock.advance(1000);
    recorder.addFrame({ readings: [], frameSize }, heading);
    recorder.stop();

    expect(store.load(recorder.id).framesPerSecond).toBe(1);
  });

  test('leaves frames that arrive while paused, such as with a Mark form open, out of the log', () => {
    const clock = manualClock('2026-11-15T14:00:00.000Z');
    const store = createSessionStore(diskSessionsRoot(), clock);

    const recorder = store.start(info);
    clock.advance(1000);
    recorder.addFrame({ readings: [reading('34', 1000)], frameSize }, heading);
    recorder.pause();
    clock.advance(10_000);
    recorder.addFrame({ readings: [reading('34', 2000)], frameSize }, heading);
    recorder.addFrame({ readings: [], frameSize }, heading);
    recorder.resume();
    clock.advance(1000);
    recorder.addFrame({ readings: [reading('36', 3000)], frameSize }, heading);
    recorder.stop();

    const session = store.load(recorder.id);
    expect(session.readings.map((logged) => logged.frameTimestamp)).toEqual([1000, 3000]);
    expect(session.framesProcessed).toBe(2);
    expect(session.framesPerSecond).toBe(1);
  });

  test('two sessions started within the same second are kept apart', () => {
    const store = createSessionStore(diskSessionsRoot(), manualClock('2026-11-15T14:00:00.000Z'));

    const first = store.start(info);
    first.stop();
    const second = store.start(info);

    expect(second.id).not.toBe(first.id);
  });

  test('reloads a session cut off partway, up to its last save', () => {
    const clock = manualClock('2026-11-15T14:00:00.000Z');
    const root = diskSessionsRoot();
    const store = createSessionStore(root, clock);

    const recorder = store.start(info);
    clock.advance(1000);
    recorder.addFrame({ readings: [reading('12', 1000)], frameSize }, heading);
    clock.advance(1000);
    recorder.addFrame({ readings: [reading('14', 2000)], frameSize }, heading);
    clock.advance(1000);
    recorder.addFrame({ readings: [reading('16', 3000)], frameSize }, heading);
    // The app is killed partway through writing a line, and before the next save.
    root.folder(recorder.id).appendText('log.jsonl', '{"kind":"frame","heading":{"trueDeg');

    const session = store.load(recorder.id);

    expect(session.endedAt).toBeNull();
    expect(session.readings.map((logged) => logged.text)).toEqual(['12', '14']);
    expect(session.framesProcessed).toBe(2);
    expect(session.framesPerSecond).toBe(1);
  });

  test('keeps a saved Mark even when the app is killed straight after', () => {
    const clock = manualClock('2026-11-15T14:00:00.000Z');
    const store = createSessionStore(diskSessionsRoot(), clock);
    const recorder = store.start(info);

    const frameFile = recorder.saveMarkFrame(new Uint8Array([0xff, 0xd8, 0xff]));
    recorder.addMark({
      markedAt: '2026-11-15T14:00:05.000Z',
      frameFile,
      heading,
      readings: [reading('34', 5000)],
      targetKind: 'street-number',
      side: 'same-sidewalk',
      visibleToTester: true,
      signStyle: 'plain',
      distanceFeet: 12,
    });
    // No stop: the app is killed.

    expect(store.load(recorder.id).marks).toEqual([
      {
        markedAt: '2026-11-15T14:00:05.000Z',
        frameFile: 'mark-001.jpg',
        heading,
        readings: [reading('34', 5000)],
        targetKind: 'street-number',
        side: 'same-sidewalk',
        visibleToTester: true,
        signStyle: 'plain',
        distanceFeet: 12,
      },
    ]);
  });

  test('numbers Mark frames in order, and a cancelled Mark leaves no frame behind', () => {
    const root = diskSessionsRoot();
    const store = createSessionStore(root, manualClock('2026-11-15T14:00:00.000Z'));
    const recorder = store.start(info);

    const cancelled = recorder.saveMarkFrame(new Uint8Array([1]));
    recorder.discardMarkFrame(cancelled);
    const second = recorder.saveMarkFrame(new Uint8Array([2]));
    const third = recorder.saveMarkFrame(new Uint8Array([3]));

    expect([cancelled, second, third]).toEqual(['mark-001.jpg', 'mark-002.jpg', 'mark-003.jpg']);
    expect(root.folder(recorder.id).fileNames().sort()).toEqual(['log.jsonl', 'mark-002.jpg', 'mark-003.jpg']);
  });

  test('lists past sessions newest first, including one cut off partway, and deletes them', () => {
    const clock = manualClock('2026-11-15T14:00:00.000Z');
    const store = createSessionStore(diskSessionsRoot(), clock);

    const first = store.start(info);
    clock.advance(3000);
    first.addFrame({ readings: [reading('34', 1000), reading('OPEN', 1000)], frameSize }, heading);
    first.stop();
    clock.advance(60_000);
    const second = store.start(info);
    // Cut off: never stopped.

    expect(store.list()).toEqual([
      { readable: true, id: second.id, startedAt: '2026-11-15T14:01:03.000Z', endedAt: null, readingCount: 0, markCount: 0 },
      {
        readable: true,
        id: first.id,
        startedAt: '2026-11-15T14:00:00.000Z',
        endedAt: '2026-11-15T14:00:03.000Z',
        readingCount: 2,
        markCount: 0,
      },
    ]);

    store.remove(first.id);

    expect(store.list().map((summary) => summary.id)).toEqual([second.id]);
  });

  test('lists a session that cannot be read, so it can still be deleted', () => {
    const root = diskSessionsRoot();
    const store = createSessionStore(root, manualClock('2026-11-15T14:00:00.000Z'));
    const good = store.start(info);
    good.stop();
    // Killed while writing its very first line.
    root.folder('2026-11-15T13-00-00Z').appendText('log.jsonl', '{"kind":"sta');

    expect(store.list().map((summary) => [summary.id, summary.readable])).toEqual([
      [good.id, true],
      ['2026-11-15T13-00-00Z', false],
    ]);

    store.remove('2026-11-15T13-00-00Z');

    expect(store.list().map((summary) => summary.id)).toEqual([good.id]);
  });

  test('exports a session as one archive holding session.json and its Mark frames', () => {
    const clock = manualClock('2026-11-15T14:00:00.000Z');
    const store = createSessionStore(diskSessionsRoot(), clock);
    const recorder = store.start(info);
    recorder.addFrame({ readings: [reading('34', 1000)], frameSize }, heading);
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
    const frameFile = recorder.saveMarkFrame(jpeg);
    recorder.addMark({
      markedAt: '2026-11-15T14:00:01.000Z',
      frameFile,
      heading,
      readings: [reading('34', 1000)],
      targetKind: 'street-number',
      side: 'same-sidewalk',
      visibleToTester: true,
      signStyle: 'plain',
      distanceFeet: 10,
    });
    // The tester tapped Mark again, and the app was killed before the form was saved.
    recorder.saveMarkFrame(new Uint8Array([9]));
    clock.advance(1000);
    recorder.stop();

    const files = unzipSync(store.exportArchive(recorder.id));

    expect(Object.keys(files).sort()).toEqual([`${recorder.id}/mark-001.jpg`, `${recorder.id}/session.json`]);
    expect(files[`${recorder.id}/mark-001.jpg`]).toEqual(jpeg);
    expect(JSON.parse(strFromU8(files[`${recorder.id}/session.json`]))).toEqual(store.load(recorder.id));
  });
});
