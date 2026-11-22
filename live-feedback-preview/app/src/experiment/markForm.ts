/** What the tester fills in for a Mark. */
export type MarkFields = {
  targetKind: 'door-number' | 'sign';
  side: 'same-sidewalk' | 'across-street';
  /** Whether the tester can read the target themselves from where they stand. */
  visibleToTester: boolean;
  signStyle: 'plain' | 'stylised' | 'angled';
  /** What makes the target hard to read, in the order of `markConditions`. Empty when Other is the only one. */
  conditions: MarkCondition[];
  /** The condition the tester typed in for Other, trimmed, or null when Other isn't chosen. */
  otherCondition: string | null;
  distanceFeet: number;
};

/**
 * What can make a target hard to read, documented in the app README.
 * `clear` can't be combined with any other. The three after it are about the target itself,
 * and the three after those about the moment it was marked.
 */
export const markConditions = ['clear', 'faded', 'dirty', 'damaged', 'obstructed', 'glare', 'dark'] as const;

export type MarkCondition = (typeof markConditions)[number];

/** A choice in the form's Conditions field: a listed condition, or Other, which the tester types in. */
export type ConditionChoice = MarkCondition | 'other';

/**
 * The form as the tester is filling it in: choices not made yet are null, and the distance is as typed.
 * `otherCondition` is the Other text box as typed, kept while Other is unchosen.
 */
export type MarkDraft = {
  [Field in Exclude<keyof MarkFields, 'distanceFeet' | 'conditions' | 'otherCondition'>]: MarkFields[Field] | null;
} & { conditions: ConditionChoice[]; otherCondition: string; distance: string };

export const emptyMarkDraft: MarkDraft = {
  targetKind: null,
  side: null,
  visibleToTester: null,
  signStyle: null,
  conditions: [],
  otherCondition: '',
  distance: '',
};

/** The conditions chosen after the tester taps one. Clear can't be combined with any other. */
export function toggleCondition(chosen: ConditionChoice[], tapped: ConditionChoice): ConditionChoice[] {
  if (chosen.includes(tapped)) return chosen.filter((choice) => choice !== tapped);
  if (tapped === 'clear') return ['clear'];
  return [...chosen.filter((choice) => choice !== 'clear'), tapped];
}

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
  if (draft.conditions.length === 0) errors.conditions = 'Choose what makes it hard to read, or Clear.';
  // The form keeps Clear on its own (`toggleCondition`), and this keeps any other draft from saving it with more.
  else if (draft.conditions.includes('clear') && draft.conditions.length > 1) {
    errors.conditions = 'Clear means nothing makes it hard to read, so choose it on its own.';
  }
  const otherChosen = draft.conditions.includes('other');
  const otherCondition = draft.otherCondition.trim();
  const otherMissing = otherChosen && otherCondition === '';
  if (otherMissing) errors.otherCondition = 'Type what makes it hard to read, or unchoose Other.';

  const distanceFeet = parseDistance(draft.distance);
  if (draft.distance.trim() === '') errors.distance = 'Type the distance in feet.';
  else if (distanceFeet === null) errors.distance = `Type a distance between 0 and ${MAX_DISTANCE_FEET} feet, like 25 or 12.5.`;

  if (
    draft.targetKind === null ||
    draft.side === null ||
    draft.visibleToTester === null ||
    draft.signStyle === null ||
    errors.conditions !== undefined ||
    otherMissing ||
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
      conditions: markConditions.filter((condition) => draft.conditions.includes(condition)),
      otherCondition: otherChosen ? otherCondition : null,
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
