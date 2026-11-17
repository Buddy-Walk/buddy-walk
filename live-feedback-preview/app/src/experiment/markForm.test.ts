import { describe, expect, test } from 'bun:test';

import { emptyMarkDraft, validateMarkForm } from './markForm';

const complete = {
  targetKind: 'sign',
  side: 'across-street',
  visibleToTester: true,
  signStyle: 'stylised',
  distance: '35',
} as const;

describe('Mark form', () => {
  test('a filled-in form gives the Mark fields, with the distance in feet', () => {
    expect(validateMarkForm(complete)).toEqual({
      ok: true,
      fields: { targetKind: 'sign', side: 'across-street', visibleToTester: true, signStyle: 'stylised', distanceFeet: 35 },
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
        distance: 'Type the distance in feet.',
      },
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
