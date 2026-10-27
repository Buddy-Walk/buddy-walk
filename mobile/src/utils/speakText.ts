import { Platform } from 'react-native';
import { createAudioPlayer, type AudioPlayer } from 'expo-audio';
import * as Speech from 'expo-speech';
import * as FileSystem from 'expo-file-system/legacy';

import { sendAudioRequest } from '../api/speech';
import { ensurePlaybackThroughSpeaker, resetAudioForPlayback } from './audioSession';
import { isSafariBrowser, unlockWebAudioForPlayback } from './webAudioUnlock';

const MAX_TTS_CHARS = 800;
const NATIVE_TTS_VOLUME = 1.0;
const isWeb = Platform.OS === 'web';
const isNative = !isWeb;

let activeSound: AudioPlayer | null = null;
let activeWebAudio: HTMLAudioElement | null = null;
/** Bumps when a new speak starts or stopSpeaking() runs — stale async work exits early. */
let speakGeneration = 0;

function stopWebAudio(): void {
  if (!activeWebAudio) return;
  const audio = activeWebAudio;
  activeWebAudio = null;
  try {
    audio.pause();
    audio.src = '';
  } catch {
    /* ignore */
  }
}

function stopDeviceSpeech(): void {
  if (isWeb && typeof window !== 'undefined' && 'speechSynthesis' in window) {
    window.speechSynthesis.cancel();
    return;
  }
  Speech.stop();
}

async function stopPlayback(): Promise<void> {
  stopWebAudio();
  if (!activeSound) return;
  const sound = activeSound;
  activeSound = null;
  try {
    sound.pause();
    sound.remove();
  } catch {
    /* ignore */
  }
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function playMp3BufferWeb(buffer: ArrayBuffer, generation: number): Promise<boolean> {
  if (generation !== speakGeneration || typeof window === 'undefined') return false;

  unlockWebAudioForPlayback();
  await stopPlayback();

  const blob = new Blob([buffer], { type: 'audio/mpeg' });
  const url = URL.createObjectURL(blob);
  const audio = new globalThis.Audio(url);
  audio.preload = 'auto';
  activeWebAudio = audio;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      URL.revokeObjectURL(url);
      if (activeWebAudio === audio) activeWebAudio = null;
      resolve(ok && generation === speakGeneration);
    };

    audio.onended = () => finish(true);
    audio.onerror = () => finish(false);
    void audio.play().then(() => undefined).catch(() => finish(false));
  });
}

async function playMp3Buffer(buffer: ArrayBuffer, generation: number): Promise<boolean> {
  if (generation !== speakGeneration) return false;

  if (isWeb) return playMp3BufferWeb(buffer, generation);

  const cacheDir = FileSystem.cacheDirectory;
  if (!cacheDir) return false;

  const uri = `${cacheDir}tts-${Date.now()}.mp3`;
  await FileSystem.writeAsStringAsync(uri, arrayBufferToBase64(buffer), {
    encoding: FileSystem.EncodingType.Base64,
  });

  if (generation !== speakGeneration) return false;

  await stopPlayback();
  await ensurePlaybackThroughSpeaker();

  const sound = createAudioPlayer({ uri });
  activeSound = sound;
  sound.volume = NATIVE_TTS_VOLUME;
  sound.muted = false;

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      subscription.remove();
      if (activeSound === sound) {
        activeSound = null;
        try {
          sound.remove();
        } catch {
          /* ignore */
        }
      }
      resolve();
    };

    const timeout = setTimeout(finish, 120_000);
    const subscription = sound.addListener('playbackStatusUpdate', (status) => {
      if (settled) return;
      if (status.didJustFinish) finish();
    });
    sound.play();
  });

  return generation === speakGeneration;
}

