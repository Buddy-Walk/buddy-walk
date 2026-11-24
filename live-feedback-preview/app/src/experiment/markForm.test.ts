import { describe, expect, test } from 'bun:test';

import { emptyMarkDraft, targetPointAt, toggleCondition, validateMarkForm, type MarkDraft } from './markForm';

const complete = {
  targetText: "Joe's Pizza",
  targetPoint: { x: 0.42, y: 0.3 },
  targetKind: 'sign',
  side: 'across-street',
  visibleToTester: true,
  signStyle: 'stylised',
  conditions: ['faded'],
  otherCondition: '',
  targetDistance: '35',
  wallDistance: '28',
  note: '',
} satisfies MarkDraft;

describe('Mark form', () => {
  test('a filled-in form gives the Mark fields, with the distances in feet', () => {
    expect(validateMarkForm(complete)).toEqual({
      ok: true,
      fields: {
        targetText: "Joe's Pizza",
        targetPoint: { x: 0.42, y: 0.3 },
        targetKind: 'sign',
        side: 'across-street',
        visibleToTester: true,
        signStyle: 'stylised',
        conditions: ['faded'],
        otherCondition: null,
        distanceFeet: 35,
        wallDistanceFeet: 28,
        note: null,
      },
    });
  });

  test('"not visible to the tester" is an answer, not a missing one', () => {
    const result = validateMarkForm({ ...complete, visibleToTester: false });

    expect(result.ok && result.fields.visibleToTester).toBe(false);
  });

  test('an untouched form asks for every required field', () => {
    expect(validateMarkForm(emptyMarkDraft)).toEqual({
      ok: false,
      errors: {
        targetText: 'Type what the target says.',
        targetPoint: 'Tap the target on the frame.',
        targetKind: 'Choose door number or sign.',
        side: 'Choose same sidewalk or across the street.',
        visibleToTester: 'Choose whether you can read it yourself.',
        signStyle: 'Choose plain, stylised or angled.',
        conditions: 'Choose what makes it hard to read, or Clear.',
        targetDistance: 'Type the distance to the target in feet.',
        wallDistance: 'Type the distance to the wall in feet.',
      },
    });
  });

  test.each([['   '], ['\n']])('asks what the target says when the text box holds only %p', (targetText) => {
    expect(validateMarkForm({ ...complete, targetText })).toEqual({
      ok: false,
      errors: { targetText: 'Type what the target says.' },
    });
  });

  test("keeps the target's text as typed, trimmed", () => {
    const result = validateMarkForm({ ...complete, targetText: '  1247 B ' });

    expect(result.ok && result.fields.targetText).toBe('1247 B');
  });

  test('keeps a note, trimmed', () => {
    const result = validateMarkForm({ ...complete, note: ' a van parked in front for a moment\n' });

    expect(result.ok && result.fields.note).toBe('a van parked in front for a moment');
  });

  test('a note holding only spaces is no note', () => {
    const result = validateMarkForm({ ...complete, note: '   ' });

    expect(result.ok && result.fields.note).toBeNull();
  });

  test('gives the conditions in the order they are listed, whatever order they were chosen in', () => {
    const result = validateMarkForm({ ...complete, conditions: ['dark', 'faded', 'obstructed'] });

    expect(result.ok && result.fields.conditions).toEqual(['faded', 'obstructed', 'dark']);
  });

  test('keeps a typed-in condition, trimmed, beside the listed ones', () => {
    const result = validateMarkForm({ ...complete, conditions: ['other', 'glare'], otherCondition: '  graffiti over it ' });

    expect(result.ok && [result.fields.conditions, result.fields.otherCondition]).toEqual([['glare'], 'graffiti over it']);
  });

  test('a typed-in condition on its own leaves no listed conditions', () => {
    const result = validateMarkForm({ ...complete, conditions: ['other'], otherCondition: 'graffiti over it' });

    expect(result.ok && [result.fields.conditions, result.fields.otherCondition]).toEqual([[], 'graffiti over it']);
  });

  test('drops the typed-in text once Other is unchosen', () => {
    const result = validateMarkForm({ ...complete, conditions: ['faded'], otherCondition: 'graffiti over it' });

    expect(result.ok && result.fields.otherCondition).toBeNull();
  });

  test.each(['', '   '])('asks for the condition when Other is chosen and the text box holds %p', (otherCondition) => {
    expect(validateMarkForm({ ...complete, conditions: ['faded', 'other'], otherCondition })).toEqual({
      ok: false,
      errors: { otherCondition: 'Type what makes it hard to read, or unchoose Other.' },
    });
  });

  test.each([[['clear', 'faded']], [['clear', 'other']]] as const)('rejects Clear combined with another condition, as in %p', (conditions) => {
    expect(validateMarkForm({ ...complete, conditions: [...conditions], otherCondition: 'graffiti over it' })).toEqual({
      ok: false,
      errors: { conditions: 'Clear means nothing makes it hard to read, so choose it on its own.' },
    });
  });

  test.each(['12.5', ' 8 ', '0.5'])('accepts distances of %p feet', (distance) => {
    const result = validateMarkForm({ ...complete, targetDistance: distance, wallDistance: distance });

    expect(result.ok && [result.fields.distanceFeet, result.fields.wallDistanceFeet]).toEqual([Number(distance), Number(distance)]);
  });

  test.each(['abc', '0', '-3', '12ft', '1e3', '1001'])('rejects a distance of %p', (distance) => {
    expect(validateMarkForm({ ...complete, targetDistance: distance, wallDistance: '0.5' })).toEqual({
      ok: false,
      errors: { targetDistance: 'Type a distance between 0 and 1000 feet, like 25 or 12.5.' },
    });
  });

  test.each(['abc', '0', '-3', '12ft'])('rejects a wall distance of %p', (wallDistance) => {
    expect(validateMarkForm({ ...complete, wallDistance })).toEqual({
      ok: false,
      errors: { wallDistance: 'Type a distance between 0 and 1000 feet, like 25 or 12.5.' },
    });
  });

  test('accepts a wall as far as the target, for a target seen straight on', () => {
    const result = validateMarkForm({ ...complete, targetDistance: '12.5', wallDistance: '12.5' });

    expect(result.ok && [result.fields.distanceFeet, result.fields.wallDistanceFeet]).toEqual([12.5, 12.5]);
  });

  test('refuses a wall further away than the target', () => {
    expect(validateMarkForm({ ...complete, targetDistance: '20', wallDistance: '20.5' })).toEqual({
      ok: false,
      errors: { wallDistance: "The wall can't be further than the target. Measure both again." },
    });
  });
});

describe('tapping the target on the frame', () => {
  test('gives where the tap is as fractions of the shown frame, from its top-left corner', () => {
    expect(targetPointAt({ x: 45, y: 240 }, { width: 180, height: 320 })).toEqual({ x: 0.25, y: 0.75 });
  });

  test('keeps a tap just past the edge on the frame', () => {
    expect(targetPointAt({ x: -2, y: 321 }, { width: 180, height: 320 })).toEqual({ x: 0, y: 1 });
  });
});

describe('choosing conditions', () => {
  test('adds a condition, and choosing it again takes it away', () => {
    const chosen = toggleCondition(['faded'], 'other');

    expect(chosen).toEqual(['faded', 'other']);
    expect(toggleCondition(chosen, 'faded')).toEqual(['other']);
  });

  test('choosing Clear takes away everything else', () => {
    expect(toggleCondition(['faded', 'obstructed', 'other'], 'clear')).toEqual(['clear']);
  });

  test.each(['faded', 'other'] as const)('choosing %p takes Clear away', (choice) => {
    expect(toggleCondition(['clear'], choice)).toEqual([choice]);
  });
});
