import { Platform, Vibration } from 'react-native';
import * as Haptics from 'expo-haptics';

/**
 * Non-verbal cues for the voice loop.
 *
 * Spoken status ("Listening. Speak after this message, then tap again when
 * finished.") costs a blind user several seconds on every single question, and
 * when a screen reader is active the app additionally has to stall so the
 * prompt is not recorded by the microphone. A haptic conveys the same state
 * change instantly and is inaudible to the mic, so recording can start
 * immediately.
 */

const isWeb = Platform.OS === 'web';

/**
 * Deliver native tactile voice-state feedback with a basic vibration fallback; browser builds
 * deliberately skip it.
 */
async function haptic(run: () => Promise<void>, fallback: number | number[]): Promise<void> {
  if (isWeb) return;
  try {
    await run();
  } catch {
    // Haptics are unavailable on some Android hardware; a plain vibration
    // still conveys the state change.
    try {
      Vibration.vibrate(fallback as number);
    } catch {
      /* ignore */
    }
  }
}

/** Mic is open — start talking now. */
export function cueListening(): Promise<void> {
  return haptic(
    /** Use a native success haptic to signal that the microphone is listening. */
    () => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success),
    60,
  );
}

/** Speech captured, request is on its way. */
export function cueCaptured(): Promise<void> {
  return haptic(
    /** Use a medium native impact to confirm that speech or camera input was captured. */
    () => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium),
    40,
  );
}

/** Nothing usable was heard, or the request failed. */
export function cueError(): Promise<void> {
  return haptic(
    /** Use a native error haptic to signal that the attempted voice interaction could not complete. */
    () => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error),
    [0, 180, 120, 180],
  );
}