function speakWithWebSpeech(text: string, generation: number): Promise<void> {
  return new Promise((resolve) => {
    if (generation !== speakGeneration) {
      resolve();
      return;
    }
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
      resolve();
      return;
    }

    const synth = window.speechSynthesis;
    const safari = isSafariBrowser();

    const start = () => {
      if (generation !== speakGeneration) {
        resolve();
        return;
      }

      unlockWebAudioForPlayback();

      if (!safari) synth.cancel();

      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = 'en-US';
      utterance.rate = 1.0;

      const voices = synth.getVoices();
      const voice =
        voices.find((v) => v.lang.startsWith('en-US')) ??
        voices.find((v) => v.lang.startsWith('en'));
      if (voice) utterance.voice = voice;

      let resumeTimer: ReturnType<typeof setInterval> | null = null;
      const cleanup = () => {
        if (resumeTimer) {
          clearInterval(resumeTimer);
          resumeTimer = null;
        }
      };

      utterance.onend = () => {
        cleanup();
        if (generation === speakGeneration) resolve();
      };
      utterance.onerror = () => {
        cleanup();
        resolve();
      };

      if (safari) {
        resumeTimer = setInterval(() => {
          if (generation !== speakGeneration) {
            cleanup();
            return;
          }
          synth.resume();
        }, 1000);
      }

      synth.resume();
      synth.speak(utterance);

      window.setTimeout(() => {
        if (generation !== speakGeneration) return;
        if (!synth.speaking && !synth.pending) {
          synth.resume();
          synth.speak(utterance);
        }
      }, 100);
    };

    if (synth.getVoices().length === 0) {
      const onVoices = () => {
        synth.removeEventListener('voiceschanged', onVoices);
        start();
      };
      synth.addEventListener('voiceschanged', onVoices);
      window.setTimeout(start, 50);
    } else {
      start();
    }
  });
}

function speakWithExpoSpeech(text: string, generation: number): Promise<void> {
  if (isWeb) return speakWithWebSpeech(text, generation);
  return new Promise((resolve) => {
    if (generation !== speakGeneration) {
      resolve();
      return;
    }
    Speech.speak(text, {
      language: 'en-US',
      rate: 1.0,
      pitch: 1.05,
      volume: NATIVE_TTS_VOLUME,
      onDone: () => {
        if (generation === speakGeneration) resolve();
      },
      onStopped: () => resolve(),
      onError: () => resolve(),
    });
  });
}

/** True if server MP3 or device TTS is currently playing. */
export async function isSpeaking(): Promise<boolean> {
  if (activeSound) {
    try {
      if (activeSound.playing) return true;
    } catch {
      /* ignore */
    }
  }
  if (isWeb && typeof window !== 'undefined' && 'speechSynthesis' in window) {
    return window.speechSynthesis.speaking || window.speechSynthesis.pending;
  }
  try {
    return await Speech.isSpeakingAsync();
  } catch {
    return false;
  }
}

/**
 * Speak text aloud once: server MP3 first (reliable after mic recording), then device TTS.
 * New calls cancel any in-progress speech.
 * Use preferDevice for long AI answers — starts talking immediately without waiting on /api/audio.
 */
export async function speakText(text: string, options?: { preferDevice?: boolean }): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed) return;

  const generation = ++speakGeneration;
  stopDeviceSpeech();
  await stopPlayback();
  if (generation !== speakGeneration) return;

  if (isWeb) {
    unlockWebAudioForPlayback();
  } else {
    await ensurePlaybackThroughSpeaker();
  }
  if (generation !== speakGeneration) return;

  const preferDevice =
    options?.preferDevice ?? (isNative || (isWeb && isSafariBrowser()));

  if (preferDevice) {
    await speakWithExpoSpeech(trimmed, generation);
    return;
  }

  const forAudio =
    trimmed.length > MAX_TTS_CHARS ? `${trimmed.slice(0, MAX_TTS_CHARS)}…` : trimmed;

  try {
    const mp3 = await sendAudioRequest(forAudio);
    if (generation !== speakGeneration) return;
    if (mp3 && mp3.byteLength > 0) {
      const played = await playMp3Buffer(mp3, generation);
      if (played && generation === speakGeneration) return;
    }
  } catch (e) {
    console.warn('speakText: backend audio failed, using expo-speech', e);
  }

  if (generation !== speakGeneration) return;
  await speakWithExpoSpeech(trimmed, generation);
}

export async function stopSpeaking(): Promise<void> {
  speakGeneration += 1;
  stopDeviceSpeech();
  await stopPlayback();
}
