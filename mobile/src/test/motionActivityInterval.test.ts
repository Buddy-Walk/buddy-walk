import assert from "node:assert/strict";
import test from "node:test";
import {
  createMotionActivityInterval,
  type MotionActivityAdapter,
  type MotionActivityConfidence,
  type MotionActivityEvent,
  type MotionActivityType,
} from "../utils/motionActivityInterval";

const captureAt = 1_800_000_000_000;
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const event = (timestamp: number, detected: Partial<Record<MotionActivityType, MotionActivityConfidence>> = {}): MotionActivityEvent => ({
  timestamp,
  activities: Object.fromEntries(["automotive", "cycling", "running", "walking", "stationary", "unknown"].map((type) => {
    const confidence = detected[type as MotionActivityType];
    return [type, { detected: confidence !== undefined, confidence: confidence ?? 0 }];
  })) as MotionActivityEvent["activities"],
});
const harness = (platform: "ios" | "android" = "ios") => {
  let clock = captureAt;
  let emit!: (value: MotionActivityEvent) => void;
  let fail!: () => void;
  let removals = 0;
  const adapter: MotionActivityAdapter = {
    requestPermission: async () => true,
    watch: async (onEvent, onError) => {
      emit = onEvent;
      fail = onError;
      return { remove: () => { removals++; } };
    },
  };
  const monitor = createMotionActivityInterval({ captureAt, platform, adapter, now: () => clock });
  return { monitor, emit: (value: MotionActivityEvent) => emit(value), fail: () => fail(),
    setTime: (value: number) => { clock = value; }, removals: () => removals };
};

test("motion interval retains walking when the user later stops, including low confidence", async (t) => {
  const h = harness();
  t.after(() => h.monitor.stop());
  await flush();
  h.setTime(captureAt + 1_000);
  h.emit(event(captureAt + 1_000, { walking: 0 }));
  h.setTime(captureAt + 2_000);
  h.emit(event(captureAt + 2_000, { stationary: 2 }));
  assert.equal(h.monitor.snapshot().movingEvents, 1);
  assert.equal(h.monitor.snapshot().postCaptureMovingEvents, 1);
  assert.equal(h.monitor.snapshot().maxMovingConfidence, 0);
  assert.equal(h.monitor.snapshot().maxPostCaptureMovingConfidence, 0);
  assert.equal(h.monitor.snapshot().stationaryEvents, 1);
  assert.equal(h.monitor.snapshot().maxStationaryConfidence, 2);
  assert.equal(h.monitor.snapshot().incompleteCoverage, true);
});

test("motion interval preserves simultaneous moving and stationary flags and maximum confidence", async (t) => {
  const h = harness();
  t.after(() => h.monitor.stop());
  await flush();
  h.emit(event(captureAt, { walking: 1, running: 2, stationary: 2 }));
  const summary = h.monitor.snapshot();
  assert.equal(summary.events, 1);
  assert.equal(summary.movingEvents, 1);
  assert.equal(summary.stationaryEvents, 1);
  assert.equal(summary.conflictingEvents, 1);
  assert.equal(summary.maxMovingConfidence, 2);
});

test("activity delivery gaps and silence are observable without claiming a fixed native sampling interval", async (t) => {
  const h = harness(); t.after(() => h.monitor.stop()); await flush();
  assert.equal(h.monitor.snapshot().eventSilenceMs, undefined);
  h.setTime(captureAt + 2000); h.emit(event(captureAt + 1000, { walking: 2 }));
  h.setTime(captureAt + 12_000); h.emit(event(captureAt + 10_000, { stationary: 2 }));
  h.setTime(captureAt + 15_000);
  const summary = h.monitor.snapshot();
  assert.equal(summary.maxDeliveryGapMs, 10_000);
  assert.equal(summary.eventObservedSpanMs, 10_000);
  assert.equal(summary.eventSilenceMs, 3000);
  assert.equal(summary.startupDelayMs, 0);
  assert.equal(summary.incompleteCoverage, true);
  assert.equal(summary.movingEvents, 1);
});

test("old iOS initial states are context and do not certify post-capture movement", async (t) => {
  const h = harness();
  t.after(() => h.monitor.stop());
  await flush();
  h.emit(event(captureAt - 60_000, { walking: 2 }));
  h.emit(event(captureAt - 30_000, { stationary: 2 }));
  const summary = h.monitor.snapshot();
  assert.equal(summary.timestampSemantics, "activity_start");
  assert.equal(summary.preCaptureMovingContext, true);
  assert.equal(summary.movingEvents, 1);
  assert.equal(summary.stationaryEvents, 1);
  assert.equal(summary.postCaptureMovingEvents, 0);
  assert.equal(summary.maxPostCaptureMovingConfidence, -1);
  assert.equal(summary.ignoredEvents, 0);
});

