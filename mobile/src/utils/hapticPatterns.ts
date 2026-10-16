/**
 * Vibration patterns for turn cues (left, right, arrive, etc.).
 * Used by useTurnByTurnNavigation for optional supplemental guidance — not
 * the primary navigation path in the app.
 */
const SHORT = 120;
const GAP = 90;
const HEADS_UP = 220;
const LONG = 1500;

export const PATTERNS = {
  LEFT: [0, SHORT, GAP, SHORT],
  RIGHT: [0, SHORT, GAP, SHORT, GAP, SHORT],
  UTURN: [0, SHORT, GAP, SHORT, GAP, SHORT, GAP, SHORT],
  STRAIGHT: [0, HEADS_UP],
  HEADS_UP: [0, HEADS_UP],
  ARRIVED: [0, LONG],
  OFF_ROUTE: [0, 80, 60, 80, 60, 80, 200, 600],
} as const;

export type PatternKey = keyof typeof PATTERNS;

export const PATTERN_LEGEND: { key: PatternKey; description: string }[] = [
  { key: 'LEFT', description: 'Two short pulses - turn left' },
  { key: 'RIGHT', description: 'Three short pulses - turn right' },
  { key: 'UTURN', description: 'Four short pulses - u-turn' },
  { key: 'STRAIGHT', description: 'One medium pulse - continue straight' },
  { key: 'HEADS_UP', description: 'One medium pulse - turn approaching' },
  { key: 'ARRIVED', description: 'One long buzz - you have arrived' },
  { key: 'OFF_ROUTE', description: 'Alternating buzzes - possibly off route' },
];

/**
 * Translate a route maneuver into its tactile vibration pattern, defaulting unknown maneuvers to
 * the continue-straight cue.
 */
export function patternForManeuver(maneuver: string | null | undefined): readonly number[] {
  if (!maneuver) return PATTERNS.STRAIGHT;
  const m = maneuver.toLowerCase();
  if (m.includes('arrive')) return PATTERNS.ARRIVED;
  if (m.includes('uturn')) return PATTERNS.UTURN;
  if (m.includes('left')) return PATTERNS.LEFT;
  if (m.includes('right')) return PATTERNS.RIGHT;
  return PATTERNS.STRAIGHT;
}

/** Choose a short readable maneuver label for the navigation UI and accessibility announcements. */
export function labelForManeuver(maneuver: string | null | undefined): string {
  if (!maneuver) return 'Continue';
  const m = maneuver.toLowerCase();
  if (m.includes('arrive')) return 'Arrive';
  if (m.includes('uturn')) return 'U-turn';
  if (m.includes('sharp-left')) return 'Sharp left';
  if (m.includes('sharp-right')) return 'Sharp right';
  if (m.includes('slight-left')) return 'Slight left';
  if (m.includes('slight-right')) return 'Slight right';
  if (m.includes('roundabout')) return 'Roundabout';
  if (m.includes('merge')) return 'Merge';
  if (m.includes('fork')) return 'Fork';
  if (m.includes('ramp')) return 'Ramp';
  if (m.includes('left')) return 'Left';
  if (m.includes('right')) return 'Right';
  return 'Continue straight';
}

/**
 * Choose the visual direction symbol that accompanies a maneuver; unknown maneuvers use the
 * forward arrow.
 */
export function iconForManeuver(maneuver: string | null | undefined): string {
  if (!maneuver) return '\u2B06\uFE0F';
  const m = maneuver.toLowerCase();
  if (m.includes('arrive')) return '\u{1F3C1}';
  if (m.includes('uturn')) return '\u21A9\uFE0F';
  if (m.includes('sharp-left')) return '\u2196\uFE0F';
  if (m.includes('sharp-right')) return '\u2197\uFE0F';
  if (m.includes('slight-left')) return '\u2196\uFE0F';
  if (m.includes('slight-right')) return '\u2197\uFE0F';
  if (m.includes('roundabout')) return '\u{1F504}';
  if (m.includes('left')) return '\u2B05\uFE0F';
  if (m.includes('right')) return '\u27A1\uFE0F';
  return '\u2B06\uFE0F';
}
