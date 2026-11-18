import { MOVEMENT_DIAGNOSTICS_CONFIG } from "./movementDiagnosticsConfig";

export type MotionActivityConfidence = 0 | 1 | 2;
export type MotionActivityType = "automotive" | "cycling" | "running" | "walking" | "stationary" | "unknown";
export type MotionActivityEvent = {
  activities: Record<MotionActivityType, { detected: boolean; confidence: MotionActivityConfidence }>;
  timestamp: number;
};

export type MotionIntervalSummary = {
  version: 1;
  platform: "ios" | "android" | "web" | "unknown";
  availability: "starting" | "available" | "permission_denied" | "unsupported" | "unavailable";
  captureAt: number;
  startedAt?: number;
  observedUntil: number;
  firstReceivedAt?: number;
  lastReceivedAt?: number;
  lastEventAt?: number;
  events: number;
  movingEvents: number;
  stationaryEvents: number;
  unknownEvents: number;
  conflictingEvents: number;
  ignoredEvents: number;
  maxMovingConfidence: number;
  maxPostCaptureMovingConfidence: number;
  maxStationaryConfidence: number;
  postCaptureMovingEvents: number;
  preCaptureMovingContext: boolean;
  timestampSemantics: "activity_start" | "delivery_time" | "unavailable";
  interrupted: boolean;
  incompleteCoverage: boolean;
  stopReason?: string;
  startupDelayMs?: number;
  eventSilenceMs?: number;
  maxDeliveryGapMs?: number;
  eventObservedSpanMs?: number;
};

export type MotionActivityAdapter = {
  requestPermission: () => Promise<boolean>;
  watch: (
    onEvent: (event: MotionActivityEvent) => void,
    onError: () => void,
  ) => Promise<{ remove(): void }>;
};

const activityTypes: MotionActivityType[] = ["automotive", "cycling", "running", "walking", "stationary", "unknown"];
const movingTypes: MotionActivityType[] = ["automotive", "cycling", "running", "walking"];