test("high-confidence pre-capture activity does not upgrade low-confidence post-capture motion", async (t) => {
  const h = harness();
  t.after(() => h.monitor.stop());
  await flush();
  h.emit(event(captureAt - 1_000, { walking: 2 }));
  h.setTime(captureAt + 1_000);
  h.emit(event(captureAt + 1_000, { walking: 0 }));
  h.setTime(captureAt + 2_000);
  h.emit(event(captureAt + 2_000, { stationary: 2 }));
  const summary = h.monitor.snapshot();
  assert.equal(summary.movingEvents, 2);
  assert.equal(summary.preCaptureMovingContext, true);
  assert.equal(summary.maxMovingConfidence, 2);
  assert.equal(summary.postCaptureMovingEvents, 1);
  assert.equal(summary.maxPostCaptureMovingConfidence, 0);
});

test("Android delivery time never certifies when movement began", async (t) => {
  const h = harness("android");
  t.after(() => h.monitor.stop());
  await flush();
  h.setTime(captureAt + 8_000);
  h.emit(event(captureAt + 8_000, { walking: 2 }));
  const summary = h.monitor.snapshot();
  assert.equal(summary.timestampSemantics, "delivery_time");
  assert.equal(summary.movingEvents, 1);
  assert.equal(summary.lastReceivedAt, captureAt + 8_000);
  assert.equal(summary.postCaptureMovingEvents, 0);
  assert.equal(summary.maxPostCaptureMovingConfidence, -1);
  assert.equal(summary.preCaptureMovingContext, false);
});

test("invalid, future, duplicate, and out-of-order motion events are ignored", async (t) => {
  const h = harness();
  t.after(() => h.monitor.stop());
  await flush();
  h.emit(event(captureAt, { stationary: 2 }));
  for (const timestamp of [NaN, Infinity, 0, -1, captureAt + 2_001, captureAt, captureAt - 1]) {
    h.emit(event(timestamp, { walking: 2 }));
  }
  const malformed = event(captureAt + 1, { walking: 2 });
  malformed.activities.walking.confidence = 3 as MotionActivityConfidence;
  h.emit(malformed);
  const summary = h.monitor.snapshot();
  assert.equal(summary.ignoredEvents, 8);
  assert.equal(summary.events, 1);
  assert.equal(summary.movingEvents, 0);
  assert.equal(summary.lastEventAt, captureAt);
});

test("no events and explicit unknown activity are never stationary evidence", async (t) => {
  const h = harness();
  t.after(() => h.monitor.stop());
  await flush();
  assert.equal(h.monitor.snapshot().availability, "available");
  assert.equal(h.monitor.snapshot().events, 0);
  assert.equal(h.monitor.snapshot().stationaryEvents, 0);
  assert.equal(h.monitor.snapshot().maxStationaryConfidence, -1);
  h.emit(event(captureAt, { unknown: 2 }));
  h.emit(event(captureAt + 1));
  assert.equal(h.monitor.snapshot().unknownEvents, 2);
  assert.equal(h.monitor.snapshot().stationaryEvents, 0);
});

test("denied permission and unsupported platforms do not subscribe or fabricate stationary activity", async () => {
  let requests = 0;
  let watches = 0;
  const adapter: MotionActivityAdapter = {
    requestPermission: async () => { requests++; return false; },
    watch: async () => { watches++; return { remove() {} }; },
  };
  for (const platform of ["web", "unknown"] as const) {
    const monitor = createMotionActivityInterval({ captureAt, platform, adapter, now: () => captureAt });
    assert.equal(monitor.snapshot().availability, "unsupported");
    assert.equal(monitor.snapshot().timestampSemantics, "unavailable");
    assert.equal(monitor.snapshot().stationaryEvents, 0);
  }
  const missing = createMotionActivityInterval({ captureAt, platform: "ios", now: () => captureAt });
  assert.equal(missing.snapshot().availability, "unsupported");
  const denied = createMotionActivityInterval({ captureAt, platform: "ios", adapter, now: () => captureAt });
  await flush();
  assert.equal(requests, 1);
  assert.equal(watches, 0);
  assert.equal(denied.snapshot().availability, "permission_denied");
  assert.equal(denied.snapshot().stationaryEvents, 0);
});

