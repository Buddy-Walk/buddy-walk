import type { Size } from '../readings/Reading';

/** What the tester fills in for a Mark. */
export type MarkFields = {
  /** The target's text as written on it, trimmed. For a sign on several lines, the line the tester tapped. */
  targetText: string;
  targetPoint: TargetPoint;
  targetKind: 'door-number' | 'sign';
  side: 'same-sidewalk' | 'across-street';
  /** Whether the tester can read the target themselves from where they stand. */
  visibleToTester: boolean;
  signStyle: 'plain' | 'stylised' | 'angled';
  /** What makes the target hard to read, in the order of `markConditions`. Empty when Other is the only one. */
  conditions: MarkCondition[];
  /** The condition the tester typed in for Other, trimmed, or null when Other isn't chosen. */
  otherCondition: string | null;
  /** Measured with a laser measure, like `wallDistanceFeet`. */
  distanceFeet: number;
  /** To the wall straight ahead of the tester, on the target's side of the street. Never more than `distanceFeet`. */
  wallDistanceFeet: number;
  /** Anything else about the target or the moment, trimmed, or null when left empty. */
  note: string | null;
};

/**
 * Where the tester tapped the target on the Mark's frame, as fractions (0 to 1) of the upright frame's
 * width and height from its top-left corner, like a Reading's `box`.
 */
export type TargetPoint = { x: number; y: number };

/**
 * The target point for a tap on the frame as the form shows it, upright and at its own aspect ratio.
 * A tap just past an edge lands on that edge.
 */
export function targetPointAt(tap: { x: number; y: number }, shown: Size): TargetPoint {
  return { x: clampToFrame(tap.x / shown.width), y: clampToFrame(tap.y / shown.height) };
}

function clampToFrame(fraction: number) {
  return Math.min(Math.max(fraction, 0), 1);
}

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
 * The form as the tester is filling it in: choices not made yet are null, and text boxes are as typed.
 * `otherCondition` is the Other text box as typed, kept while Other is unchosen.
 */
export type MarkDraft = {
  [Field in Exclude<keyof MarkFields, TypedField | 'distanceFeet' | 'wallDistanceFeet' | 'conditions'>]: MarkFields[Field] | null;
} & { [Field in TypedField | 'targetDistance' | 'wallDistance']: string } & { conditions: ConditionChoice[] };

type TypedField = 'targetText' | 'otherCondition' | 'note';

export const emptyMarkDraft: MarkDraft = {
  targetText: '',
  targetPoint: null,
  targetKind: null,
  side: null,
  visibleToTester: null,
  signStyle: null,
  conditions: [],
  otherCondition: '',
  targetDistance: '',
  wallDistance: '',
  note: '',
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

const INVALID_DISTANCE = `Type a distance between 0 and ${MAX_DISTANCE_FEET} feet, like 25 or 12.5.`;

/** Checks the form and, when it is complete, gives the Mark's fields. */
export function validateMarkForm(draft: MarkDraft): MarkFormResult {
  const errors: Partial<Record<keyof MarkDraft, string>> = {};
  const targetText = draft.targetText.trim();
  if (targetText === '') errors.targetText = 'Type what the target says.';
  if (draft.targetPoint === null) errors.targetPoint = 'Tap the target on the frame.';
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

  const distanceFeet = parseDistance(draft.targetDistance);
  if (draft.targetDistance.trim() === '') errors.targetDistance = 'Type the distance to the target in feet.';
  else if (distanceFeet === null) errors.targetDistance = INVALID_DISTANCE;
  const wallDistanceFeet = parseDistance(draft.wallDistance);
  if (draft.wallDistance.trim() === '') errors.wallDistance = 'Type the distance to the wall in feet.';
  else if (wallDistanceFeet === null) errors.wallDistance = INVALID_DISTANCE;
  // The wall straight ahead is never further than a target on it, whatever the angle.
  const wallTooFar = distanceFeet !== null && wallDistanceFeet !== null && wallDistanceFeet > distanceFeet;
  if (wallTooFar) errors.wallDistance = "The wall can't be further than the target. Measure both again.";

  if (
    targetText === '' ||
    draft.targetPoint === null ||
    draft.targetKind === null ||
    draft.side === null ||
    draft.visibleToTester === null ||
    draft.signStyle === null ||
    errors.conditions !== undefined ||
    otherMissing ||
    distanceFeet === null ||
    wallDistanceFeet === null ||
    wallTooFar
  ) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    fields: {
      targetText,
      targetPoint: draft.targetPoint,
      targetKind: draft.targetKind,
      side: draft.side,
      visibleToTester: draft.visibleToTester,
      signStyle: draft.signStyle,
      conditions: markConditions.filter((condition) => draft.conditions.includes(condition)),
      otherCondition: otherChosen ? otherCondition : null,
      distanceFeet,
      wallDistanceFeet,
      note: draft.note.trim() || null,
    },
  };
}

function parseDistance(typed: string): number | null {
  const trimmed = typed.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
  const feet = Number(trimmed);
  return feet > 0 && feet <= MAX_DISTANCE_FEET ? feet : null;
}
