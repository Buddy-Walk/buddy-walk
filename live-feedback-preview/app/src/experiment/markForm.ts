/** What the tester fills in for a Mark. */
export type MarkFields = {
  targetKind: 'door-number' | 'sign';
  side: 'same-sidewalk' | 'across-street';
  /** Whether the tester can read the target themselves from where they stand. */
  visibleToTester: boolean;
  signStyle: 'plain' | 'stylised' | 'angled';
  distanceFeet: number;
};

/** The form as the tester is filling it in: choices not made yet are null, and the distance is as typed. */
export type MarkDraft = {
  [Field in Exclude<keyof MarkFields, 'distanceFeet'>]: MarkFields[Field] | null;
} & { distance: string };

export const emptyMarkDraft: MarkDraft = {
  targetKind: null,
  side: null,
  visibleToTester: null,
  signStyle: null,
  distance: '',
};

export type MarkFormResult =
  | { ok: true; fields: MarkFields }
  | { ok: false; errors: Partial<Record<keyof MarkDraft, string>> };

const MAX_DISTANCE_FEET = 1000;

/** Checks the form and, when it is complete, gives the Mark's fields. */
export function validateMarkForm(draft: MarkDraft): MarkFormResult {
  const errors: Partial<Record<keyof MarkDraft, string>> = {};
  if (draft.targetKind === null) errors.targetKind = 'Choose door number or sign.';
  if (draft.side === null) errors.side = 'Choose same sidewalk or across the street.';
  if (draft.visibleToTester === null) errors.visibleToTester = 'Choose whether you can read it yourself.';
  if (draft.signStyle === null) errors.signStyle = 'Choose plain, stylised or angled.';

  const distanceFeet = parseDistance(draft.distance);
  if (draft.distance.trim() === '') errors.distance = 'Type the distance in feet.';
  else if (distanceFeet === null) errors.distance = `Type a distance between 0 and ${MAX_DISTANCE_FEET} feet, like 25 or 12.5.`;

  if (
    draft.targetKind === null ||
    draft.side === null ||
    draft.visibleToTester === null ||
    draft.signStyle === null ||
    distanceFeet === null
  ) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    fields: {
      targetKind: draft.targetKind,
      side: draft.side,
      visibleToTester: draft.visibleToTester,
      signStyle: draft.signStyle,
      distanceFeet,
    },
  };
}

function parseDistance(typed: string): number | null {
  const trimmed = typed.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
  const feet = Number(trimmed);
  return feet > 0 && feet <= MAX_DISTANCE_FEET ? feet : null;
}
