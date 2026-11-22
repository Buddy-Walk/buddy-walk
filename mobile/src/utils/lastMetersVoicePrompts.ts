import type { LastMetersModule, LastMetersProgressEvent } from './lastMetersProgress';
import { RECAPTURE_MESSAGE } from './lastMetersSafety';
import { getSafetyGateVoicePrompt } from './safetyGateVoicePrompt';

/** Capture, input and reset statuses keep their existing accessibility routing. */
export const LAST_METERS_STATUS = {
  capture_success: "Photo captured. Speak or type the destination, then tap Last Meters for entrance guidance. Or Submit to ask about the photo.",
  camera_starting: "Camera is still starting. Try again in a moment.",
  camera_busy: "Camera is still getting ready. Try again in a moment.",
  capture_failed: "Could not capture image",
  video_started: "Video recording started",
  video_ended: "Video recording ended. Ready to describe the video.",
  video_mic_permission: "Microphone permission is required to record video.",
  video_camera_unready: "Camera not ready. Wait a second, then try again.",
  video_failed: "Could not capture video",

  missing_destination: "Please enter the name of the store or destination first.",
  missing_photo: "Please take a photo of your surroundings first.",

  answer_loading: "Still loading the last answer. Please wait.",
  mic_while_loading: "Still loading your last answer. Wait a moment, then try again.",
  transcription_busy: "Still transcribing your last question. Wait a moment.",
  voice_unavailable: "Voice input is unavailable. Make sure the backend is running and try again.",
  mic_permission: "Microphone permission is required for voice questions.",
  browser_mic_permission: "Could not start microphone. Check browser permissions and try again.",
  browser_mic_failed: "Could not start microphone",
  native_mic_failed: "Could not start microphone. Tap again in a moment.",
  no_speech: "I didn't hear anything. Ask again.",
  no_transcript: "I didn't catch that. Ask again.",
  speech_service_error: "Speech service error. Please try again.",
  recognition_failed: "Voice recognition failed. Tap the voice button and speak again.",
  recording_unreadable: "Could not read the recording. Please try again.",

  offline: "No internet connection.",
  new_test: "New test started.",
  new_test_accessible: "New test started. Previous question, answer, and AI memory cleared.",
} as const;

export const LAST_METERS_VOICE_PROMPTS = {
  preCheck: 'Checking your location and destination.',
  currentViewMatch: 'Matching your photo with nearby Street View images.',
  destinationMatch: 'Locating your destination in the surrounding area.',
  turnDecision: 'Checking the reliability of your navigation directions.',
  guidance: 'Preparing your navigation instructions.',
} satisfies Record<LastMetersModule, string>;

const waitingText = {
  initial_wait: "Checking your photo and location.",
  continued_wait: "Analyzing your surroundings. Please wait.",
  still_processing: "Still checking your surroundings. Tap Last Meters again to cancel.",
} as const;

const fixedText = {
  ...LAST_METERS_STATUS,
  ...waitingText,
  cancelled: "Last Meters cancelled.",
  timeout: "Last Meters took too long to answer. The server may be busy. Take a new photo and try again.",
  recapture_required: RECAPTURE_MESSAGE,
};

export type LastMetersResultVoiceEvent =
  | { type: 'navigation_result'; output: string }
  | { type: 'safety_gate'; reasons?: readonly string[]; warning?: string; backendOutput: string }
  | { type: 'recapture_required' }
  | { type: 'timeout' }
  | { type: 'error'; message?: string };

export type LastMetersProgressVoiceEvent = LastMetersProgressEvent | { type: keyof typeof waitingText };
type RequestVoiceEvent = LastMetersProgressVoiceEvent | LastMetersResultVoiceEvent | { type: 'cancelled' };

export type LastMetersVoiceEvent =
  | RequestVoiceEvent
  | { type: keyof typeof LAST_METERS_STATUS }
  | { type: 'destination_confirmed'; destination: string }
  | { type: 'photo_transcript'; transcript: string };

export function getLastMetersVoiceText(event: LastMetersVoiceEvent): string {
  switch (event.type) {
    case 'destination_confirmed':
      return `Destination set to ${event.destination}. Starting Last Meters.`;
    case 'photo_transcript':
      return `Got ${event.transcript}. Double-tap Last Meters for entrance guidance, or Submit to ask about the photo.`;
    case 'module_started':
      return LAST_METERS_VOICE_PROMPTS[event.module];
    case 'safety_gate':
      return getSafetyGateVoicePrompt(event.reasons, event.warning) ?? event.backendOutput;
    case 'navigation_result':
      return event.output;
    case 'error':
      return event.message ? `Last Meters error: ${event.message}` : "Error calculating last meters navigation. Please try again.";
    default:
      return fixedText[event.type];
  }
}

/** Priorities apply within one request. Input and reset statuses have their own lifecycle. */
export function getLastMetersVoicePriority(event: RequestVoiceEvent) {
  switch (event.type) {
    case 'navigation_result':
    case 'safety_gate':
    case 'recapture_required':
      return 4;
    case 'cancelled':
    case 'timeout':
    case 'error':
      return 3;
    case 'module_started':
      return 2;
    case 'initial_wait':
    case 'continued_wait':
    case 'still_processing':
      return 1;
  }
}