/** Foreground, best-effort diagnostics only; never evidence that a whole interval was stationary. */
export function createMotionActivityInterval({
  captureAt,
  platform,
  adapter,
  now = Date.now,
  maxDurationMs = MOVEMENT_DIAGNOSTICS_CONFIG.maxSessionDurationMs,
}: {
  captureAt: number;
  platform: MotionIntervalSummary["platform"];
  adapter?: MotionActivityAdapter;
  now?: () => number;
  maxDurationMs?: number;
}): { snapshot(at?: number): MotionIntervalSummary; stop(reason?: string): void } {
  const supported = (platform === "ios" || platform === "android") && !!adapter;
  const summary: MotionIntervalSummary = {
    version: 1,
    platform,
    availability: supported ? "starting" : "unsupported",
    captureAt,
    observedUntil: now(),
    events: 0,
    movingEvents: 0,
    stationaryEvents: 0,
    unknownEvents: 0,
    conflictingEvents: 0,
    ignoredEvents: 0,
    maxMovingConfidence: -1,
    maxPostCaptureMovingConfidence: -1,
    maxStationaryConfidence: -1,
    postCaptureMovingEvents: 0,
    preCaptureMovingContext: false,
    timestampSemantics: !supported ? "unavailable" : platform === "ios" ? "activity_start" : "delivery_time",
    interrupted: false,
    // Startup is asynchronous; neither native provider certifies continuous coverage.
    incompleteCoverage: true,
    maxDeliveryGapMs: 0,
  };
  let stopped = false;
  let subscription: { remove(): void } | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;

  const remove = (value: { remove(): void }) => {
    try {
      value.remove();
    } catch {
      summary.availability = "unavailable";
      summary.interrupted = true;
    }
  };

  const stop = (reason = "stopped") => {
    if (stopped) return;
    stopped = true;
    summary.observedUntil = Math.max(summary.observedUntil, now());
    summary.stopReason = reason;
    summary.interrupted ||= reason !== "completed";
    if (timeout !== undefined) clearTimeout(timeout);
    if (subscription) {
      const current = subscription;
      subscription = undefined;
      remove(current);
    }
  };

  const onError = () => {
    if (stopped) return;
    summary.availability = "unavailable";
    stop("error");
  };

  const onEvent = (event: MotionActivityEvent) => {
    if (stopped) return;
    const receivedAt = now();
    summary.observedUntil = Math.max(summary.observedUntil, receivedAt);
    const valid = event && Number.isFinite(event.timestamp) && event.timestamp > 0
      && event.timestamp <= receivedAt + 2_000
      && (summary.lastEventAt === undefined || event.timestamp > summary.lastEventAt)
      && activityTypes.every((type) => {
        const state = event.activities?.[type];
        return state && typeof state.detected === "boolean"
          && (state.confidence === 0 || state.confidence === 1 || state.confidence === 2);
      });
    if (!valid) {
      summary.ignoredEvents++;
      return;
    }

    summary.events++;
    summary.firstReceivedAt ??= receivedAt;
    if (summary.lastReceivedAt !== undefined) summary.maxDeliveryGapMs = Math.max(
      summary.maxDeliveryGapMs ?? 0, receivedAt - summary.lastReceivedAt);
    summary.lastReceivedAt = receivedAt;
    summary.lastEventAt = event.timestamp;
    const moving = movingTypes.filter((type) => event.activities[type].detected);
    const stationary = event.activities.stationary.detected;
    if (moving.length) {
      summary.movingEvents++;
      const confidence = Math.max(...moving.map((type) => event.activities[type].confidence));
      summary.maxMovingConfidence = Math.max(summary.maxMovingConfidence, confidence);
      // iOS exposes activity start time; Android exposes delivery time, not detection time.
      if (platform === "ios") {
        if (event.timestamp < captureAt) summary.preCaptureMovingContext = true;
        else {
          summary.postCaptureMovingEvents++;
          summary.maxPostCaptureMovingConfidence = Math.max(summary.maxPostCaptureMovingConfidence, confidence);
        }
      }
    }
    if (stationary) {
      summary.stationaryEvents++;
      summary.maxStationaryConfidence = Math.max(summary.maxStationaryConfidence, event.activities.stationary.confidence);
    }
    if (moving.length && stationary) summary.conflictingEvents++;
    if (event.activities.unknown.detected || (!moving.length && !stationary)) summary.unknownEvents++;
  };

  if (supported && adapter) {
    const duration = Number.isFinite(maxDurationMs) && maxDurationMs > 0 ? maxDurationMs : MOVEMENT_DIAGNOSTICS_CONFIG.maxSessionDurationMs;
    timeout = setTimeout(() => stop("timeout"), duration);
    void (async () => {
      try {
        const permitted = await adapter.requestPermission();
        if (stopped) return;
        if (!permitted) {
          summary.availability = "permission_denied";
          stop("permission_denied");
          return;
        }
        summary.startedAt = now();
        const created = await adapter.watch(onEvent, onError);
        if (stopped) remove(created);
        else {
          subscription = created;
          summary.availability = "available";
        }
      } catch {
        // No retry: failed native setup can retain callbacks in the installed Expo wrapper.
        onError();
      }
    })();
  }

  return {
    snapshot: (at = now()) => {
      const end = stopped ? summary.observedUntil : Math.max(summary.observedUntil, at);
      return { ...summary, observedUntil: end,
        startupDelayMs: summary.startedAt === undefined ? undefined : Math.max(0, summary.startedAt - captureAt),
        eventSilenceMs: summary.lastReceivedAt === undefined ? undefined : Math.max(0, end - summary.lastReceivedAt),
        eventObservedSpanMs: summary.firstReceivedAt === undefined ? undefined
          : Math.max(0, summary.lastReceivedAt! - summary.firstReceivedAt),
      };
    },
    stop,
  };
}
