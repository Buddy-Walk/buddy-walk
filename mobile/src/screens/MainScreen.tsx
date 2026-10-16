import React, { useRef, useState, useEffect, useCallback } from "react";
import { LastMileSensors, sensorSafetyReasons, buildSensorRecaptureMessage, validPoint } from "../utils/lastMileSafety";
import {
  View,
  ScrollView,
  StyleSheet,
  Pressable,
  TextInput,
  ActivityIndicator,
  Platform,
  AccessibilityInfo,
  Alert,
  Vibration,
  Animated,
  AppState,
} from "react-native";
import { Text, Button, IconButton } from "react-native-paper";
import { SafeAreaView } from "react-native-safe-area-context";
import { CameraView, CameraType, useCameraPermissions } from "expo-camera";
import * as Location from "expo-location";
import { Accelerometer } from "expo-sensors";
import * as Network from "expo-network";
import {
  AudioQuality,
  IOSOutputFormat,
  useAudioRecorder,
  type AudioRecorder,
  type RecorderState,
  type RecordingOptions,
} from "expo-audio";
import AsyncStorage from "@react-native-async-storage/async-storage";

import CallAccessARideButton from "../components/CallAccessARideButton";
import FeedbackModal from "../components/FeedbackModal";
import AnswerFeedback from "../components/AnswerFeedback";
import { sendTextRequest, sendLastMileRequest } from "../api/openAi";
import { fetchMtaArrivals } from "../api/mta";
import { createChatLog, addChatToChatLog } from "../api/chatLog";
import { track, Events } from "../api/telemetry";
import {
  classifyFeature,
  createRequestId,
  looksLikeBareDestination,
} from "../utils/telemetryFeature";
import {
  buildTrainQuestionWithLiveData,
  extractTrainLineFromText,
  isTrainArrivalQuestion,
} from "../utils/trainLine";
import { parseLastMetersInput } from "../utils/lastMetersInput";
import { getToken } from "../api/token";
import { warmApiBackend } from "../api/retry";
import { transcribeAudio } from "../api/transcribe";
import { useAuthSession } from "../navigation/authSession";
import {
  RequestData,
  CustomCoords,
  RootStackParamList,
  NavRoute,
} from "../types";
import { expandSavedAliases } from "../utils/savedPlaces";
import { withLastMetersImageInstruction } from "../utils/briefAiInstruction";
import { tap, tapMedium, notifySuccess } from "../utils/haptics";
import { ensureMicrophonePermission } from "../utils/microphonePermission";
import {
  prepareAudioForRecording,
  resetAudioForPlayback,
} from "../utils/audioSession";
import { stopSpeaking, isSpeaking } from "../utils/speakText";
import { announce, speakContent } from "../utils/announce";
import { cueListening, cueCaptured, cueError } from "../utils/voiceFeedback";
import { rotateConversationId } from "../utils/conversationSession";
import {
  unlockWebAudioForPlayback,
  isSafariBrowser,
} from "../utils/webAudioUnlock";
import { extractVideoFrames } from "../utils/extractVideoFrames";
import {
  startWebFrameCapture,
  WebFrameSession,
} from "../utils/webFrameCapture";
import {
  contentTypeForWebBlob,
  startWebAudioCapture,
  WebAudioSession,
} from "../utils/webAudioCapture";
import {
  startWebSpeechRecognition,
  WebSpeechSession,
} from "../utils/webSpeechRecognition";
import { NativeStackScreenProps } from "@react-navigation/native-stack";

const MIN_VIDEO_RECORD_MS = 900;
const MAX_VIDEO_DURATION_MS = 30000;
const MTA_LOOKUP_MS = 8000;
const LOCATION_WAIT_MS = 1000;
const SLOW_RESPONSE_HINT_MS = 4500;
const VIDEO_RECORDING_START_VIBRATION = [0, 120, 80, 120] as const;
const PHOTO_CAPTURED_VIBRATION = [0, 50] as const;
const NO_INTERNET_VIBRATION_PATTERN = [0, 250, 150, 250];

// Walking routes longer than this are almost always a bad geocode (e.g. a
// Brooklyn park that resolved out-of-state) and are never practical for our
// users. We refuse to surface them and suggest transit instead. Tune freely.
const MAX_WALKING_METERS = 12000; // ~7.5 miles

/**
 * Read the route's total walking distance, summing step distances when the response has no usable
 * route-level total.
 */
function routeTotalMeters(route: NavRoute | null | undefined): number {
  if (!route) return 0;
  const total = route.totalDistance?.value;
  if (typeof total === "number" && total > 0) return total;
  return (
    route.steps?.reduce(/* Accumulate each step's available walking distance without treating a missing distance as an error. */ (sum, s) => sum + (s.distance?.value ?? 0), 0) ?? 0
  );
}

/** Reject implausibly long walking routes before presenting them as practical local navigation. */
function isUnreasonableWalk(route: NavRoute | null | undefined): boolean {
  return routeTotalMeters(route) > MAX_WALKING_METERS;
}

// Accelerometer magnitude is in G (~1.0 at rest). A normal walking gait peaks
// around 1.3–2.0 G, so a deliberate-shake threshold must sit well above that.
const SHAKE_THRESHOLD = 2.6;
const SHAKE_COOLDOWN_MS = 2000;
// A real shake produces several strong spikes back-to-back; requiring a second
// spike within this window rejects one-off jolts from footfalls.
const SHAKE_WINDOW_MS = 700;
const VOICE_INPUT_HINT =
  "Shake the phone or tap this button to ask a question by voice.";

type RecordingMode = "idle" | "recording-video" | "recording-voice";
type CaptureUiState =
  | "idle"
  | "holding"
  | "recording"
  | "photo-ready"
  | "video-ready";

