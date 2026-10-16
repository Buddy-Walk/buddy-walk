import { AppState } from 'react-native';
import { AudioMode, setAudioModeAsync } from 'expo-audio';

type Mode = 'playback' | 'recording';

const PLAYBACK_MODE: Partial<AudioMode> = {
  allowsRecording: false,
  playsInSilentMode: true,
  shouldPlayInBackground: false,
  interruptionMode: 'doNotMix',
  shouldRouteThroughEarpiece: false,
};

const RECORDING_MODE: Partial<AudioMode> = {
  ...PLAYBACK_MODE,
  allowsRecording: true,
};

// Serialize audio-mode changes. iOS throws OSStatus 561017449 when the session
// is reconfigured while another change is still settling, so we chain calls and
// never run two at once.
let chain: Promise<void> = Promise.resolve();
let lastApplied: Mode | null = null;

/** Yield for a short audio-session settling interval without blocking the UI thread. */
function sleep(ms: number): Promise<void> {
  return new Promise(/* Resolve the settling delay after the requested number of milliseconds. */ (resolve) => setTimeout(resolve, ms));
}

/**
 * Switch the foreground app between recording and playback modes, suppressing redundant changes
 * and retrying a temporarily busy native audio session once.
 */
async function applyMode(mode: Mode): Promise<void> {
  if (AppState.currentState !== 'active') return;
  // Skip redundant switches — re-applying the same mode is what most often
  // trips the "session busy" error and it buys us nothing.
  if (mode === lastApplied) return;

  const config = mode === 'recording' ? RECORDING_MODE : PLAYBACK_MODE;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await setAudioModeAsync(config);
      lastApplied = mode;
      return;
    } catch (e) {
      // The session is often busy for only a moment (e.g. a recording is still
      // tearing down). Wait briefly and try once more before giving up quietly.
      if (attempt === 0) {
        await sleep(150);
        continue;
      }
      console.warn(`audioSession: could not switch to ${mode} mode:`, e);
    }
  }
}

/** Serialize audio-mode changes so microphone teardown and speech playback do not race each other. */
function enqueue(mode: Mode): Promise<void> {
  chain = chain.then(/* Apply the requested audio mode only after earlier transitions have settled. */ () => applyMode(mode)).catch(() => { /* Keep a failed audio-mode transition from rejecting the shared queue and preventing later transitions. */ });
  return chain;
}

/** Switch from mic recording to TTS playback (fixes silent AI answers after Tap to Ask). */
export function resetAudioForPlayback(): Promise<void> {
  return enqueue('playback');
}

/**
 * iOS routes TTS to the earpiece when the session was recently in recording mode.
 * Force a fresh playback configuration so answers play through the loudspeaker.
 */
export async function ensurePlaybackThroughSpeaker(): Promise<void> {
  lastApplied = null;
  await enqueue('playback');
  await sleep(80);
  lastApplied = null;
  await enqueue('playback');
}

/**
 * Release the previous playback/microphone route, then reopen recording with short settling gaps
 * so repeated voice interactions can acquire the mic.
 */
export async function prepareAudioForRecording(): Promise<void> {
  // Drop back to playback briefly so iOS releases the mic route after TTS, then
  // re-open recording. Without the gap, createAsync often fails on the 2nd tap.
  lastApplied = null;
  await enqueue('playback');
  await sleep(120);
  lastApplied = null;
  await enqueue('recording');
  await sleep(80);
}
