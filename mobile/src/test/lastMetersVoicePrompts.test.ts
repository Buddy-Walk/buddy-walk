import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LAST_METERS_STATUS, getLastMetersVoicePriority, getLastMetersVoiceText,
  type LastMetersVoiceEvent,
} from '../utils/lastMetersVoicePrompts';
import { RECAPTURE_MESSAGE } from '../utils/lastMetersSafety';
import { getSafetyGateVoicePrompt } from '../utils/safetyGateVoicePrompt';

const statusCases = {
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
} satisfies Record<keyof typeof LAST_METERS_STATUS, string>;

for (const type of Object.keys(statusCases) as (keyof typeof statusCases)[]) {
  test(`preserves the existing ${type} status`, () => {
    assert.equal(getLastMetersVoiceText({ type }), statusCases[type]);
  });
}

const cases: [LastMetersVoiceEvent, string][] = [
  [{ type: 'destination_confirmed', destination: 'Joe’s Coffee, 5th Avenue' }, 'Destination set to Joe’s Coffee, 5th Avenue. Starting Last Meters.'],
  [{ type: 'photo_transcript', transcript: 'read the sign' }, 'Got read the sign. Double-tap Last Meters for entrance guidance, or Submit to ask about the photo.'],
  [{ type: 'initial_wait' }, "Checking your photo and location."],
  [{ type: 'continued_wait' }, "Analyzing your surroundings. Please wait."],
  [{ type: 'still_processing' }, "Still checking your surroundings. Tap Last Meters again to cancel."],
  [{ type: 'module_started', module: 'preCheck' }, "Checking your location and destination."],
  [{ type: 'module_started', module: 'currentViewMatch' }, "Matching your photo with nearby Street View images."],
  [{ type: 'module_started', module: 'destinationMatch' }, "Locating your destination in the surrounding area."],
  [{ type: 'module_started', module: 'turnDecision' }, "Checking the reliability of your navigation directions."],
  [{ type: 'module_started', module: 'guidance' }, "Preparing your navigation instructions."],
  [{ type: 'cancelled' }, "Last Meters cancelled."],
  [{ type: 'timeout' }, "Last Meters took too long to answer. The server may be busy. Take a new photo and try again."],
  [{ type: 'error', message: 'Network Error' }, 'Last Meters error: Network Error'],
  [{ type: 'error' }, "Error calculating last meters navigation. Please try again."],
  [{ type: 'recapture_required' }, RECAPTURE_MESSAGE],
  [{ type: 'navigation_result', output: 'The verified answer.' }, 'The verified answer.'],
  [{ type: 'safety_gate', reasons: ['future_reason'], backendOutput: 'Original response.' }, 'Original response.'],
  [{ type: 'safety_gate', reasons: ['turned_since_capture', 'moved_since_capture'], backendOutput: 'Original response.' },
    getSafetyGateVoicePrompt(['turned_since_capture', 'moved_since_capture'])!],
  [{ type: 'safety_gate', warning: 'destination_branch_ambiguous', reasons: ['gps_uncertain'], backendOutput: 'Original response.' },
    getSafetyGateVoicePrompt(['destination_branch_ambiguous'])!],
];

for (const [event, expected] of cases) {
  const detail = event.type === 'module_started' ? event.module : expected;
  test(`selects ${event.type}: ${detail}`, () => {
    assert.equal(getLastMetersVoiceText(event), expected);
  });
}

test('orders final and safety above terminal, module and waiting events', () => {
  const waiting = getLastMetersVoicePriority({ type: 'still_processing' });
  const module = getLastMetersVoicePriority({ type: 'module_started', module: 'guidance' });
  assert.ok(waiting < module);
  for (const type of ['cancelled', 'error', 'timeout'] as const) {
    const terminal = getLastMetersVoicePriority({ type });
    assert.ok(module < terminal);
    assert.ok(terminal < getLastMetersVoicePriority({ type: 'safety_gate', backendOutput: '' }));
    assert.ok(terminal < getLastMetersVoicePriority({ type: 'navigation_result', output: '' }));
    assert.ok(terminal < getLastMetersVoicePriority({ type: 'recapture_required' }));
  }
});