test("unsupported intervals record explicit lifecycle interruption without starting sensors", () => {
  let clock = captureAt;
  let requests = 0;
  const monitor = createMotionActivityInterval({ captureAt, platform: "web", now: () => clock,
    adapter: { requestPermission: async () => { requests++; return true; }, watch: async () => ({ remove() {} }) } });
  clock += 2_000;
  monitor.stop("background");
  clock += 5_000;
  const summary = monitor.snapshot();
  assert.equal(requests, 0);
  assert.equal(summary.availability, "unsupported");
  assert.equal(summary.stopReason, "background");
  assert.equal(summary.interrupted, true);
  assert.equal(summary.observedUntil, captureAt + 2_000);
});

test("stopping during a late permission request never starts the watch", async () => {
  const permission = deferred<boolean>();
  let watches = 0;
  const monitor = createMotionActivityInterval({ captureAt, platform: "ios", now: () => captureAt,
    adapter: { requestPermission: () => permission.promise,
      watch: async () => { watches++; return { remove() {} }; } } });
  monitor.stop("recapture");
  permission.resolve(true);
  await flush();
  assert.equal(watches, 0);
  assert.equal(monitor.snapshot().stopReason, "recapture");
  assert.equal(monitor.snapshot().interrupted, true);
});

test("late subscription resolution is removed exactly once and late callbacks are ignored", async () => {
  const watch = deferred<{ remove(): void }>();
  let emit!: (value: MotionActivityEvent) => void;
  let removals = 0;
  const monitor = createMotionActivityInterval({ captureAt, platform: "ios", now: () => captureAt,
    adapter: { requestPermission: async () => true, watch: (onEvent) => { emit = onEvent; return watch.promise; } } });
  await flush();
  monitor.stop("background");
  emit(event(captureAt, { walking: 2 }));
  watch.resolve({ remove: () => { removals++; } });
  await flush();
  monitor.stop("completed");
  assert.equal(removals, 1);
  assert.equal(monitor.snapshot().events, 0);
  assert.equal(monitor.snapshot().stopReason, "background");
});

test("native errors clean up, stay unavailable, and never retry", async () => {
  const h = harness();
  await flush();
  h.fail();
  h.fail();
  h.emit(event(captureAt, { stationary: 2 }));
  assert.equal(h.removals(), 1);
  assert.equal(h.monitor.snapshot().availability, "unavailable");
  assert.equal(h.monitor.snapshot().events, 0);
  assert.equal(h.monitor.snapshot().stopReason, "error");

  let watches = 0;
  const rejected = createMotionActivityInterval({ captureAt, platform: "ios", now: () => captureAt,
    adapter: { requestPermission: async () => true, watch: async () => { watches++; throw new Error("unsupported native binary"); } } });
  await flush();
  assert.equal(watches, 1);
  assert.equal(rejected.snapshot().availability, "unavailable");
  assert.equal(rejected.snapshot().stationaryEvents, 0);
});

test("a synchronous watch error still removes its late subscription", async () => {
  let removals = 0;
  const monitor = createMotionActivityInterval({ captureAt, platform: "ios", now: () => captureAt,
    adapter: { requestPermission: async () => true, watch: async (_onEvent, onError) => {
      onError();
      return { remove: () => { removals++; } };
    } } });
  await flush();
  assert.equal(removals, 1);
  assert.equal(monitor.snapshot().availability, "unavailable");
});

test("snapshots are independent copies and completion freezes the interval", async () => {
  const h = harness();
  await flush();
  h.setTime(captureAt + 1_000);
  const snapshot = h.monitor.snapshot();
  snapshot.events = 100;
  assert.equal(h.monitor.snapshot().events, 0);
  h.monitor.stop("completed");
  h.setTime(captureAt + 20_000);
  assert.equal(h.monitor.snapshot().observedUntil, captureAt + 1_000);
  assert.equal(h.monitor.snapshot().interrupted, false);
  assert.equal(h.removals(), 1);
});

test("default timeout bounds collection to 90 seconds and ignores subsequent events", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness();
  await flush();
  h.setTime(captureAt + 89_999);
  t.mock.timers.tick(89_999);
  assert.equal(h.removals(), 0);
  h.setTime(captureAt + 90_000);
  t.mock.timers.tick(1);
  h.emit(event(captureAt + 90_000, { walking: 2 }));
  assert.equal(h.removals(), 1);
  assert.equal(h.monitor.snapshot().events, 0);
  assert.equal(h.monitor.snapshot().stopReason, "timeout");
  assert.equal(h.monitor.snapshot().interrupted, true);
  assert.equal(h.monitor.snapshot().observedUntil, captureAt + 90_000);
});