/** Format the elapsed video recording duration as minutes and two-digit seconds. */
function formatRecordingTime(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** Choose the camera control state from active recording and staged photo/video media. */
function getCaptureUiState(
  recordingMode: RecordingMode,
  hasPhotoCapture: boolean,
  hasVideoCapture: boolean,
): CaptureUiState {
  if (recordingMode === "recording-video") return "recording";
  if (hasVideoCapture) return "video-ready";
  if (hasPhotoCapture) return "photo-ready";
  return "idle";
}

/** Describe the current capture state in the camera section's visible and accessible status text. */
function captureStatusLabel(state: CaptureUiState): string {
  switch (state) {
    case "holding":
      return "Keep holding — video starting…";
    case "recording":
      return "Recording video — tap Stop Video";
    case "photo-ready":
      return "Photo captured — tap Retake to replace";
    case "video-ready":
      return "Video captured — tap Retake to replace";
    default:
      return "Take Photo  ·  Record Video";
  }
}

type Props = NativeStackScreenProps<RootStackParamList, "Main">;

/**
 * Coordinate camera capture, voice questions, location/heading snapshots, and Last Meters
 * requests. Refs keep asynchronous handlers current; request cancellation and sensor rechecks
 * prevent obsolete answers from becoming turn guidance.
 */
export default function MainScreen({ navigation }: Props) {
  const { signOut } = useAuthSession();
  const cameraRef = useRef<CameraView>(null);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();

  const [capturedImage, setCapturedImage] = useState<string | null>(null);
  const [capturedVideoUri, setCapturedVideoUri] = useState<string | null>(null);
  // Web only: frames sampled live from the camera preview during a "video"
  // hold, since browsers can't run expo-video-thumbnails after the fact.
  const [webVideoFrames, setWebVideoFrames] = useState<string[] | null>(null);
  const webFrameSessionRef = useRef<WebFrameSession | null>(null);
  const [userInput, setUserInput] = useState("");
  const [displayQuestion, setDisplayQuestion] = useState("");
  const [aiResponse, setAiResponse] = useState("");
  const [loading, setLoading] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [recordingMode, setRecordingMode] = useState<RecordingMode>("idle");
  const [recordingElapsedSec, setRecordingElapsedSec] = useState(0);

  const [currentChatId, setCurrentChatId] = useState("");
  const [currentMessageId, setCurrentMessageId] = useState("");
  const [feedbackVisible, setFeedbackVisible] = useState(false);

  const locationRef = useRef<Location.LocationObject | null>(null);
  const headingRef = useRef<number | null>(null);
  /** expo-location compass calibration: 3 high, 2 medium, 1 low, 0 none. */
  const headingAccuracyRef = useRef<number | null>(null);
  const capturedPhotoHeadingRef = useRef<number | null>(null); // compass timing issue
  const capturedPhotoHeadingAccuracyRef = useRef<number | null>(null);
  const lastMileAbortRef = useRef<AbortController | null>(null);
  const [lastMileLoading, setLastMileLoading] = useState(false);
  const capturedPhotoLocationRef = useRef<Location.LocationObject | null>(null);
  const headingTimestampRef = useRef<number>(0);
  const headingReferenceRef = useRef<"true" | "magnetic" | "unknown">("unknown");
  const capturedSensorMetadataRef = useRef<Pick<LastMileSensors, "photoCapturedAt" | "positionTimestamp" | "headingTimestamp" | "headingReference"> | null>(null);
  const recordingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const recDotOpacity = useRef(new Animated.Value(1)).current;
  const audioRecordingRef = useRef<AudioRecorder | null>(null);
  const voiceMeteringTimerRef = useRef<ReturnType<typeof setInterval> | null>(
    null,
  );
  const voiceRecordingStartedAtRef = useRef<number | null>(null);
  /** Auto-endpointing state: set once real speech is heard, then used to time trailing silence. */
  const speechHeardAtRef = useRef<number | null>(null);
  const lastSpeechAtRef = useRef<number | null>(null);
  const autoStopFiredRef = useRef(false);
  const voiceTranscriptRef = useRef("");
  const webAudioSessionRef = useRef<WebAudioSession | null>(null);
  const webSpeechSessionRef = useRef<WebSpeechSession | null>(null);
  const userInputRef = useRef("");
  const azureTokenRef = useRef<{ token: string; region: string } | null>(null);
  const cameraReadyRef = useRef(false);
  const videoRecordStartedRef = useRef(false);
  const videoRecordingStartedAtRef = useRef<number | null>(null);
  // Snapshot of the question actually sent, so the chat log records it even
  // after userInput is cleared on submit.
  const submittedInputRef = useRef("");
  /** Only persist chat logs after a successful backend answer (not error placeholders). */
  const chatLogEligibleRef = useRef(false);
  // Fires a spoken "still working" cue if a response is taking a while.
  const slowResponseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  const isOfflineRef = useRef(false);
  const lastShakeRef = useRef(0);
  const firstSpikeAtRef = useRef(0);
  const isListeningRef = useRef(false);
  const isTranscribingRef = useRef(false);
  const loadingRef = useRef(false);
  const recordingModeRef = useRef<RecordingMode>("idle");

  useEffect(() => {
    // Keep microphone event callbacks synchronized with whether the UI is currently listening.
    isListeningRef.current = isListening;
  }, [isListening]);
  useEffect(() => {
    // Keep asynchronous recording callbacks synchronized with transcription progress.
    isTranscribingRef.current = isTranscribing;
  }, [isTranscribing]);
  useEffect(() => {
    // Expose the latest typed or interim spoken input to callbacks outside the current React
    // render.
    userInputRef.current = userInput;
  }, [userInput]);
  useEffect(() => {
    // Expose the latest request-busy state to timers and sensor callbacks.
    loadingRef.current = loading;
  }, [loading]);
  useEffect(() => {
    // Keep the recording control's asynchronous handlers synchronized with the current video
    // mode.
    recordingModeRef.current = recordingMode;
  }, [recordingMode]);
  useEffect(() => {
    // Require a fresh camera-ready signal after staging media replaces the live preview.
    if (capturedImage || capturedVideoUri || webVideoFrames?.length) {
      cameraReadyRef.current = false;
    }
  }, [capturedImage, capturedVideoUri, webVideoFrames]);

  /** Stop the recording duration timer and reset its displayed elapsed time. */
  function clearRecordingTimer(): void {
    if (recordingTimerRef.current) {
      clearInterval(recordingTimerRef.current);
      recordingTimerRef.current = null;
    }
    setRecordingElapsedSec(0);
  }

  /**
   * Enter video-recording mode, start the elapsed-time display, and provide tactile recording
   * confirmation.
   */
  function beginRecordingFeedback(): void {
    setRecordingMode("recording-video");
    videoRecordingStartedAtRef.current = Date.now();
    clearRecordingTimer();
    recordingTimerRef.current = setInterval(() => {
      // Advance the visible video recording duration once per second.
      setRecordingElapsedSec(/* Increment recording duration from its latest state rather than a captured render value. */ (s) => s + 1);
    }, 1000);
    try {
      Vibration.vibrate([...VIDEO_RECORDING_START_VIBRATION]);
    } catch {
      // noop
    }
  }

  useEffect(() => {
    // Pulse the recording indicator only while video recording is active and release the
    // animation when that state changes.
    if (recordingMode !== "recording-video") {
      recDotOpacity.setValue(1);
      return;
    }
    const pulse = Animated.loop(
      Animated.sequence([
        Animated.timing(recDotOpacity, {
          toValue: 0.25,
          duration: 550,
          useNativeDriver: true,
        }),
        Animated.timing(recDotOpacity, {
          toValue: 1,
          duration: 550,
          useNativeDriver: true,
        }),
      ]),
    );
    pulse.start();
    return /* Stop the recording indicator animation when recording ends or the effect is replaced. */ () => pulse.stop();
  }, [recordingMode, recDotOpacity]);

  useEffect(() => {
    // Install cleanup for the recording duration timer.
    return () => {
      // Release the duration timer if the main screen unmounts during recording.
      clearRecordingTimer();
    };
  }, []);
  // ─── Setup: location, compass, Azure token ───────────────────────────────

  useEffect(() => {
    // Request camera/microphone access and establish playback audio mode as the capture screen
    // opens.
    void ensureMicrophonePermission();
    void requestCameraPermission();
    void resetAudioForPlayback();
    return () => {
      // Stop and discard any browser frame sampling owned by this screen on unmount.
      webFrameSessionRef.current?.stop();
      webFrameSessionRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // Acquire location permission, seed the first location fix, and install live GPS/compass
    // watchers with matching teardown.
    let locationSub: Location.LocationSubscription | null = null;
    let headingSub: Location.LocationSubscription | null = null;

    (async () => {
      // Initialize authorized position and heading streams without blocking the first request on
      // a watcher's delayed first event.
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status === "granted") {
        // Seed an immediate fix so the very first question already carries
        // coordinates — the watcher's first callback can lag by seconds,
        // especially in browsers.
        try {
          const first = await Location.getCurrentPositionAsync({
            accuracy: Location.Accuracy.Balanced,
          });
          if (!locationRef.current) locationRef.current = first;
        } catch {
          // Watcher below may still succeed.
        }
        locationSub = await Location.watchPositionAsync(
          {
            accuracy: Location.Accuracy.BestForNavigation,
            // Last Meters needs fresh fixes even while the user stands still.
            distanceInterval: 0,
            timeInterval: 1000,
          },
          /**
           * Keep the latest location fix available for questions, sharing, and capture-time sensor
           * snapshots.
           */
          (loc) => {
            locationRef.current = loc;
          },
        );
        if (Platform.OS !== "web") {
          try {
            headingSub = await Location.watchHeadingAsync((heading) => {
              // Record heading time/reference/calibration and clear unusable compass readings
              // rather than relabeling an old heading as current.
              headingTimestampRef.current = Date.now();
              headingReferenceRef.current = heading.trueHeading >= 0 ? "true" : "magnetic";
              headingAccuracyRef.current = heading.accuracy;
              // Keeping the last good value would send a stale heading from
              // before the user turned, so an uncalibrated compass reads as none.
              if (heading.accuracy < 2) {
                headingRef.current = null;
                return;
              }
              const degrees =
                heading.trueHeading >= 0
                  ? heading.trueHeading
                  : heading.magHeading;
              if (Number.isFinite(degrees)) {
                headingRef.current = (degrees + 360) % 360;
              }
            });
          } catch (e) {
            console.warn("Compass heading unavailable:", e);
          }
        }
      }
    })();

    // Low-accuracy readings stay unset; panorama evidence cannot replace them.
    return () => {
      // Remove both sensor subscriptions when the main screen unmounts.
      locationSub?.remove();
      headingSub?.remove();
    };
  }, []);

  // ─── Azure STT token (refreshed before its ~10 min expiry) ───────────────

  const refreshAzureToken = useCallback(async () => {
    // Refresh the cached Azure speech token, allowing the voice UI to fall back gracefully when
    // speech setup is unavailable.
    try {
      const tok = await getToken();
      if (tok) azureTokenRef.current = tok;
      return tok ?? null;
    } catch {
      // Azure STT unavailable — voice input falls back to manual text entry.
      return null;
    }
  }, []);

  useEffect(() => {
    // Warm the API and refresh speech credentials on startup, then renew the token before its
    // normal expiration.
    void warmApiBackend();
    void refreshAzureToken();
    const id = setInterval(
      /** Renew speech credentials during a long-lived main-screen session. */
      () => {
        void refreshAzureToken();
      },
      8 * 60 * 1000,
    );
    return /* Stop periodic speech-token renewal when the screen unmounts. */ () => clearInterval(id);
  }, [refreshAzureToken]);

  // ─── Network connectivity listener (expo-network) ──────────────────────

  useEffect(() => {
    // Subscribe to network changes so the UI can announce a transition offline without requiring
    // a failed request first.
    try {
      const sub = Network.addNetworkStateListener((state) => {
        // Announce and vibrate once on loss of connectivity, resetting the latch when
        // connectivity returns.
        const connected = state.isConnected && state.isInternetReachable;
        if (!connected && !isOfflineRef.current) {
          isOfflineRef.current = true;
          Vibration.vibrate(NO_INTERNET_VIBRATION_PATTERN);
          announce("No internet connection.");
        } else if (connected && isOfflineRef.current) {
          isOfflineRef.current = false;
        }
      });
      return /* Release the network-state listener when this effect is disposed. */ () => sub.remove();
    } catch (e) {
      // Listener unsupported on this platform (e.g. some browsers) — the app
      // still surfaces failures per-request, so silently skip live monitoring.
      console.warn("Network state listener unavailable:", e);
      return undefined;
    }
  }, []);

  useEffect(() => {
    // Install cleanup for browser speech/audio capture sessions owned by the main screen.
    return () => {
      // Abort both browser voice capture mechanisms and discard their session references on
      // unmount.
      webAudioSessionRef.current?.abort();
      webAudioSessionRef.current = null;
      webSpeechSessionRef.current?.abort();
      webSpeechSessionRef.current = null;
    };
  }, []);

  // ─── Shake-to-repeat voice input ─────────────────────────────────────────

  useEffect(() => {
    // Motion sensors are heavily restricted in browsers (iOS Safari requires a
    // user-gesture permission prompt); shake gestures are native-only.
    if (Platform.OS === "web") return;
    Accelerometer.setUpdateInterval(150);
    const sub = Accelerometer.addListener(({ x, y, z }) => {
      // Recognize a deliberate two-spike shake with a cooldown before starting another voice
      // interaction.
      const magnitude = Math.sqrt(x * x + y * y + z * z);
      const now = Date.now();

      // Always respect the post-trigger cooldown.
      if (now - lastShakeRef.current <= SHAKE_COOLDOWN_MS) return;

      if (magnitude <= SHAKE_THRESHOLD) return;

      // First strong spike arms the detector; a second spike within the window
      // confirms an intentional shake (vs. a single footfall jolt).
      if (now - firstSpikeAtRef.current <= SHAKE_WINDOW_MS) {
        lastShakeRef.current = now;
        firstSpikeAtRef.current = 0;

        if (
          isListeningRef.current ||
          isTranscribingRef.current ||
          loadingRef.current ||
          recordingModeRef.current !== "idle" ||
          !azureTokenRef.current
        ) {
          return;
        }
        startListening();
      } else {
        firstSpikeAtRef.current = now;
      }
    });
    return /* Release the shake-detection accelerometer subscription. */ () => sub.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── TTS ─────────────────────────────────────────────────────────────────

  // Routes through one channel: the OS screen reader when active, otherwise the
  // app's own TTS. Prevents the double narration of speaking + announcing.
  const speak = useCallback(
    /** Route short UI status messages through the shared accessibility announcement policy. */
    (text: string, options?: { preferDevice?: boolean }) => {
      announce(text, options);
    },
    [],
  );

  /** Answers go through app TTS so pause/replay actually control them. */
  const speakAnswer = useCallback((text: string) => {
    // Speak answer content through the replayable device-speech path rather than a transient
    // status announcement.
    speakContent(text, { preferDevice: true });
  }, []);

  const toggleResponseSpeech = useCallback(async () => {
    // Stop an answer that is already speaking, or replay the displayed answer when speech is
    // idle.
    if (!aiResponse.trim()) return;
    try {
      if (await isSpeaking()) {
        await stopSpeaking();
      } else {
        speakAnswer(aiResponse);
      }
    } catch {
      speakAnswer(aiResponse);
    }
  }, [aiResponse, speakAnswer]);

  const notifyNoSpeechHeard = useCallback(() => {
    // Give tactile and spoken feedback when microphone input did not contain a usable question.
    void cueError();
    speak("I didn't catch that. Ask again.");
  }, [speak]);

  const speakListeningPrompt = useCallback(async () => {
    // A haptic marks "mic is open" instantly and, unlike a spoken prompt, is
    // inaudible to the microphone — so recording can begin right away instead
    // of stalling several seconds waiting for speech to finish.
    await cueListening();
  }, []);

  const notifyNoInternetConnection = useCallback(() => {
    // The response text is set to "No internet connection." and the auto-speak
    // effect narrates it, so here we only add the haptic cue (no double speak).
    Vibration.vibrate(NO_INTERNET_VIBRATION_PATTERN);
  }, []);

  const lastAutoSpokenRef = useRef("");
  /**
   * The transcript of a voice question awaiting its answer. Spoken as a short
   * preamble on the answer so the user hears what was understood without a
   * separate confirm-and-submit step.
   */
  const voicePreambleRef = useRef("");

  // ─── Auto-speak AI response once, then log ───────────────────────────────

  useEffect(() => {
    // Speak each newly displayed answer once and persist eligible conversation entries without
    // making chat storage a requirement for answering.
    if (!aiResponse) {
      lastAutoSpokenRef.current = "";
      return;
    }
    if (lastAutoSpokenRef.current !== aiResponse) {
      lastAutoSpokenRef.current = aiResponse;
      const preamble = voicePreambleRef.current;
      voicePreambleRef.current = "";
      speakAnswer(preamble ? `For ${preamble}. ${aiResponse}` : aiResponse);
    }

    const loc = locationRef.current;
    const logEntry = {
      input: submittedInputRef.current,
      output: aiResponse,
      imageURL: capturedImage ?? "",
      location: {
        lat: loc?.coords.latitude ?? 0,
        lon: loc?.coords.longitude ?? 0,
      },
    };

    if (!chatLogEligibleRef.current) return;

    (async () => {
      // Create or extend the saved conversation and keep the latest persisted message ID
      // available for feedback.
      try {
        const storedName = await AsyncStorage.getItem("name");
        if (currentChatId === "") {
          const res = await createChatLog({
            messages: [logEntry],
            ...(storedName ? { user: storedName } : {}),
          });
          if (res?.data?._id) {
            setCurrentChatId(res.data._id);
            const msgs = res.data.messages;
            setCurrentMessageId(msgs[msgs.length - 1]._id);
          }
        } else {
          const res = await addChatToChatLog({
            id: currentChatId,
            chat: logEntry,
          });
          if (res?.data?.messages) {
            const msgs = res.data.messages;
            setCurrentMessageId(msgs[msgs.length - 1]._id);
          }
        }
      } catch (e) {
        console.error("Chat log error:", e);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aiResponse]);

  // ─── Camera: tap = photo, hold = video ───────────────────────────────────

  const onCameraReady = useCallback(() => {
    // Mark the mounted camera preview ready for capture operations.
    cameraReadyRef.current = true;
  }, []);

  /** expo-camera requires onCameraReady before takePicture/recordAsync. */
  async function waitForCameraReady(timeoutMs = 2500): Promise<boolean> {
    if (cameraReadyRef.current) return true;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise(/* Yield briefly between camera readiness checks instead of blocking the UI thread. */ (r) => setTimeout(r, 80));
      if (cameraReadyRef.current) return true;
    }
    return false;
  }

  /** Toggle between starting and stopping video recording using the latest recording-mode ref. */
  async function toggleVideoCapture() {
    if (recordingModeRef.current === "recording-video") {
      await stopVideoRecording();
    } else {
      await startVideoRecording();
    }
  }

  /**
   * Normalizes expo-camera output across platforms: native returns raw base64,
   * web returns a full data URL (sometimes in `uri` instead of `base64`).
   * Double-prefixing produces an invalid image the AI backend rejects.
   */
  function photoToDataUrl(
    photo: { base64?: string; uri?: string } | null | undefined,
  ): string | null {
    if (!photo) return null;
    if (photo.base64) {
      return photo.base64.startsWith("data:")
        ? photo.base64
        : `data:image/jpeg;base64,${photo.base64}`;
    }
    if (photo.uri && photo.uri.startsWith("data:")) return photo.uri;
    return null;
  }

  /**
   * Snapshot the original GPS/compass evidence before requesting a photo, then stage the captured
   * image with that metadata for a later Last Meters request.
   */
  async function takePhoto() {
    if (!cameraRef.current) return;
    const ready = await waitForCameraReady();
    if (!ready) {
      speak("Camera is still starting. Try again in a moment.");
      return;
    }
    try {
      cancelLastMileRequest();
      // remove the compass & location belonging to the previous photo
      capturedPhotoHeadingRef.current = null;
      capturedPhotoHeadingAccuracyRef.current = null;
      capturedPhotoLocationRef.current = null;
      capturedSensorMetadataRef.current = null;

      // capture the correct compass heading for the photo
      const headingAtCapture = headingRef.current;
      const headingAccuracyAtCapture = headingAccuracyRef.current;

      // capture the current location / GPS
      const locationAtCapture = locationRef.current;
      const sensorMetadataAtCapture = {
        photoCapturedAt: Date.now(), positionTimestamp: locationAtCapture?.timestamp ?? 0,
        headingTimestamp: headingTimestampRef.current, headingReference: headingReferenceRef.current,
      };

      const photo = await cameraRef.current.takePictureAsync({
        base64: true,
        quality: 0.4,
        skipProcessing: false,
        exif: false,
      });
      const dataUrl = photoToDataUrl(photo);
      if (dataUrl) {
        setCapturedVideoUri(null);
        setWebVideoFrames(null);
        setCapturedImage(dataUrl);
        capturedPhotoHeadingRef.current = headingAtCapture;
        capturedPhotoHeadingAccuracyRef.current = headingAccuracyAtCapture;
        capturedPhotoLocationRef.current = locationAtCapture;
        capturedSensorMetadataRef.current = sensorMetadataAtCapture;
        // disabled for testing
        // setUserInput("Describe the image");
        speak(
          "Photo captured. Speak or type the destination, then tap Last Meters for entrance guidance. Or Submit to ask about the photo.",
        );
        notifySuccess();
        try {
          Vibration.vibrate([...PHOTO_CAPTURED_VIBRATION]);
        } catch {
          // noop
        }
        void track(Events.PhotoCaptured);
      } else {
        speak("Could not capture image");
      }
    } catch (e) {
      console.error("takePhoto error:", e);
      speak("Could not capture image");
    }
  }

  /**
   * Start native video recording or browser frame sampling, refuse overlapping recordings, and
   * provide recording-state feedback.
   */
  async function startVideoRecording() {
    if (!cameraRef.current || videoRecordStartedRef.current) return;

    // Web: no MediaRecorder/thumbnail pipeline — sample frames off the live
    // preview while the user holds, auto-stopping at the max duration.
    if (Platform.OS === "web") {
      const session = startWebFrameCapture();
      if (!session) {
        speak("Camera is still starting. Try again in a moment.");
        return;
      }
      webFrameSessionRef.current = session;
      videoRecordStartedRef.current = true;
      beginRecordingFeedback();
      AccessibilityInfo.announceForAccessibility("Video recording started");
      setTimeout(() => {
        // Stop the same browser recording session when its maximum permitted duration is
        // reached.
        if (webFrameSessionRef.current === session) void stopVideoRecording();
      }, MAX_VIDEO_DURATION_MS);
      return;
    }

    const micOk = await ensureMicrophonePermission();
    if (!micOk) {
      speak("Microphone permission is required to record video.");
      return;
    }
    const ready = await waitForCameraReady();
    if (!ready) {
      speak("Camera is still starting. Try again in a moment.");
      return;
    }
    try {
      videoRecordStartedRef.current = true;
      beginRecordingFeedback();
      await prepareAudioForRecording();
      AccessibilityInfo.announceForAccessibility("Video recording started");
      // recordAsync resolves when stopRecording is called or maxDuration is reached
      const video = await cameraRef.current.recordAsync({
        maxDuration: MAX_VIDEO_DURATION_MS / 1000,
      });
      if (video?.uri) {
        setCapturedImage(null);
        setCapturedVideoUri(video.uri);
        speak("Video recording ended. Ready to describe the video.");
        setUserInput("Describe the video");
        notifySuccess();
        void track(Events.VideoRecorded, { platform: Platform.OS });
      }
    } catch (e) {
      console.error("startVideoRecording error:", e);
      const msg = e instanceof Error ? e.message : "";
      if (/not ready/i.test(msg)) {
        speak("Camera not ready. Wait a second, then try again.");
      } else {
        speak("Could not capture video");
      }
    } finally {
      videoRecordStartedRef.current = false;
      setRecordingMode("idle");
      clearRecordingTimer();
    }
  }

  /** Clear video-recording state and timers, then restore the audio session for answer playback. */
  function finishVideoRecording(): void {
    videoRecordStartedRef.current = false;
    videoRecordingStartedAtRef.current = null;
    setRecordingMode("idle");
    clearRecordingTimer();
    void resetAudioForPlayback();
  }

  /**
   * Finish the current recording, respecting the minimum native clip duration, and stage usable
   * video/frame data for a subsequent question.
   */
  async function stopVideoRecording() {
    if (Platform.OS === "web") {
      const session = webFrameSessionRef.current;
      if (!session) return;
      webFrameSessionRef.current = null;
      const frames = session.stop();
      finishVideoRecording();
      if (frames.length > 0) {
        setCapturedImage(null);
        setCapturedVideoUri(null);
        setWebVideoFrames(frames);
        setUserInput("Describe the video");
        speak("Video recording ended. Ready to describe the video.");
        notifySuccess();
        void track(Events.VideoRecorded, {
          platform: "web",
          frameCount: frames.length,
        });
      } else {
        setWebVideoFrames(null);
        speak("Could not capture video");
      }
      return;
    }

    const startedAt = videoRecordingStartedAtRef.current;
    if (startedAt != null) {
      const elapsed = Date.now() - startedAt;
      if (elapsed < MIN_VIDEO_RECORD_MS) {
        await new Promise(/* Allow a very short native recording to reach the minimum usable clip duration before stopping it. */ (r) => setTimeout(r, MIN_VIDEO_RECORD_MS - elapsed));
      }
    }
    cameraRef.current?.stopRecording();
  }

  // ─── Voice input via Azure Speech-to-Text REST ───────────────────────────
  //
  // iOS:     Records LinearPCM (true WAV) at 16kHz mono — exactly what Azure expects.
  // Android: Records AAC-ADTS at 16kHz mono — Azure accepts audio/aac natively.
  // Content-Type is set per platform to match the actual encoded format.

  const AZURE_RECORDING_OPTIONS: RecordingOptions = {
    extension: ".wav",
    sampleRate: 16000,
    numberOfChannels: 1,
    bitRate: 256000,
    isMeteringEnabled: true,
    android: {
      extension: ".aac",
      outputFormat: "aac_adts",
      audioEncoder: "aac",
      sampleRate: 16000,
    },
    ios: {
      extension: ".wav",
      outputFormat: IOSOutputFormat.LINEARPCM,
      audioQuality: AudioQuality.HIGH,
      sampleRate: 16000,
      bitDepthHint: 16,
      linearPCMBitDepth: 16,
      linearPCMIsBigEndian: false,
      linearPCMIsFloat: false,
    },
    web: {},
  };
  const audioRecorder = useAudioRecorder(AZURE_RECORDING_OPTIONS);
  useEffect(/* Install cleanup for the microphone level polling timer. */ () => /* Stop microphone level polling when the main screen unmounts. */ () => stopVoiceMeteringPoll(), []);

  /** Release the microphone metering interval without changing the actual recorder state. */
  function stopVoiceMeteringPoll(): void {
    if (voiceMeteringTimerRef.current) {
      clearInterval(voiceMeteringTimerRef.current);
      voiceMeteringTimerRef.current = null;
    }
  }

  /** Stops the native recorder; returns the file URI of the finished recording. */
  async function stopNativeRecording(): Promise<string | null> {
    stopVoiceMeteringPoll();
    const recorder = audioRecordingRef.current;
    audioRecordingRef.current = null;
    if (!recorder) return null;
    await recorder.stop();
    return recorder.uri;
  }

  const AZURE_CONTENT_TYPE =
    Platform.OS === "ios"
      ? "audio/wav; codecs=audio/pcm; samplerate=16000"
      : "audio/aac";

  const MIN_VOICE_RECORDING_MS = 1200;

  // Auto-endpointing. Metering is reported in dBFS (roughly -160 silent to 0
  // loud); anything above the floor counts as speech. We only arm the silence
  // timer once the user has actually said something, so someone who takes a
  // moment to gather their thought is never cut off before they begin. The
  // trailing window is deliberately generous — being cut off mid-sentence is
  // far more costly than waiting an extra beat.
  const VOICE_METERING_INTERVAL_MS = 100;
  const VOICE_SILENCE_FLOOR_DB = -42;
  const VOICE_TRAILING_SILENCE_MS = 1600;
  const VOICE_MAX_RECORDING_MS = 30000;
  const LISTENING_PLACEHOLDER = "🎙 Listening… speak your question";
  const TRANSCRIBING_PLACEHOLDER = "⏳ Transcribing your question…";

  /** Exclude UI-only listening/transcribing placeholder text from submitted questions. */
  function isVoiceStatusText(text: string): boolean {
    const t = text.trim();
    return t === LISTENING_PLACEHOLDER || t === TRANSCRIBING_PLACEHOLDER;
  }

  /** Clear the on-screen Q&A/capture state and start a fresh server AI session. */
  const resetConversationState = useCallback(
    /**
     * Start a clean conversation context by cancelling pending navigation, stopping speech, and
     * clearing staged media, answers, and saved-message references.
     */
    (options?: { announceReset?: boolean }) => {
      rotateConversationId();
      void stopSpeaking();
      cancelLastMileRequest();
      if (slowResponseTimerRef.current) {
        clearTimeout(slowResponseTimerRef.current);
        slowResponseTimerRef.current = null;
      }
      setLoading(false);
      setUserInput("");
      setDisplayQuestion("");
      submittedInputRef.current = "";
      setAiResponse("");
      setCapturedImage(null);
      capturedPhotoHeadingRef.current = null;
      capturedPhotoHeadingAccuracyRef.current = null;
      setCapturedVideoUri(null);
      setWebVideoFrames(null);
      setCurrentChatId("");
      setCurrentMessageId("");
      chatLogEligibleRef.current = false;
      lastAutoSpokenRef.current = "";
      cameraReadyRef.current = false;
      if (options?.announceReset) {
        AccessibilityInfo.announceForAccessibility(
          "New test started. Previous question, answer, and AI memory cleared.",
        );
        announce("New test started.");
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  /**
   * End active voice capture before starting a new field-test conversation and recording its
   * telemetry event.
   */
  async function startNewTest(): Promise<void> {
    await cleanupVoiceCapture();
    resetConversationState({ announceReset: true });
    void track(Events.NewTestStarted);
  }

  // Force a clean AI session when the app is backgrounded/closed so a new
  // launch never inherits the previous session's chat history.
  useEffect(() => {
    // Subscribe to app background transitions so a later interaction receives a fresh
    // conversation context.
    const sub = AppState.addEventListener("change", (state) => {
      // Rotate the conversation ID when the app leaves the foreground to avoid reusing an old
      // person's question context.
      if (state === "background" || state === "inactive") {
        rotateConversationId();
      }
    });
    return /* Remove the conversation-reset app-state subscription. */ () => sub.remove();
  }, []);

  /**
   * Abort browser capture, stop any native recording, clear transcript state, and restore playback
   * audio mode.
   */
  async function cleanupVoiceCapture(): Promise<void> {
    webAudioSessionRef.current?.abort();
    webAudioSessionRef.current = null;
    webSpeechSessionRef.current?.abort();
    webSpeechSessionRef.current = null;
    voiceTranscriptRef.current = "";

    try {
      await stopNativeRecording();
    } catch {
      /* recording may already be stopped */
    }
    voiceRecordingStartedAtRef.current = null;
    await resetAudioForPlayback();
  }

  /**
   * Reset listening/transcription state and release capture resources after a failed or cancelled
   * voice interaction.
   */
  async function resetVoiceUiState(): Promise<void> {
    setIsListening(false);
    setIsTranscribing(false);
    isListeningRef.current = false;
    isTranscribingRef.current = false;
    await cleanupVoiceCapture();
  }

  /**
   * Route recognized speech according to the staged media and destination intent, avoiding an
   * ordinary auto-submit that would consume a Last Meters photo.
   */
  async function submitVoiceQuestion(transcript: string): Promise<void> {
    const trimmed = transcript.trim();
    if (!trimmed) {
      notifyNoSpeechHeard();
      return;
    }
    if (loadingRef.current) {
      speak("Still loading the last answer. Please wait.");
      return;
    }
    setUserInput(trimmed);

    // With a photo attached, auto-Submit races Last Meters: it clears the photo
    // and blocks the button while loading. Destination-like speech goes straight
    // to Last Meters; other speech stays in the field so the user can choose.
    if (capturedImage) {
      voicePreambleRef.current = "";
      const wantsLastMeters =
        looksLikeBareDestination(trimmed) ||
        classifyFeature({ text: trimmed, hasImage: true }) === "directions";
      if (wantsLastMeters) {
        speak(`Destination set to ${trimmed}. Starting Last Meters.`, {
          preferDevice: true,
        });
        await handleLastMileNavigation(trimmed);
        return;
      }
      speak(
        `Got ${trimmed}. Double-tap Last Meters for entrance guidance, or Submit to ask about the photo.`,
        { preferDevice: true },
      );
      notifySuccess();
      return;
    }

    // No photo: send immediately. What was understood is spoken as a preamble
    // on the answer so they still get confirmation without hunting Submit.
    voicePreambleRef.current = trimmed;
    await handleSubmit(trimmed);
  }

  /**
   * Stop the active microphone interaction or start a new one according to the latest listening
   * state.
   */
  async function toggleListening() {
    if (isListeningRef.current) {
      await stopListening();
      return;
    }
    await startListening();
  }

  /**
   * VoiceOver's two-finger double-tap. Works anywhere on screen without moving
   * focus, so a user who missed part of an answer can replay it without hunting
   * for a control. Falls back to starting a new question when there is nothing
   * to replay.
   */
  function handleMagicTap(): void {
    void (async () => {
      // Handle the screen reader's magic tap by ending listening, stopping current speech,
      // replaying the answer, or starting voice input in that order.
      if (isListeningRef.current) {
        await stopListening();
        return;
      }
      try {
        if (await isSpeaking()) {
          await stopSpeaking();
          return;
        }
      } catch {
        /* fall through to replay */
      }
      if (aiResponse.trim()) {
        speakAnswer(aiResponse);
        return;
      }
      await startListening();
    })();
  }

  /**
   * Translate Azure recognition results into usable text, an empty silence result, or null for a
   * service failure.
   */
  async function transcribeWithAzure(
    audioBody: Blob | ArrayBuffer,
    contentType: string,
  ): Promise<string | null> {
    const result = await transcribeAudio(audioBody, contentType);
    if (!result) return null;
    if (result.status === "Success") return result.transcript;
    if (
      result.status === "NoMatch" ||
      result.status === "InitialSilenceTimeout" ||
      result.status === "EmptyAudio"
    ) {
      return "";
    }
    console.error("Azure STT unhandled status:", result.status);
    return null;
  }

  /**
   * Ends the recording once the user stops talking, so asking a question costs
   * one action instead of two. Re-locating the mic button to stop was the most
   * awkward step in the flow for a screen-reader user.
   */
  function handleVoiceMetering(status: RecorderState): void {
    if (autoStopFiredRef.current || !isListeningRef.current) return;
    if (!status.isRecording) return;

    const now = Date.now();
    const startedAt = voiceRecordingStartedAtRef.current;

    // Hard cap so a mic that never hears silence cannot record indefinitely.
    if (startedAt != null && now - startedAt >= VOICE_MAX_RECORDING_MS) {
      autoStopFiredRef.current = true;
      void stopListening();
      return;
    }

    const level = status.metering;
    if (typeof level !== "number") return;

    if (level > VOICE_SILENCE_FLOOR_DB) {
      if (speechHeardAtRef.current == null) speechHeardAtRef.current = now;
      lastSpeechAtRef.current = now;
      return;
    }

    // Silence only counts once they have actually started speaking; otherwise a
    // pause to collect a thought would end the recording before it began.
    const lastSpeech = lastSpeechAtRef.current;
    if (speechHeardAtRef.current == null || lastSpeech == null) return;
    if (now - lastSpeech < VOICE_TRAILING_SILENCE_MS) return;
    if (startedAt != null && now - startedAt < MIN_VOICE_RECORDING_MS) return;

    autoStopFiredRef.current = true;
    void stopListening();
  }

  /**
   * Prepare microphone permissions, speech credentials, and the recording audio session before
   * starting native or browser speech capture.
   */
  async function startListening() {
    if (Platform.OS === "web") unlockWebAudioForPlayback();

    if (loadingRef.current) {
      speak("Still loading your last answer. Wait a moment, then try again.");
      return;
    }
    if (isTranscribingRef.current) {
      speak("Still transcribing your last question. Wait a moment.");
      return;
    }
    if (isListeningRef.current) return;

    await stopSpeaking();
    await cleanupVoiceCapture();

    if (!azureTokenRef.current) {
      await refreshAzureToken();
    }
    if (!azureTokenRef.current) {
      speak(
        "Voice input is unavailable. Make sure the backend is running and try again.",
      );
      if (Platform.OS !== "web") {
        Alert.alert(
          "Voice Input Unavailable",
          "Could not connect to the speech service. Make sure the backend is running and try again.",
        );
      }
      return;
    }
    const micOk = await ensureMicrophonePermission();
    if (!micOk) {
      speak("Microphone permission is required for voice questions.");
      return;
    }

    await speakListeningPrompt();

    if (Platform.OS === "web") {
      try {
        const session = await startWebAudioCapture();
        if (!session) {
          speak(
            "Could not start microphone. Check browser permissions and try again.",
          );
          return;
        }
        webAudioSessionRef.current = session;

        const auth = azureTokenRef.current;
        if (auth) {
          const speech = startWebSpeechRecognition(
            auth,
            /**
             * Show interim recognized speech while retaining it as the latest transcript
             * candidate.
             */
            (interim) => {
              voiceTranscriptRef.current = interim;
              setUserInput(interim);
            },
            /** Store the final live-recognition result in both the input field and transcript ref. */
            (final) => {
              voiceTranscriptRef.current = final;
              setUserInput(final);
            },
            /**
             * Record browser live-recognition diagnostic messages without replacing the user's
             * input.
             */
            (message) => console.warn("live speech:", message),
          );
          if (speech) {
            webSpeechSessionRef.current = speech;
          }
        }

        voiceRecordingStartedAtRef.current = Date.now();
        isListeningRef.current = true;
        setIsListening(true);
        setUserInput(LISTENING_PLACEHOLDER);
        void track(Events.VoiceStarted);
      } catch (e) {
        console.error("startListening web error:", e);
        await resetVoiceUiState();
        speak("Could not start microphone");
      }
      return;
    }

    try {
      await prepareAudioForRecording();
      speechHeardAtRef.current = null;
      lastSpeechAtRef.current = null;
      autoStopFiredRef.current = false;
      await audioRecorder.prepareToRecordAsync();
      audioRecorder.record();
      audioRecordingRef.current = audioRecorder;
      stopVoiceMeteringPoll();
      voiceMeteringTimerRef.current = setInterval(() => {
        // Poll native recording levels to detect real speech followed by trailing silence.
        handleVoiceMetering(audioRecorder.getStatus());
      }, VOICE_METERING_INTERVAL_MS);
      voiceRecordingStartedAtRef.current = Date.now();
      isListeningRef.current = true;
      setIsListening(true);
      setUserInput(LISTENING_PLACEHOLDER);
      void track(Events.VoiceStarted);
    } catch (e) {
      console.error("startListening error:", e);
      await resetVoiceUiState();
      await resetAudioForPlayback();
      speak("Could not start microphone. Tap again in a moment.");
    }
  }

  /**
   * End recording, reject clips that are too short, transcribe captured audio, and pass usable
   * speech into the normal voice-question routing path.
   */
  async function stopListening() {
    if (Platform.OS === "web") unlockWebAudioForPlayback();

    if (Platform.OS === "web") {
      const session = webAudioSessionRef.current;
      const speech = webSpeechSessionRef.current;
      webAudioSessionRef.current = null;
      webSpeechSessionRef.current = null;
      isListeningRef.current = false;
      setIsListening(false);

      const startedAt = voiceRecordingStartedAtRef.current;
      voiceRecordingStartedAtRef.current = null;
      if (
        startedAt != null &&
        Date.now() - startedAt < MIN_VOICE_RECORDING_MS
      ) {
        speech?.abort();
        if (session) await session.stop();
        setUserInput("");
        setIsTranscribing(false);
        isTranscribingRef.current = false;
        void cueError();
        speak("I didn't hear anything. Ask again.");
        return;
      }

      isTranscribingRef.current = true;
      setIsTranscribing(true);
      setUserInput(TRANSCRIBING_PLACEHOLDER);
      void track(Events.VoiceStopped);

      try {
        const [liveText, blob] = await Promise.all([
          speech ? speech.stop() : Promise.resolve(""),
          session ? session.stop() : Promise.resolve(null),
        ]);

        // Safari needs the mic fully released before speechSynthesis can run.
        if (isSafariBrowser()) {
          await new Promise(/* Allow Safari's microphone release to settle before trying to play synthesized feedback. */ (resolve) => setTimeout(resolve, 50));
          unlockWebAudioForPlayback();
        }
        void cueCaptured();

        let text =
          liveText.trim() ||
          voiceTranscriptRef.current.trim() ||
          userInputRef.current.trim();

        if (isVoiceStatusText(text)) text = "";

        if (!text && blob && blob.size > 0) {
          const transcript = await transcribeWithAzure(
            blob,
            contentTypeForWebBlob(blob),
          );
          if (transcript === null) {
            speak("Speech service error. Please try again.");
            return;
          }
          text = transcript.trim();
        }

        voiceTranscriptRef.current = "";
        if (text && !isVoiceStatusText(text)) {
          setUserInput(text);
          setIsTranscribing(false);
          isTranscribingRef.current = false;
          await submitVoiceQuestion(text);
        } else {
          notifyNoSpeechHeard();
        }
      } catch (e) {
        console.error("stopListening web error:", e);
        speak(
          "Voice recognition failed. Tap the voice button and speak again.",
        );
      } finally {
        setIsTranscribing(false);
        isTranscribingRef.current = false;
      }
      return;
    }

    if (!audioRecordingRef.current) {
      await resetVoiceUiState();
      return;
    }
    try {
      isListeningRef.current = false;
      setIsListening(false);
      const startedAt = voiceRecordingStartedAtRef.current;
      voiceRecordingStartedAtRef.current = null;
      if (
        startedAt != null &&
        Date.now() - startedAt < MIN_VOICE_RECORDING_MS
      ) {
        await stopNativeRecording();
        await resetAudioForPlayback();
        setIsTranscribing(false);
        isTranscribingRef.current = false;
        setUserInput("");
        void cueError();
        speak("I didn't hear anything. Ask again.");
        return;
      }
      setIsTranscribing(true);
      isTranscribingRef.current = true;
      setUserInput(TRANSCRIBING_PLACEHOLDER);
      void track(Events.VoiceStopped);
      const uri = await stopNativeRecording();
      await new Promise(/* Allow native recorder teardown to settle before restoring speech playback. */ (resolve) => setTimeout(resolve, 150));
      await resetAudioForPlayback();
      void cueCaptured();

      if (!uri || !azureTokenRef.current) {
        setIsTranscribing(false);
        if (!uri) speak("Could not read the recording. Please try again.");
        return;
      }

      const audioData = await fetch(uri);
      const audioBlob = await audioData.arrayBuffer();
      const transcript = await transcribeWithAzure(
        audioBlob,
        AZURE_CONTENT_TYPE,
      );

      if (transcript === null) {
        speak("Speech service error. Please try again.");
        return;
      }
      const cleaned = transcript.trim();
      if (cleaned && !isVoiceStatusText(cleaned)) {
        setUserInput(cleaned);
        setIsTranscribing(false);
        isTranscribingRef.current = false;
        await submitVoiceQuestion(cleaned);
      } else {
        notifyNoSpeechHeard();
      }
    } catch (e) {
      console.error("stopListening error:", e);
      speak("Voice recognition failed. Tap the voice button and speak again.");
    } finally {
      setIsTranscribing(false);
      isTranscribingRef.current = false;
    }
  }

  // ─── Last Meters Navigation Feature ──────────────────────────────────────────

  /** Aborts a pending Last Meters request; returns whether one was pending. */
  function cancelLastMileRequest(): boolean {
    const controller = lastMileAbortRef.current;
    if (!controller) return false;
    lastMileAbortRef.current = null;
    controller.abort();
    return true;
  }

  /**
   * Submit a staged photo and its original sensor evidence to Last Meters, or cancel the active
   * request on a second tap. Keep request generations separate and recheck live sensors before
   * speaking a turn.
   */
  async function handleLastMileNavigation(destinationOverride?: string) {
    if (cancelLastMileRequest()) {
      speak("Last Meters cancelled.", { preferDevice: true });
      return;
    }
    if (loading) return;

    const rawDestination = (destinationOverride ?? userInput).trim();
    if (!rawDestination) {
      speak("Please enter the name of the store or destination first.", {
        preferDevice: true,
      });
      return;
    }
    // "When is the 2 train" or "What is in front of me?" would otherwise be
    // searched as a place name and fail with "could not verify a nearby...".
    const parsedInput = parseLastMetersInput(rawDestination);
    if (parsedInput.kind === "question") {
      await handleSubmit(rawDestination);
      return;
    }
    if (!capturedImage) {
      speak("Please take a photo of your surroundings first.", {
        preferDevice: true,
      });
      return;
    }
    setUserInput(rawDestination);

    const controller = new AbortController();
    lastMileAbortRef.current = controller;
    setLoading(true);
    setLastMileLoading(true);
    void stopSpeaking();
    AccessibilityInfo.announceForAccessibility(
      "Checking your distance and surroundings. This may take a moment.",
    );
    if (slowResponseTimerRef.current)
      clearTimeout(slowResponseTimerRef.current);
    slowResponseTimerRef.current = setTimeout(() => {
      // Announce a slow Last Meters request only if it is still the active, uncancelled request.
      if (lastMileAbortRef.current === controller)
        speak(
          "Still checking your surroundings. Tap Last Meters again to cancel.",
          { preferDevice: true },
        );
    }, SLOW_RESPONSE_HINT_MS * 2);

    try {
      const loc = capturedPhotoLocationRef.current;
      const metadata = capturedSensorMetadataRef.current;
      /**
       * Combine the original capture timestamps with the latest observed location and heading,
       * preserving missing/invalid readings instead of inventing evidence.
       */
      const makeSensors = (): LastMileSensors | undefined => {
        const latest = locationRef.current;
        if (!metadata || !latest) return undefined;
        return { ...metadata, latestPosition: { lat: latest.coords.latitude, lng: latest.coords.longitude,
          accuracy: latest.coords.accuracy ?? -1, timestamp: latest.timestamp },
          latestHeading: headingRef.current ?? -1, latestHeadingTimestamp: headingTimestampRef.current,
          latestHeadingReference: headingReferenceRef.current };
      };
      const position = { lat: loc?.coords.latitude ?? NaN, lng: loc?.coords.longitude ?? NaN };
      const captureHeading = capturedPhotoHeadingRef.current ?? undefined;
      const sensors = makeSensors();
      if (!loc || !validPoint(position)) {
        const message = buildSensorRecaptureMessage(["current_gps_unavailable"]);
        setAiResponse(message);
        speak(message, { preferDevice: true });
        return;
      }

      // Send the actual capture metadata even if a sensor is stale or missing.
      // The API records the reason, withholds the turn, and saves review imagery.
      const data = await sendLastMileRequest(
        {
          lat: loc.coords.latitude,
          lng: loc.coords.longitude,
          gpsAccuracyMeters: loc.coords.accuracy ?? undefined,
          heading: capturedPhotoHeadingRef.current ?? undefined, // fixes compass timing issue
          compassAccuracyLevel:
            capturedPhotoHeadingAccuracyRef.current ?? undefined,
          image: capturedImage,
          destination: parsedInput.destination,
          sensors,
        },
        controller.signal,
      );

      if (controller.signal.aborted || lastMileAbortRef.current !== controller) return;
      const liveSensorReasons = sensorSafetyReasons(makeSensors(), position, captureHeading, loc.coords.accuracy ?? undefined);
      if (data.guidanceKind !== "withheld" && liveSensorReasons.length) {
        const message = buildSensorRecaptureMessage(liveSensorReasons);
        setAiResponse(message);
        speak(message, { preferDevice: true });
        return;
      }
      if (data.output) {
        setAiResponse(data.output);
        speak(data.output, { preferDevice: true });

        setUserInput("");
        setCapturedImage(null);
        cameraReadyRef.current = false;
        void track(Events.AnswerReceived, {
          feature: "last_mile",
          navigationMode: data.mode || "unknown",
        });
      }
    } catch (e) {
      if (controller.signal.aborted) return;
      console.error("Last Meters Error:", e);
      const isTimeout = (e as { code?: string })?.code === "ECONNABORTED";
      const detail = e instanceof Error ? e.message : "";
      const errMsg = isTimeout
        ? "Last Meters took too long to answer. The server may be busy. Take a new photo and try again."
        : detail
          ? `Last Meters error: ${detail}`
          : "Error calculating last meters navigation. Please try again.";
      setAiResponse(errMsg);
      speak(errMsg, { preferDevice: true });
    } finally {
      // A cancelled request settles after the user may have started a new one;
      // only the latest request may clear the loading state.
      if (
        lastMileAbortRef.current === controller ||
        lastMileAbortRef.current === null
      ) {
        lastMileAbortRef.current = null;
        if (slowResponseTimerRef.current) {
          clearTimeout(slowResponseTimerRef.current);
          slowResponseTimerRef.current = null;
        }
        setLoading(false);
        setLastMileLoading(false);
      }
    }
  }

  // ─── Submit to backend ────────────────────────────────────────────────────

  /**
   * Prepare a typed or media question with saved-place context and bounded location/transit
   * lookups, then own its API response, cancellation, timers, and busy-state cleanup.
   */
  async function handleSubmit(questionOverride?: string) {
    const raw = (questionOverride ?? userInput).trim();
    if (!raw || isVoiceStatusText(raw)) {
      speak("Please enter a question first");
      return;
    }
    const question = raw;
    setUserInput(question);
    setDisplayQuestion(question);
    submittedInputRef.current = question;
    chatLogEligibleRef.current = false;
    const requestStartedAt = Date.now();
    const requestId = createRequestId();
    const hasWebVideo = !!(webVideoFrames && webVideoFrames.length > 0);
    const hasVideo = !!capturedVideoUri || hasWebVideo;
    const feature = classifyFeature({
      text: question,
      hasImage: !!capturedImage,
      hasVideo,
    });
    void track(Events.QuestionAsked, {
      requestId,
      feature,
      // Prompt text is captured here because Q&A now goes directly to the AI
      // host for speed — the usage dashboard reads it from telemetry instead.
      text: question.slice(0, 500),
      length: question.length,
      hasImage: !!capturedImage,
      hasVideo,
      hasWebVideo,
    });
    try {
      setLoading(true);
      void stopSpeaking();
      AccessibilityInfo.announceForAccessibility("Loading response");

      // A blind user otherwise has no feedback during a long wait, so reassure
      // them out loud if the backend is taking its time. The eventual answer
      // (or error) cancels this by starting its own speech.
      if (slowResponseTimerRef.current)
        clearTimeout(slowResponseTimerRef.current);
      slowResponseTimerRef.current = setTimeout(() => {
        // Announce a slow question request only while the request is still pending.
        if (loadingRef.current)
          speak("Still working on your answer.", { preferDevice: true });
      }, SLOW_RESPONSE_HINT_MS);

      let loc = locationRef.current;
      if (!loc) {
        try {
          loc = await Promise.race([
            Location.getCurrentPositionAsync({
              accuracy: Location.Accuracy.Balanced,
            }),
            new Promise<never>(/* Bound the time spent waiting for an initial location fix before sending an otherwise answerable question. */ (_, reject) =>
              setTimeout(
                /** Reject the location wait when its short request-preparation deadline expires. */
                () => reject(new Error("location_timeout")),
                LOCATION_WAIT_MS,
              ),
            ),
          ]);
          locationRef.current = loc;
        } catch {
          loc = null;
        }
      }
      if (!loc) {
        speak(
          "I could not determine your location, so answers about nearby places may be wrong. " +
            "Please check that location access is allowed.",
        );
      } else if ((loc.coords.accuracy ?? 0) > 1000) {
        // City-scale/IP estimates are unsafe for local destination selection.
        speak(
          "Your location is not accurate enough for nearby directions. " +
            "Please enable precise location and try again.",
        );
      }
      const hasReliableLocation =
        !!loc &&
        ((loc.coords.accuracy ?? 0) === 0 ||
          (loc.coords.accuracy ?? 0) <= 1000);
      const coords: CustomCoords | null = hasReliableLocation
        ? {
            latitude: loc!.coords.latitude,
            longitude: loc!.coords.longitude,
            accuracy: loc!.coords.accuracy ?? 0,
            altitude: loc!.coords.altitude,
            altitudeAccuracy: loc!.coords.altitudeAccuracy,
            heading: headingRef.current,
            speed: loc!.coords.speed,
            orientation: null,
          }
        : null;

      // Resolve any saved-place aliases like "home" or "work" before sending.
      const { text: resolvedText, matched } =
        await expandSavedAliases(question);
      if (matched.length > 0) {
        const aliasNames = matched.map(/* Include the matched saved-place alias names in request context and telemetry. */ (m) => m.alias).join(", ");
        AccessibilityInfo.announceForAccessibility(
          `Using saved place: ${aliasNames}`,
        );
        void track(Events.SavedPlaceUsed, {
          count: matched.length,
          aliases: aliasNames.slice(0, 120),
        });
      }

      let imagePayload: string | null | (string | null)[] = capturedImage
        ? [capturedImage]
        : [null];
      if (webVideoFrames && webVideoFrames.length > 0) {
        // Web "video": frames were already sampled live during the hold.
        imagePayload = webVideoFrames;
      } else if (capturedVideoUri) {
        AccessibilityInfo.announceForAccessibility("Processing video frames");
        const frames = await extractVideoFrames(capturedVideoUri);
        if (frames.length === 0) {
          speak("Could not read the video. Try recording again.");
          void track(Events.AnswerRejected, {
            reason: "video_frames_failed",
            feature: "video_qa",
          });
          return;
        }
        imagePayload = frames;
      }

      let textToSend = resolvedText;
      let mtaDirectAnswer: string | null = null;
      const trainLine =
        coords && isTrainArrivalQuestion(resolvedText)
          ? extractTrainLineFromText(resolvedText)
          : null;
      const isMtaOnlyQuestion =
        !!trainLine &&
        !capturedImage &&
        !capturedVideoUri &&
        !(webVideoFrames && webVideoFrames.length > 0);

      if (trainLine && coords) {
        try {
          const arrivals = await Promise.race([
            fetchMtaArrivals(trainLine, coords.latitude, coords.longitude),
            new Promise<string>(/* Bound the live transit lookup so unavailable MTA data does not stall the whole question indefinitely. */ (_, reject) =>
              setTimeout(/* Reject the transit wait when its request-specific deadline expires. */ () => reject(new Error("mta_timeout")), MTA_LOOKUP_MS),
            ),
          ]);
          mtaDirectAnswer = arrivals;
          textToSend = buildTrainQuestionWithLiveData(
            resolvedText,
            trainLine,
            arrivals,
          );
        } catch (e) {
          console.warn("MTA prefetch failed", e);
          if (isMtaOnlyQuestion) {
            const message =
              "Could not load live subway arrival times. Check your internet connection and try again.";
            setAiResponse(message);
            lastAutoSpokenRef.current = message;
            speak(message, { preferDevice: true });
            setUserInput("");
            setCapturedImage(null);
            setCapturedVideoUri(null);
            setWebVideoFrames(null);
            void track(Events.AnswerFailed, {
              requestId,
              feature: "mta",
              latencyMs: Date.now() - requestStartedAt,
              reason: "mta_fetch_failed",
            });
            return;
          }
        }
      }

      if (mtaDirectAnswer && isMtaOnlyQuestion) {
        chatLogEligibleRef.current = true;
        setAiResponse(mtaDirectAnswer);
        lastAutoSpokenRef.current = mtaDirectAnswer;
        speak(mtaDirectAnswer, { preferDevice: true });
        setUserInput("");
        setCapturedImage(null);
        setCapturedVideoUri(null);
        setWebVideoFrames(null);
        void track(Events.AnswerReceived, {
          requestId,
          feature: "mta",
          latencyMs: Date.now() - requestStartedAt,
          hasRoute: false,
          routeSource: "none",
          outputLength: mtaDirectAnswer.length,
        });
        return;
      }

      // Last Meters: a directions question with camera imagery must make the AI
      // use the image to find the door, not just recite GPS steps. Applied
      // client-side so it works no matter which host answers the question.
      const hasAttachedImagery = Array.isArray(imagePayload)
        ? imagePayload.some(Boolean)
        : !!imagePayload;
      if (feature === "directions" && hasAttachedImagery) {
        textToSend = withLastMetersImageInstruction(textToSend);
      }

      const data: RequestData = {
        text: textToSend,
        image: imagePayload,
        coords,
        analytics: { requestId, feature },
      };

      const res = await sendTextRequest(data);
      if (res?.output) {
        const structured =
          res.route && res.route.steps && res.route.steps.length > 0
            ? res.route
            : null;

        if (structured && isUnreasonableWalk(structured)) {
          const miles = (routeTotalMeters(structured) * 0.00062137).toFixed(1);
          const dest =
            structured.destination?.name ||
            structured.destination?.address ||
            "That destination";
          const message =
            `${dest} is about ${miles} miles away, which is too far to walk. ` +
            `It may not be the nearby place you meant — try a closer destination or use public transit.`;
          chatLogEligibleRef.current = true;
          setAiResponse(message);
          setUserInput("");
          setCapturedImage(null);
          setCapturedVideoUri(null);
          setWebVideoFrames(null);
          void track(Events.AnswerRejected, {
            reason: "unreasonable_walk",
            feature: "directions",
            requestId,
          });
          return;
        }

        chatLogEligibleRef.current = true;
        setAiResponse(res.output);
        setUserInput("");
        setCapturedImage(null);
        setCapturedVideoUri(null);
        setWebVideoFrames(null);
        void track(Events.AnswerReceived, {
          requestId,
          feature,
          latencyMs: Date.now() - requestStartedAt,
          hasRoute: !!structured,
          routeSource: structured ? "structured" : "none",
          output: res.output.slice(0, 500),
          outputLength: res.output.length,
        });
      }
    } catch (e) {
      console.error("handleSubmit error:", e);
      const maybeAxiosError = e as {
        code?: string;
        message?: string;
        response?: unknown;
      };
      const isTimeout = maybeAxiosError?.code === "ECONNABORTED";
      const isOffline =
        !isTimeout &&
        (!maybeAxiosError?.response ||
          maybeAxiosError?.message === "Network Error");

      if (isTimeout) {
        setAiResponse(
          "That took too long to answer. The server may be busy. Please try again.",
        );
      } else if (isOffline) {
        notifyNoInternetConnection();
        setAiResponse(
          "Could not reach the Buddy Walk server. It may be waking up — wait a few seconds and try again.",
        );
      } else {
        setAiResponse("An error occurred. Please try again.");
      }
      void track(Events.AnswerFailed, {
        requestId,
        feature,
        latencyMs: Date.now() - requestStartedAt,
        reason: isTimeout ? "timeout" : isOffline ? "offline" : "error",
      });
    } finally {
      if (slowResponseTimerRef.current) {
        clearTimeout(slowResponseTimerRef.current);
        slowResponseTimerRef.current = null;
      }
      setLoading(false);
      // Do not stopSpeaking() here — it was cutting off the AI answer right after Submit.
    }
  }

  // ─── Sign out ─────────────────────────────────────────────────────────────

  /** Ask for explicit confirmation before clearing the active conversation and signing out. */
  function handleSignOutPress() {
    Alert.alert(
      "Sign out?",
      "Are you sure you want to sign out of Buddy Walk?",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Sign Out",
          style: "destructive",
          /** Clear AI conversation context and sign out only after the user confirms the action. */
          onPress: async () => {
            try {
              // Force a clean AI session so the next user never inherits this chat history.
              resetConversationState();
              await signOut();
            } catch (e) {
              console.error("Sign out error:", e);
              Alert.alert("Could not sign out", "Please try again.");
            }
          },
        },
      ],
    );
  }

  // ─── Render ───────────────────────────────────────────────────────────────

  const cameraReady = cameraPermission?.granted;
  const hasPhotoCapture = Boolean(capturedImage);
  const hasVideoCapture = Boolean(capturedVideoUri || webVideoFrames?.length);
  const hasCapture = hasPhotoCapture || hasVideoCapture;
  const captureUiState = getCaptureUiState(
    recordingMode,
    hasPhotoCapture,
    hasVideoCapture,
  );
  const captureLabel = captureStatusLabel(captureUiState);
  const isRecordingVideo = captureUiState === "recording";

  const cameraPreview = (
    <View
      style={[
        styles.cameraPreviewWrapper,
        captureUiState === "holding" && styles.cameraPreviewHolding,
        captureUiState === "recording" && styles.cameraPreviewRecording,
      ]}
    >
      <CameraView
        ref={cameraRef}
        style={styles.cameraPreview}
        facing={"back" as CameraType}
        mode="video"
        onCameraReady={onCameraReady}
      />
      {captureUiState === "holding" ? (
        <View style={styles.captureOverlayHolding} pointerEvents="none">
          <Text style={styles.captureOverlayTitle}>KEEP HOLDING</Text>
          <Text style={styles.captureOverlaySub}>Video starts in a moment</Text>
        </View>
      ) : null}
      {captureUiState === "recording" ? (
        <View style={styles.captureOverlayRecording} pointerEvents="none">
          <View style={styles.recBadge}>
            <Animated.View
              style={[styles.recDot, { opacity: recDotOpacity }]}
            />
            <Text style={styles.recBadgeText}>
              REC {formatRecordingTime(recordingElapsedSec)}
            </Text>
          </View>
          <Text style={styles.recHint}>Tap Stop Video below</Text>
        </View>
      ) : null}
    </View>
  );

  return (
    <SafeAreaView
      style={styles.container}
      edges={["top", "bottom"]}
      onMagicTap={handleMagicTap}
    >
      <ScrollView
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled"
      >
        {/* ── Blue Section: Camera ── */}
        <View style={styles.blueSection}>
          <Text style={styles.captureStatusLabel} accessibilityRole="header">
            {captureLabel}
          </Text>

          {!hasCapture && cameraReady ? (
            <View style={styles.cameraCaptureBlock}>
              {cameraPreview}
              <View style={styles.captureActionRow}>
                <Button
                  mode="contained"
                  onPressIn={/* Provide tactile feedback on the photo-capture control. */ () => tap()}
                  onPress={/* Capture and stage a photo from the camera button. */ () => void takePhoto()}
                  disabled={isRecordingVideo}
                  style={[
                    styles.captureActionButton,
                    styles.capturePhotoButton,
                  ]}
                  contentStyle={styles.captureActionContent}
                  labelStyle={styles.captureActionLabel}
                  accessibilityLabel="Take photo"
                  accessibilityHint="Captures a still photo from the camera"
                >
                  Take Photo
                </Button>
                <Button
                  mode="contained"
                  onPressIn={/* Provide a stronger tactile cue for the video-recording control. */ () => tapMedium()}
                  onPress={/* Start or stop video capture from its accessible button. */ () => void toggleVideoCapture()}
                  style={[
                    styles.captureActionButton,
                    isRecordingVideo
                      ? styles.captureStopButton
                      : styles.captureVideoButton,
                  ]}
                  contentStyle={styles.captureActionContent}
                  labelStyle={
                    isRecordingVideo
                      ? styles.captureActionLabelOnDark
                      : styles.captureActionLabel
                  }
                  accessibilityLabel={
                    isRecordingVideo ? "Stop video recording" : "Record video"
                  }
                  accessibilityHint={
                    isRecordingVideo
                      ? "Stops the current video recording"
                      : "Starts recording video from the camera"
                  }
                  accessibilityState={{ busy: isRecordingVideo }}
                >
                  {isRecordingVideo ? "Stop Video" : "Record Video"}
                </Button>
              </View>
            </View>
          ) : hasCapture ? (
            <Button
              mode="contained"
              onPressIn={/* Provide tactile feedback before replacing a staged capture. */ () => tap()}
              onPress={() => {
                // Cancel pending Last Meters work and clear staged media so the live camera can
                // be used for a replacement capture.
                cancelLastMileRequest();
                cameraReadyRef.current = false;
                setCapturedImage(null);
                setCapturedVideoUri(null);
                setWebVideoFrames(null);
                setAiResponse("");
              }}
              style={[
                styles.retakeButton,
                hasVideoCapture
                  ? styles.retakeButtonVideo
                  : styles.retakeButtonPhoto,
              ]}
              contentStyle={styles.retakeButtonContent}
              labelStyle={styles.retakeLabel}
              accessibilityLabel={
                hasVideoCapture
                  ? "Retake video. Replace the captured video."
                  : "Retake photo. Replace the captured photo."
              }
            >
              {hasVideoCapture ? "Retake Video" : "Retake Photo"}
            </Button>
          ) : (
            <Button
              mode="contained"
              onPressIn={/* Confirm interaction with the question input through a tactile cue. */ () => tap()}
              onPress={requestCameraPermission}
              style={styles.retakeButton}
              labelStyle={styles.retakeLabel}
            >
              Enable Camera
            </Button>
          )}
        </View>

        {/* ── Gray Section: Input ── */}
        <View style={styles.graySection}>
          <Text style={styles.sectionLabel}>Ask By Voice Or Text</Text>

          <TextInput
            value={userInput}
            onChangeText={setUserInput}
            placeholder={
              isListening
                ? "Speak now — your words appear here…"
                : isTranscribing
                  ? "Transcribing your question…"
                  : "Example: What is in front of me?"
            }
            placeholderTextColor="rgba(255,255,255,0.75)"
            style={styles.textInput}
            multiline
            returnKeyType="done"
            editable={!isListening && !loading}
            accessibilityLabel="Question input field"
            accessibilityHint="Type or speak your question"
          />

          <Pressable
            onPressIn={() => {
              // Confirm the voice control touch and unlock browser audio where required by
              // user-gesture playback rules.
              tap();
              if (Platform.OS === "web") unlockWebAudioForPlayback();
            }}
            onPress={/* Start or finish the microphone interaction from the voice control. */ () => void toggleListening()}
            disabled={loading && !isListening}
            style={[
              styles.voiceButton,
              isListening && styles.voiceButtonActive,
              isTranscribing && styles.voiceButtonTranscribing,
            ]}
            accessibilityLabel={
              isTranscribing
                ? "Transcribing your question"
                : isListening
                  ? "Stop listening and transcribe your question"
                  : "Tap to speak your question"
            }
            accessibilityHint={VOICE_INPUT_HINT}
            accessibilityRole="button"
          >
            <Text
              style={[
                styles.voiceButtonLabel,
                (isListening || isTranscribing) &&
                  styles.voiceButtonLabelOnDark,
              ]}
            >
              {isTranscribing
                ? "⏳ Transcribing…"
                : isListening
                  ? "🎙 Listening — tap when finished"
                  : "🎙 Tap to Ask"}
            </Text>
          </Pressable>
        </View>

        {/* ── Green Section: Submit + Response ── */}
        <View style={styles.greenSection}>
          <Pressable
            onPressIn={/* Confirm the normal question submission touch with a stronger tactile cue. */ () => tapMedium()}
            onPress={/* Submit the current typed or staged-media question. */ () => void handleSubmit()}
            style={/* Display the normal submission control's pressed appearance. */ ({ pressed }) => [
              styles.submitButton,
              pressed && styles.submitButtonPressed,
            ]}
            accessibilityLabel="Submit question"
            accessibilityRole="button"
            disabled={loading}
          >
            <Text style={styles.submitLabel}>Submit</Text>
          </Pressable>

          <Pressable
            onPressIn={/* Confirm the Last Meters control touch with a stronger tactile cue. */ () => tapMedium()}
            onPress={/* Start or cancel Last Meters using the staged photo and current destination input. */ () => void handleLastMileNavigation()}
            style={/* Display the Last Meters control's pressed appearance while retaining its distinguishing color. */ ({ pressed }) => [
              styles.submitButton,
              pressed && styles.submitButtonPressed,
              { backgroundColor: "#00FFCC", marginTop: 4 },
            ]}
            accessibilityLabel={
              lastMileLoading
                ? "Cancel last meters navigation"
                : "Calculate precise last meters navigation"
            }
            accessibilityRole="button"
            accessibilityState={{ busy: lastMileLoading }}
            disabled={loading && !lastMileLoading}
          >
            <Text style={styles.submitLabel}>
              {lastMileLoading ? "Cancel Last Meters" : "Last Meters"}
            </Text>
          </Pressable>

          {loading && (
            <View style={styles.loadingContainer}>
              <ActivityIndicator size="large" color="#f8f8ff" />
              <Text style={styles.loadingText}>Loading response...</Text>
              {displayQuestion ? (
                <Text style={styles.pendingQuestion} accessibilityRole="text">
                  Your question: {displayQuestion}
                </Text>
              ) : null}
            </View>
          )}

          {!loading && aiResponse !== "" && (
            <View style={styles.responseContainer}>
              {displayQuestion ? (
                <Text style={styles.questionEcho} accessibilityRole="text">
                  You asked: {displayQuestion}
                </Text>
              ) : null}
              <View style={styles.responseActions}>
                <Pressable
                  onPressIn={/* Provide tactile feedback for an answer-playback control. */ () => tap()}
                  onPress={toggleResponseSpeech}
                  style={styles.actionButton}
                  accessibilityLabel="Play or pause text to speech"
                  accessibilityRole="button"
                >
                  <Text style={styles.actionButtonLabel}>🔊 Play / Pause</Text>
                </Pressable>
              </View>

              {/* No accessibilityLabel: an explicit label overrides the text
                  content and VoiceOver then reads the whole answer as one
                  indivisible string. Leaving it as plain text lets the rotor
                  move through it by line or word. */}
              <Text style={styles.responseText} accessibilityRole="text">
                {aiResponse}
              </Text>

              <AnswerFeedback
                answer={aiResponse}
                question={submittedInputRef.current}
              />
            </View>
          )}
        </View>

        {/* ── Companion + Saved Places ── */}
        <View style={styles.toolsSection}>
          <Pressable
            onPressIn={/* Provide tactile feedback for the new-test control. */ () => tap()}
            onPress={/* Clear the active interaction and begin a new field-test conversation. */ () => void startNewTest()}
            style={/* Display the new-test tool button's pressed appearance. */ ({ pressed }) => [
              styles.toolButton,
              pressed && styles.toolButtonPressed,
            ]}
            accessibilityRole="button"
            accessibilityLabel="Start a new test. Clears the question, answer, photo or video, and AI chat memory."
          >
            <Text style={styles.toolButtonIcon}>🔄</Text>
            <View style={styles.toolButtonText}>
              <Text style={styles.toolButtonTitle}>New Test</Text>
              <Text style={styles.toolButtonSubtitle}>
                Clear screen and AI memory before the next test run
              </Text>
            </View>
          </Pressable>

          <Pressable
            onPressIn={/* Provide tactile feedback for the companion-sharing shortcut. */ () => tap()}
            onPress={() => {
              // Stop spoken content before opening location-sharing controls.
              void stopSpeaking();
              navigation.navigate("Companion");
            }}
            style={/* Display the companion-sharing shortcut's pressed appearance. */ ({ pressed }) => [
              styles.toolButton,
              pressed && styles.toolButtonPressed,
            ]}
            accessibilityRole="button"
            accessibilityLabel="Open Companion Mode to share live location with a trusted contact"
          >
            <Text style={styles.toolButtonIcon}>📍</Text>
            <View style={styles.toolButtonText}>
              <Text style={styles.toolButtonTitle}>Companion Mode</Text>
              <Text style={styles.toolButtonSubtitle}>
                Share live location via web link
              </Text>
            </View>
          </Pressable>

          <Pressable
            onPressIn={/* Provide tactile feedback for the saved-destinations shortcut. */ () => tap()}
            onPress={() => {
              // Stop spoken content before opening saved-place management.
              void stopSpeaking();
              navigation.navigate("SavedPlaces");
            }}
            style={/* Display the saved-destinations shortcut's pressed appearance. */ ({ pressed }) => [
              styles.toolButton,
              pressed && styles.toolButtonPressed,
            ]}
            accessibilityRole="button"
            accessibilityLabel="Open Saved Places to bookmark home, work, and other addresses"
          >
            <Text style={styles.toolButtonIcon}>⭐</Text>
            <View style={styles.toolButtonText}>
              <Text style={styles.toolButtonTitle}>Saved Places</Text>
              <Text style={styles.toolButtonSubtitle}>
                Save home, work, and ask "How do I get home?"
              </Text>
            </View>
          </Pressable>

          <Pressable
            onPressIn={/* Provide tactile feedback before opening general feedback. */ () => tap()}
            onPress={() => {
              // Stop spoken content and show the feedback modal.
              void stopSpeaking();
              setFeedbackVisible(true);
            }}
            style={/* Display the feedback shortcut's pressed appearance. */ ({ pressed }) => [
              styles.toolButton,
              pressed && styles.toolButtonPressed,
            ]}
            accessibilityRole="button"
            accessibilityLabel="Send feedback about Buddy Walk"
          >
            <Text style={styles.toolButtonIcon}>💬</Text>
            <View style={styles.toolButtonText}>
              <Text style={styles.toolButtonTitle}>Send Feedback</Text>
              <Text style={styles.toolButtonSubtitle}>
                Rate the app and tell us what to improve
              </Text>
            </View>
          </Pressable>

          <Pressable
            onPressIn={/* Provide tactile feedback before the sign-out confirmation. */ () => tap()}
            onPress={handleSignOutPress}
            style={/* Display the sign-out control's pressed appearance. */ ({ pressed }) => [
              styles.signOutButton,
              pressed && styles.signOutButtonPressed,
            ]}
            accessibilityRole="button"
            accessibilityLabel="Sign out of Buddy Walk"
          >
            <Text style={styles.signOutLabel}>Sign Out</Text>
          </Pressable>
        </View>
      </ScrollView>
      <CallAccessARideButton />
      <FeedbackModal
        visible={feedbackVisible}
        onDismiss={/* Dismiss the feedback modal without changing the current question or answer. */ () => setFeedbackVisible(false)}
        screen="Main"
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#000",
  },
  scroll: {
    flexGrow: 1,
  },

  // ─── Blue Section ───
  blueSection: {
    backgroundColor: "#000",
    padding: 20,
    alignItems: "center",
    gap: 16,
    minHeight: 320,
  },
  sectionLabel: {
    color: "#fff",
    fontSize: 20,
    fontWeight: "bold",
    textAlign: "center",
    letterSpacing: 0.5,
  },
  cameraButton: {
    width: "100%",
    borderRadius: 20,
    overflow: "hidden",
    backgroundColor: "#111",
    alignItems: "stretch",
    borderWidth: 3,
    borderColor: "transparent",
    position: "relative",
  },
  cameraTouchOverlay: {
    ...StyleSheet.absoluteFill,
    zIndex: 2,
  },
  cameraLabelBar: {
    width: "100%",
    backgroundColor: "#fff",
    zIndex: 3,
  },
  cameraCaptureBlock: {
    width: "100%",
    gap: 12,
  },
  captureActionRow: {
    // flexDirection: "row",
    // gap: 10,
    flexDirection: "column",
    gap: 16,
    width: "100%",
  },
  captureActionButton: {
    // flex: 1,
    // borderRadius: 14,
    width: "100%",
    borderRadius: 20,
  },
  captureActionContent: {
    minHeight: 70,
    justifyContent: "center",
    paddingTop: 4,
  },
  capturePhotoButton: {
    backgroundColor: "#fff",
  },
  captureVideoButton: {
    backgroundColor: "#fff",
  },
  captureStopButton: {
    backgroundColor: "#000",
    borderWidth: 2,
    borderColor: "#fff",
  },
  stopVideoButton: {
    marginTop: 12,
    borderRadius: 14,
    backgroundColor: "#000",
    borderWidth: 2,
    borderColor: "#fff",
  },
  captureActionLabel: {
    fontSize: 24,
    lineHeight: 30,
    fontWeight: "bold",
    letterSpacing: 2,
    color: "#000",
  },
  captureActionLabelOnDark: {
    fontSize: 24,
    lineHeight: 30,
    fontWeight: "bold",
    letterSpacing: 2,
    color: "#fff",
  },
  cameraButtonHolding: {
    borderColor: "#fff",
    backgroundColor: "#e8e8e8",
  },
  cameraButtonRecording: {
    borderColor: "#fff",
    backgroundColor: "#000",
  },
  cameraButtonPressed: {
    opacity: 0.85,
    transform: [{ scale: 0.98 }],
  },
  cameraPreviewWrapper: {
    width: "100%",
    height: 260,
    minHeight: 260,
    backgroundColor: "#1a1a1a",
    position: "relative",
    overflow: "hidden",
    borderRadius: 16,
  },
  cameraPreviewHolding: {
    borderBottomWidth: 4,
    borderBottomColor: "#fff",
  },
  cameraPreviewRecording: {
    borderBottomWidth: 4,
    borderBottomColor: "#888",
  },
  cameraPreview: {
    width: "100%",
    height: "100%",
  },
  captureOverlayHolding: {
    ...StyleSheet.absoluteFill,
    backgroundColor: "rgba(0, 0, 0, 0.45)",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  captureOverlayRecording: {
    ...StyleSheet.absoluteFill,
    backgroundColor: "rgba(0, 0, 0, 0.55)",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
  },
  captureOverlayTitle: {
    color: "#fff",
    fontSize: 26,
    fontWeight: "900",
    letterSpacing: 1.5,
    textAlign: "center",
    textShadowColor: "rgba(0,0,0,0.8)",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },
  captureOverlaySub: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "700",
    textAlign: "center",
    textShadowColor: "rgba(0,0,0,0.8)",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },
  captureStatusLabel: {
    fontSize: 24,
    lineHeight: 32,
    fontWeight: "bold",
    textAlign: "center",
    marginBottom: 14,
  },
  recBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: "rgba(0,0,0,0.85)",
    borderRadius: 999,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderWidth: 2,
    borderColor: "#fff",
  },
  recDot: {
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: "#fff",
  },
  recBadgeText: {
    color: "#fff",
    fontSize: 22,
    fontWeight: "900",
    letterSpacing: 1,
    fontVariant: ["tabular-nums"],
  },
  recHint: {
    color: "#fff",
    fontSize: 15,
    fontWeight: "700",
    textShadowColor: "rgba(0,0,0,0.85)",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },
  cameraButtonLabel: {
    color: "#000",
    fontSize: 16,
    fontWeight: "bold",
    letterSpacing: 0.8,
    paddingVertical: 14,
    textAlign: "center",
  },
  cameraButtonLabelHolding: {
    color: "#000",
  },
  cameraButtonLabelRecording: {
    color: "#000",
  },
  retakeButton: {
    width: "100%",
    borderRadius: 20,
    backgroundColor: "#fff",
    borderWidth: 3,
    borderColor: "#000",
  },
  retakeButtonContent: {
    minHeight: 70,
    justifyContent: "center",
    paddingVertical: 6,
  },
  retakeButtonPhoto: {
    borderColor: "#000",
  },
  retakeButtonVideo: {
    borderColor: "#000",
  },
  retakeLabel: {
    color: "#000",
    fontSize: 24,
    lineHeight: 32,
    fontWeight: "bold",
    letterSpacing: 2,
    textAlign: "center",
  },

  // ─── Gray Section ───
  graySection: {
    backgroundColor: "#1a1a1a",
    padding: 20,
    gap: 12,
  },
  textInput: {
    backgroundColor: "#0e1116",
    borderRadius: 12,
    padding: 14,
    fontSize: 22, // increased font size
    color: "#fff",
    // minHeight: 56,
    // minHeight: 120, // increase text box size
    height: 120, // increase text box size
    borderWidth: 1,
    borderColor: "#2a313c",
  },
  voiceButton: {
    width: "100%",
    backgroundColor: "#fff",
    borderRadius: 20,
    paddingVertical: 20,
    // paddingHorizontal: 28,
    alignItems: "center",
    justifyContent: "center",
  },
  voiceButtonActive: {
    backgroundColor: "#000",
    borderWidth: 2,
    borderColor: "#fff",
  },
  voiceButtonTranscribing: {
    backgroundColor: "#333",
    borderWidth: 2,
    borderColor: "#fff",
  },
  voiceButtonLabel: {
    color: "#000",
    fontSize: 24,
    fontWeight: "bold",
    letterSpacing: 2,
    textAlign: "center",
  },
  voiceButtonLabelOnDark: {
    color: "#fff",
  },

  // ─── Green Section ───
  greenSection: {
    backgroundColor: "#1a1a1a",
    padding: 20,
    gap: 16,
    flexGrow: 1,
  },
  submitButton: {
    backgroundColor: "#fff",
    borderRadius: 20,
    paddingVertical: 20,
    alignItems: "center",
  },
  submitButtonPressed: {
    backgroundColor: "#e0e0e0",
  },
  submitLabel: {
    color: "#000",
    fontSize: 24,
    fontWeight: "bold",
    letterSpacing: 2,
  },
  loadingContainer: {
    alignItems: "center",
    gap: 12,
    paddingVertical: 20,
  },
  loadingText: {
    color: "#fff",
    fontSize: 16,
  },
  pendingQuestion: {
    color: "#fff",
    fontSize: 15,
    textAlign: "center",
    paddingHorizontal: 8,
  },
  responseContainer: {
    gap: 12,
  },
  questionEcho: {
    color: "#fff",
    fontSize: 15,
    fontWeight: "600",
    lineHeight: 22,
  },
  responseActions: {
    // flexDirection: "row",
    // gap: 12,
    width: "100%",
  },
  // actionButton: {
  //   backgroundColor: "#fff",
  //   borderRadius: 40,
  //   paddingVertical: 10,
  //   paddingHorizontal: 20,
  // },
  // actionButtonLabel: {
  //   color: "#000",
  //   fontSize: 16,
  //   fontWeight: "700",
  // },
  // enlarged action or play/pause button for testing
  actionButton: {
    width: "100%",
    minHeight: 70,
    backgroundColor: "#fff",
    borderRadius: 20,
    paddingVertical: 18,
    paddingHorizontal: 20,
    alignItems: "center",
    justifyContent: "center",
  },

  actionButtonLabel: {
    color: "#000",
    fontSize: 24,
    lineHeight: 32,
    fontWeight: "bold",
    letterSpacing: 1,
    textAlign: "center",
  },
  responseText: {
    color: "#fff",
    // fontSize: 16,
    // lineHeight: 26,
    fontSize: 24,
    lineHeight: 34,
    fontWeight: "500",
  },

  // ─── Tools Section (Companion + Saved Places) ───
  toolsSection: {
    backgroundColor: "#0e1116",
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 90, // leave room above the floating call button
    gap: 12,
  },
  toolButton: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#161b22",
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: "#2a313c",
    gap: 14,
  },
  toolButtonPressed: {
    backgroundColor: "#1f2630",
  },
  toolButtonIcon: {
    fontSize: 28,
  },
  toolButtonText: {
    flex: 1,
  },
  toolButtonTitle: {
    color: "#fff",
    fontSize: 17,
    fontWeight: "bold",
    letterSpacing: 0.5,
  },
  toolButtonSubtitle: {
    color: "#fff",
    fontSize: 13,
    marginTop: 2,
    lineHeight: 18,
  },
  signOutButton: {
    alignSelf: "center",
    paddingVertical: 12,
    paddingHorizontal: 28,
    borderRadius: 40,
    borderWidth: 1,
    borderColor: "#3a4150",
    marginTop: 4,
  },
  signOutButtonPressed: {
    backgroundColor: "#1f2630",
  },
  signOutLabel: {
    color: "#d6605d",
    fontSize: 15,
    fontWeight: "bold",
    letterSpacing: 0.5,
  },
});
