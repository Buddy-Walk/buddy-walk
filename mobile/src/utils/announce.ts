import { AccessibilityInfo, Platform } from 'react-native';
import { speakText } from './speakText';

// Cached screen-reader state so callers can branch synchronously. Kept in sync
// via the AccessibilityInfo listener below.
let screenReaderOn = false;

AccessibilityInfo.isScreenReaderEnabled()
  .then((enabled) => {
    // Seed the cached screen-reader state used to choose the appropriate spoken-feedback
    // channel.
    screenReaderOn = enabled;
  })
  .catch(() => { /* Leave the default screen-reader state in place if the platform cannot report accessibility status. */ });

AccessibilityInfo.addEventListener('screenReaderChanged', (enabled) => {
  // Keep the cached screen-reader state synchronized with changes made in device settings.
  screenReaderOn = enabled;
});

/** True when VoiceOver / TalkBack is currently active. */
export function isScreenReaderActive(): boolean {
  return screenReaderOn;
}

export type AnnounceOptions = {
  preferDevice?: boolean;
  /**
   * 'status' — ephemeral chatter ("Listening", "Could not start microphone").
   * 'content' — the answer itself, which the user may want to pause or replay.
   */
  kind?: 'status' | 'content';
};

/**
 * Speak a message to the user through exactly ONE channel to avoid the
 * double-narration that happens when the app's own TTS and the OS screen
 * reader both read the same text.
 *
 * - Screen reader ON  → hand off to the screen reader (announceForAccessibility).
 * - Screen reader OFF → use the app's text-to-speech (server voice / expo-speech).
 *
 * Content is the exception: screen-reader announcements cannot be paused,
 * replayed, or scrubbed, and are dropped outright when focus moves. A blind
 * user who missed a direction would have no way to hear it again, so answers
 * always go through app TTS where the transport controls actually apply.
 *
 * RN Web always reports screen reader enabled but announceForAccessibility is a
 * no-op there, so web always uses in-app TTS.
 */
export function announce(text: string, options?: AnnounceOptions): void {
  const trimmed = text?.trim();
  if (!trimmed) return;

  const handOffToScreenReader =
    Platform.OS !== 'web' && screenReaderOn && options?.kind !== 'content';

  if (handOffToScreenReader) {
    AccessibilityInfo.announceForAccessibility(trimmed);
  } else {
    void speakText(trimmed, options);
  }
}

/** Speak replayable content (an answer) rather than ephemeral status. */
export function speakContent(
  text: string,
  options?: { preferDevice?: boolean },
): void {
  announce(text, { ...options, kind: 'content' });
}
