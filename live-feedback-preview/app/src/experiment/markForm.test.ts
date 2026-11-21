import { describe, expect, test } from 'bun:test';

import { emptyMarkDraft, toggleCondition, validateMarkForm, type MarkDraft } from './markForm';

const complete = {
  targetKind: 'sign',
  side: 'across-street',
  visibleToTester: true,
  signStyle: 'stylised',
  conditions: ['faded'],
  otherCondition: '',
  distance: '35',
} satisfies MarkDraft;

describe('Mark form', () => {
  test('a filled-in form gives the Mark fields, with the distance in feet', () => {
    expect(validateMarkForm(complete)).toEqual({
      ok: true,
      fields: {
        targetKind: 'sign',
        side: 'across-street',
        visibleToTester: true,
        signStyle: 'stylised',
        conditions: ['faded'],
        otherCondition: null,
        distanceFeet: 35,
      },
    });
  });

  test('"not visible to the tester" is an answer, not a missing one', () => {
    const result = validateMarkForm({ ...complete, visibleToTester: false });

    expect(result.ok && result.fields.visibleToTester).toBe(false);
  });

  test('an untouched form asks for every field', () => {
    expect(validateMarkForm(emptyMarkDraft)).toEqual({
      ok: false,
      errors: {
        targetKind: 'Choose door number or sign.',
        side: 'Choose same sidewalk or across the street.',
        visibleToTester: 'Choose whether you can read it yourself.',
        signStyle: 'Choose plain, stylised or angled.',
        conditions: 'Choose what makes it hard to read, or Clear.',
        distance: 'Type the distance in feet.',
      },
    });
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

  test.each(['12.5', ' 8 ', '0.5'])('accepts a distance of %p feet', (distance) => {
    const result = validateMarkForm({ ...complete, distance });

    expect(result.ok && result.fields.distanceFeet).toBe(Number(distance));
  });

  test.each(['abc', '0', '-3', '12ft', '1e3', '1001'])('rejects a distance of %p', (distance) => {
    expect(validateMarkForm({ ...complete, distance })).toEqual({
      ok: false,
      errors: { distance: 'Type a distance between 0 and 1000 feet, like 25 or 12.5.' },
    });
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
