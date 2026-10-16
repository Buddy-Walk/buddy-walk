import { Vibration } from 'react-native';
import * as Haptics from 'expo-haptics';
import { PATTERNS, patternForManeuver } from './hapticPatterns';

export {
  PATTERN_LEGEND,
  PATTERNS,
  iconForManeuver,
  labelForManeuver,
  patternForManeuver,
} from './hapticPatterns';
export type { PatternKey } from './hapticPatterns';

/**
 * Fire a vibration pattern. Wrapped in try/catch so navigation never crashes
 * if the device or platform rejects a vibration call.
 */
export function pulse(pattern: readonly number[]): void {
  try {
    Vibration.vibrate([...pattern]);
  } catch (e) {
    console.warn('haptic pulse failed:', e);
  }
}

/**
 * Trigger a strong native impact, falling back to a short vibration when the haptics API is
 * unavailable.
 */
function heavyImpact(): void {
  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(() => {
    // Use basic vibration when the device cannot produce the requested heavy impact.
    try {
      Vibration.vibrate(40);
    } catch {
      // noop
    }
  });
}

/**
 * Strong, clearly-felt tactile confirmation for ANY button / control press.
 * Our users rely on touch feedback, so this fires a quick double Heavy impact
 * (via the iOS Taptic engine / Android equivalent) that is hard to miss, with a
 * vibration fallback. Fire-and-forget; never throws.
 */
export function tap(): void {
  heavyImpact();
  setTimeout(heavyImpact, 55);
}

/**
 * Even more emphatic feedback for primary / high-stakes actions (e.g. Submit,
 * Start Navigation, Call Access-A-Ride): a success-notification buzz that is
 * distinctly stronger than a normal button tap.
 */
export function tapMedium(): void {
  Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {
    // Use a recognizable double vibration when the requested native confirmation cue fails.
    try {
      Vibration.vibrate([0, 60, 50, 60]);
    } catch {
      // noop
    }
  });
}

/** Success notification feedback (e.g. capture confirmed, action completed). */
export function notifySuccess(): void {
  Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => { /* Treat unsupported success haptics as optional feedback rather than an application error. */ });
}

/** Warning / error notification feedback. */
export function notifyWarning(): void {
  Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => { /* Treat unsupported warning haptics as optional feedback rather than an application error. */ });
}

/** Stop a repeating vibration pulse when navigation or the associated action ends. */
export function cancelPulse(): void {
  try {
    Vibration.cancel();
  } catch {
    // noop
  }
}
