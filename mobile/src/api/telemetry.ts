import AsyncStorage from '@react-native-async-storage/async-storage';
import { apiClient } from './client';
import {
  appVersion,
  getInstallId,
  platform,
  sessionId,
} from '../utils/identity';
import {
  isAnalyticsOptedOut,
  isAnalyticsOptedOutSync,
  subscribeAnalyticsOptOut,
} from '../utils/analyticsConsent';

const QUEUE_KEY = '@buddywalk:telemetryQueue';
const MAX_QUEUE = 200;
const FLUSH_AT = 10;
const FLUSH_INTERVAL_MS = 30_000;

/**
 * Low-cardinality event names. Keeping these as constants (rather than free-form
 * strings at call sites) keeps the testing dashboards clean and prevents typos
 * from fragmenting the data.
 */
export const Events = {
  AppOpened: 'app_opened',
  ScreenView: 'screen_view',
  QuestionAsked: 'question_asked',
  AnswerReceived: 'answer_received',
  AnswerFailed: 'answer_failed',
  AnswerRejected: 'answer_rejected',
  PhotoCaptured: 'photo_captured',
  VideoRecorded: 'video_recorded',
  VoiceStarted: 'voice_started',
  VoiceStopped: 'voice_stopped',
  NavigationStarted: 'navigation_started',
  NavigationStopped: 'navigation_stopped',
  NavigationArrived: 'navigation_arrived',
  NavigationOffRoute: 'navigation_off_route',
  CompanionSessionCreated: 'companion_session_created',
  CompanionLinkShared: 'companion_link_shared',
  CompanionPingSent: 'companion_ping_sent',
  SavedPlaceCreated: 'saved_place_created',
  SavedPlaceDeleted: 'saved_place_deleted',
  SavedPlaceUsed: 'saved_place_used',
  FeedbackSubmitted: 'feedback_submitted',
  AnswerRated: 'answer_rated',
  NewTestStarted: 'new_test_started',
} as const;

export type EventName = (typeof Events)[keyof typeof Events] | string;

type PropValue = string | number | boolean | null;

interface QueuedEvent {
  name: EventName;
  props?: Record<string, PropValue>;
  screen?: string;
  ts: number;
}

let queue: QueuedEvent[] = [];
let currentScreen: string | undefined;
let flushing = false;
let hydrated = false;
let timer: ReturnType<typeof setInterval> | null = null;

/**
 * Telemetry is on in production builds and off in dev unless explicitly enabled,
 * so local development doesn't pollute the testing data.
 */
const TELEMETRY_ENABLED =
  // eslint-disable-next-line no-undef
  (typeof __DEV__ === 'undefined' || __DEV__ === false) ||
  process.env.EXPO_PUBLIC_TELEMETRY === '1';

/**
 * Keep bounded scalar event properties and omit nested objects or media that do not belong in
 * telemetry.
 */
function sanitizeProps(
  props?: Record<string, unknown>
): Record<string, PropValue> | undefined {
  if (!props) return undefined;
  const out: Record<string, PropValue> = {};
  for (const [key, value] of Object.entries(props)) {
    if (value == null) {
      out[key] = null;
    } else if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      // Cap string length so a stray large payload can never bloat an event.
      out[key] = typeof value === 'string' ? value.slice(0, 500) : value;
    }
    // Objects/arrays are intentionally dropped to avoid storing PII or media.
  }
  return out;
}

/**
 * Load the bounded offline event queue once per app session, falling back to an empty queue if
 * storage is invalid.
 */
async function hydrate(): Promise<void> {
  if (hydrated) return;
  hydrated = true;
  try {
    const raw = await AsyncStorage.getItem(QUEUE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) queue = parsed.slice(-MAX_QUEUE);
    }
  } catch {
    queue = [];
  }
}

/**
 * Persist the most recent queued events without allowing an analytics storage failure to affect
 * the app.
 */
async function persist(): Promise<void> {
  try {
    await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(queue.slice(-MAX_QUEUE)));
  } catch {
    // Best effort; losing buffered analytics is acceptable.
  }
}

/** Update the screen name automatically attached to subsequent telemetry events. */
export function setCurrentScreen(name: string): void {
  currentScreen = name;
}

/**
 * Queue a consent-eligible event with sanitized properties and timestamps, persisting it offline
 * and flushing when the batch threshold is reached.
 */
export async function track(
  name: EventName,
  props?: Record<string, unknown>
): Promise<void> {
  if (!TELEMETRY_ENABLED) return;
  try {
    if (await isAnalyticsOptedOut()) return;
    await hydrate();
    queue.push({
      name,
      props: sanitizeProps(props),
      screen: currentScreen,
      ts: Date.now(),
    });
    if (queue.length > MAX_QUEUE) queue = queue.slice(-MAX_QUEUE);
    await persist();
    if (queue.length >= FLUSH_AT) void flush();
  } catch {
    // Telemetry must never break the app.
  }
}

/** Record a screen visit and make that screen the context for later events. */
export function trackScreen(name: string): void {
  setCurrentScreen(name);
  void track(Events.ScreenView, { screen: name });
}

/**
 * Send one queued batch at a time with installation identity, removing only successfully uploaded
 * events and retaining failed batches.
 */
export async function flush(): Promise<void> {
  if (!TELEMETRY_ENABLED || flushing) return;
  if (isAnalyticsOptedOutSync()) return;
  await hydrate();
  if (queue.length === 0) return;
  flushing = true;
  const batch = queue.slice(0, MAX_QUEUE);
  try {
    const installId = await getInstallId();
    await apiClient.post('/telemetry/events', {
      installId,
      sessionId,
      platform,
      appVersion,
      events: batch,
    });
    // Drop only what we sent; events added during the request stay queued.
    queue = queue.slice(batch.length);
    await persist();
  } catch {
    // Leave the batch queued to retry on the next flush.
  } finally {
    flushing = false;
  }
}

/**
 * Start the background flush loop and emit the app-open event. Safe to call more
 * than once. Returns a disposer for tests/teardown.
 */
export function initTelemetry(): () => void {
  if (!TELEMETRY_ENABLED) return () => { /* Return a harmless teardown function when telemetry collection is disabled. */ };
  if (!timer) {
    timer = setInterval(/* Flush queued analytics periodically without blocking the current user interaction. */ () => void flush(), FLUSH_INTERVAL_MS);
  }
  void track(Events.AppOpened);

  const unsubscribe = subscribeAnalyticsOptOut((optedOut) => {
    // Discard buffered events as soon as the user opts out of analytics collection.
    if (optedOut) {
      queue = [];
      void persist();
    }
  });

  return () => {
    // Release the periodic flush timer and consent listener when telemetry shuts down.
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    unsubscribe();
  };
}
