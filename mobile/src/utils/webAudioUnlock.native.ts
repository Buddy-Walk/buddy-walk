/** Report that native builds do not need Safari-specific audio workarounds. */
export function isSafariBrowser(): boolean {
  return false;
}

/** Report that native builds do not need Brave-specific browser behavior. */
export function isBraveBrowser(): boolean {
  return false;
}

export function unlockWebAudioForPlayback(): void {
  // Native uses expo-audio / expo-speech — no browser audio unlock needed.
}
