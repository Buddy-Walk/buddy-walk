/**
 * Supplemental turn-by-turn guidance — optional GPS + haptic cues for parsed
 * walking steps. Not wired into MainScreen as a Google Maps replacement;
 * spoken AI directions remain the primary experience. Import when building
 * lighter assist features (e.g. manual step-by-step help).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import * as Location from 'expo-location';
import * as Speech from 'expo-speech';

import { NavRoute, NavStep, NavLatLng } from '../types';
import { PATTERNS, cancelPulse, patternForManeuver, pulse } from '../utils/haptics';
import { track, Events } from '../api/telemetry';
import {
  haversineMeters,
  hasUsableDestination,
  metersToFeetText,
  stepHasUsableCoords,
  estimateStepDurationMs,
} from '../utils/navigationMath';

/** Distance in meters at which we consider a maneuver point "reached". */
const STEP_ADVANCE_RADIUS_M = 12;
/** Must stay within advance radius this long before the next step fires (GPS jitter guard). */
const STEP_ADVANCE_DWELL_MS = 6000;
/** Distance at which we proactively warn the user a maneuver is coming. */
const HEADS_UP_RADIUS_M = 40;
/** Distance at which we declare arrival on the final step. */
const ARRIVE_RADIUS_M = 12;
/** How far off the planned step we tolerate before flagging "off route". */
const OFF_ROUTE_RADIUS_M = 70;
/** How long we must remain off-route before the warning fires (debounce). */
const OFF_ROUTE_GRACE_MS = 8000;
/** How often the manual "what's my distance" recap will repeat at most. */
const MIN_RESPEAK_GAP_MS = 6000;

export interface UseTurnByTurnResult {
  active: boolean;
  route: NavRoute | null;
  stepIndex: number;
  currentStep: NavStep | null;
  nextStep: NavStep | null;
  totalSteps: number;
  /** Meters from the device to the end of the current step (i.e. next maneuver point). */
  distanceToNext: number | null;
  arrived: boolean;
  offRoute: boolean;
  /** True when steps lack real lat/lng so proximity advancement is disabled. */
  manualOnly: boolean;
  start: (route: NavRoute) => Promise<void>;
  stop: (silent?: boolean) => Promise<void>;
  repeatCurrent: () => void;
  advanceManually: () => void;
  goBack: () => void;
}

/**
 * Manages an in-progress turn-by-turn walking navigation session:
 *  - watches the device's GPS,
 *  - fires distinct vibration patterns for each maneuver,
 *  - speaks each step,
 *  - detects arrival and "off-route" conditions.
 *
 * Designed to coexist with the existing Magnetometer/heading and location
 * subscriptions in MainScreen — it owns its own short-lived watcher so it
 * stays self-contained.
 */
export function useTurnByTurnNavigation(): UseTurnByTurnResult {
  const [active, setActive] = useState(false);
  const [route, setRoute] = useState<NavRoute | null>(null);
  const [stepIndex, setStepIndex] = useState(0);
  const [distanceToNext, setDistanceToNext] = useState<number | null>(null);
  const [offRoute, setOffRoute] = useState(false);
  const [arrived, setArrived] = useState(false);

  const subRef = useRef<Location.LocationSubscription | null>(null);
  const manualTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const routeRef = useRef<NavRoute | null>(null);
  const stepIndexRef = useRef(0);
  const arrivedRef = useRef(false);
  const offRouteRef = useRef(false);
  const offRouteSinceRef = useRef<number | null>(null);
  const arrivalLoggedRef = useRef(false);
  const offRouteLoggedRef = useRef(false);
  const headsUpFiredRef = useRef<Set<number>>(new Set());
  const verbalPreviewForStepRef = useRef<Set<number>>(new Set());
  const lastSpokenAtRef = useRef<number>(0);
  const manualOnlyRef = useRef(false);
  const stepAdvanceEligibleSinceRef = useRef<number | null>(null);

  // Keep refs in sync so the location callback always reads fresh values.
  useEffect(() => {
    // Keep the route available to long-lived location and timer callbacks without closing over
    // an older render.
    routeRef.current = route;
  }, [route]);
  useEffect(() => {
    // Keep asynchronous navigation callbacks synchronized with the displayed step index.
    stepIndexRef.current = stepIndex;
  }, [stepIndex]);
  useEffect(() => {
    // Expose the latest arrival state to callbacks that may outlive the current render.
    arrivedRef.current = arrived;
  }, [arrived]);
  useEffect(() => {
    // Expose the latest off-route state to the active location watcher.
    offRouteRef.current = offRoute;
  }, [offRoute]);

  const speakStep = useCallback((step: NavStep, prefix?: string) => {
    // Speak a step with an optional prefix while enforcing the minimum gap between repeated
    // instructions.
    const now = Date.now();
    if (now - lastSpokenAtRef.current < MIN_RESPEAK_GAP_MS) return;
    lastSpokenAtRef.current = now;
    const phrase = prefix ? `${prefix} ${step.instruction}` : step.instruction;
    Speech.speak(phrase, { language: 'en-US', rate: 1.0 });
  }, []);

  const fireStepCue = useCallback(
    /**
     * Play the maneuver's tactile pattern, then speak the instruction after the vibration unless
     * only a haptic cue was requested.
     */
    (step: NavStep, prefix?: string, options?: { hapticOnly?: boolean }) => {
      cancelPulse();
      pulse(patternForManeuver(step.maneuver));
      if (options?.hapticOnly) return;
      setTimeout(/* Delay speech briefly so the tactile maneuver cue can be perceived first. */ () => speakStep(step, prefix), 380);
    },
    [speakStep]
  );

  const maneuverPreview = useCallback((step: NavStep): string => {
    // Translate a maneuver token into a brief phrase used by advance turn announcements.
    const m = step.maneuver;
    if (m.includes('uturn')) return 'make a U-turn';
    if (m.includes('sharp-left')) return 'turn sharp left';
    if (m.includes('sharp-right')) return 'turn sharp right';
    if (m.includes('slight-left')) return 'bear left';
    if (m.includes('slight-right')) return 'bear right';
    if (m.includes('turn-left')) return 'turn left';
    if (m.includes('turn-right')) return 'turn right';
    if (m.includes('arrive')) return 'arrive at your destination';
    return 'continue';
  }, []);

  const logArrival = useCallback(() => {
    // Record arrival telemetry at most once for the active navigation session.
    if (arrivalLoggedRef.current) return;
    arrivalLoggedRef.current = true;
    void track(Events.NavigationArrived, {
      steps: routeRef.current?.steps.length ?? 0,
      manualOnly: manualOnlyRef.current,
    });
  }, []);

  const clearManualTimer = useCallback(() => {
    // Cancel the pending manual-step timer before changing steps or stopping navigation.
    if (manualTimerRef.current) {
      clearTimeout(manualTimerRef.current);
      manualTimerRef.current = null;
    }
  }, []);

  // Self-rescheduling timer that walks the user through a coordinate-free route
  // hands-off. Held in a ref so it never needs to be a hook dependency.
  const runManualAdvanceRef = useRef<() => void>(() => { /* Provide an initialized callable ref before the manual-step scheduler is assigned. */ });
  runManualAdvanceRef.current = () => {
    // Schedule progress for text-only steps while retaining GPS as the arrival authority when
    // destination coordinates exist.
    const r = routeRef.current;
    if (!r || arrivedRef.current) return;
    const idx = stepIndexRef.current;
    const cur = r.steps[idx];
    const isLast = idx >= r.steps.length - 1;
    manualTimerRef.current = setTimeout(() => {
      // Advance a timed fallback step or announce proximity to the mapped destination without
      // inventing GPS-confirmed arrival.
      if (arrivedRef.current) return;
      if (isLast) {
        // When we know the destination coordinate, the GPS watcher is the
        // authority on arrival — don't guess from the timer. Just nudge the
        // user that they're close and let GPS announce the exact arrival.
        if (hasUsableDestination(r)) {
          lastSpokenAtRef.current = 0;
          Speech.speak('You should be close to your destination now.', { language: 'en-US' });
          return;
        }
        arrivedRef.current = true;
        setArrived(true);
        setActive(false);
        try {
          subRef.current?.remove();
        } catch {
          /* noop */
        }
        subRef.current = null;
        pulse(PATTERNS.ARRIVED);
        lastSpokenAtRef.current = 0;
        Speech.speak('You should be arriving at your destination now.', { language: 'en-US' });
        logArrival();
        return;
      }
      const newIdx = idx + 1;
      stepIndexRef.current = newIdx;
      setStepIndex(newIdx);
      const next = r.steps[newIdx];
      if (next) {
        lastSpokenAtRef.current = 0;
        const previewed = verbalPreviewForStepRef.current.has(newIdx);
        fireStepCue(next, undefined, previewed ? { hapticOnly: true } : undefined);
      }
      runManualAdvanceRef.current();
    }, estimateStepDurationMs(cur));
  };

  const stop = useCallback(
    /**
     * Stop navigation, release location/timer/haptic resources, and reset all session state;
     * silent mode preserves a replacement session's speech.
     */
    async (silent = false) => {
      try {
        subRef.current?.remove();
      } catch {
        // ignore — listener may already be torn down
      }
      subRef.current = null;
      clearManualTimer();
      cancelPulse();
      if (!silent) {
        Speech.stop();
        void track(Events.NavigationStopped, { arrived: arrivedRef.current });
      }
      setActive(false);
      setRoute(null);
      setStepIndex(0);
      setDistanceToNext(null);
      setOffRoute(false);
      setArrived(false);
      routeRef.current = null;
      stepIndexRef.current = 0;
      arrivedRef.current = false;
      offRouteRef.current = false;
      offRouteSinceRef.current = null;
      headsUpFiredRef.current.clear();
      verbalPreviewForStepRef.current.clear();
      lastSpokenAtRef.current = 0;
      manualOnlyRef.current = false;
      arrivalLoggedRef.current = false;
      offRouteLoggedRef.current = false;
      stepAdvanceEligibleSinceRef.current = null;
    },
    [clearManualTimer]
  );

  const onLocationUpdate = useCallback((loc: Location.LocationObject) => {
    // Update route progress from a GPS fix, check arrival and off-route evidence, and emit
    // eligible step or approach cues.
    const r = routeRef.current;
    if (!r || arrivedRef.current) return;
    const idx = stepIndexRef.current;
    const step = r.steps[idx];
    if (!step) return;

    if (!stepHasUsableCoords(step)) {
      // Manual-only step coords: steps are narrated on a timer, but if we know
      // the destination coordinate we still confirm *exact* arrival by GPS.
      setDistanceToNext(null);
      if (hasUsableDestination(r)) {
        const me: NavLatLng = { lat: loc.coords.latitude, lng: loc.coords.longitude };
        const distToDest = haversineMeters(me, { lat: r.destination.lat, lng: r.destination.lng });
        if (distToDest < ARRIVE_RADIUS_M) {
          arrivedRef.current = true;
          setArrived(true);
          setActive(false);
          clearManualTimer();
          try {
            subRef.current?.remove();
          } catch {
            /* noop */
          }
          subRef.current = null;
          pulse(PATTERNS.ARRIVED);
          lastSpokenAtRef.current = 0;
          Speech.speak('You have arrived at your destination.', { language: 'en-US' });
          logArrival();
        }
      }
      return;
    }

    const me: NavLatLng = { lat: loc.coords.latitude, lng: loc.coords.longitude };
    const distToCorner = haversineMeters(me, step.endLocation);
    setDistanceToNext(distToCorner);

    const isLast = idx === r.steps.length - 1;

    // Final-leg arrival check (covers both arrive-step and last instruction step).
    if (isLast) {
      const distToDest = haversineMeters(me, { lat: r.destination.lat, lng: r.destination.lng });
      if (distToDest < ARRIVE_RADIUS_M || distToCorner < ARRIVE_RADIUS_M) {
        arrivedRef.current = true;
        setArrived(true);
        setActive(false);
        try {
          subRef.current?.remove();
        } catch {
          /* noop */
        }
        subRef.current = null;
        pulse(PATTERNS.ARRIVED);
        // arrive cue should always speak even if we just spoke; reset gate
        lastSpokenAtRef.current = 0;
        Speech.speak('You have arrived at your destination.', { language: 'en-US' });
        logArrival();
        return;
      }
    }

    // Heads-up: subtle pulse + spoken preview of the next maneuver as we approach.
    if (
      !isLast &&
      distToCorner < HEADS_UP_RADIUS_M &&
      !headsUpFiredRef.current.has(idx)
    ) {
      headsUpFiredRef.current.add(idx);
      const next = r.steps[idx + 1];
      if (next) {
        cancelPulse();
        pulse(PATTERNS.HEADS_UP);
        verbalPreviewForStepRef.current.add(idx + 1);
        Speech.speak(
          `In ${metersToFeetText(distToCorner)}, ${maneuverPreview(next)}.`,
          { language: 'en-US' }
        );
        lastSpokenAtRef.current = Date.now();
      }
    }

    // Step transition: near the corner — advance only after dwelling in range.
    if (!isLast && distToCorner < STEP_ADVANCE_RADIUS_M) {
      if (stepAdvanceEligibleSinceRef.current === null) {
        stepAdvanceEligibleSinceRef.current = Date.now();
      } else if (Date.now() - stepAdvanceEligibleSinceRef.current >= STEP_ADVANCE_DWELL_MS) {
        stepAdvanceEligibleSinceRef.current = null;
        const newIdx = idx + 1;
        stepIndexRef.current = newIdx;
        setStepIndex(newIdx);
        headsUpFiredRef.current.add(idx);
        const next = r.steps[newIdx];
        if (next) {
          lastSpokenAtRef.current = 0;
          const previewed = verbalPreviewForStepRef.current.has(newIdx);
          fireStepCue(next, undefined, previewed ? { hapticOnly: true } : undefined);
        }
      }
    } else {
      stepAdvanceEligibleSinceRef.current = null;
    }

    // Off-route check: distance from both ends of the current segment.
    const distToStart = haversineMeters(me, step.startLocation);
    const minDist = Math.min(distToCorner, distToStart);
    if (minDist > OFF_ROUTE_RADIUS_M) {
      if (offRouteSinceRef.current === null) {
        offRouteSinceRef.current = Date.now();
      } else if (
        Date.now() - offRouteSinceRef.current > OFF_ROUTE_GRACE_MS &&
        !offRouteRef.current
      ) {
        offRouteRef.current = true;
        setOffRoute(true);
        pulse(PATTERNS.OFF_ROUTE);
        if (!offRouteLoggedRef.current) {
          offRouteLoggedRef.current = true;
          void track(Events.NavigationOffRoute);
        }
        Speech.speak(
          'You may be off the route. Please check your direction or ask for new directions.',
          { language: 'en-US' }
        );
      }
    } else {
      offRouteSinceRef.current = null;
      if (offRouteRef.current) {
        offRouteRef.current = false;
        setOffRoute(false);
      }
    }
  }, [clearManualTimer, fireStepCue, maneuverPreview]);

  const start = useCallback(
    /**
     * Replace the current navigation session, initialize mapped or timed step tracking, announce
     * the first step, and subscribe to location changes.
     */
    async (r: NavRoute) => {
      if (!r?.steps?.length) return;
      // Clear any prior session quietly (don't TTS-stop the new step we're about to say).
      await stop(true);

      const usable = r.steps.some(stepHasUsableCoords);
      manualOnlyRef.current = !usable;

      setRoute(r);
      routeRef.current = r;
      setStepIndex(0);
      stepIndexRef.current = 0;
      setActive(true);
      arrivalLoggedRef.current = false;
      offRouteLoggedRef.current = false;
      stepAdvanceEligibleSinceRef.current = null;

      const first = r.steps[0];
      if (first) {
        // Reset gate so the opening cue always lands. The shake-to-stop hint
        // makes ending navigation discoverable hands-off for blind users.
        lastSpokenAtRef.current = 0;
        fireStepCue(first, 'Starting navigation. Shake the phone to stop.');
      }

      // No per-step GPS coordinates (e.g. directions parsed from plain text):
      // advance the spoken steps hands-off on a walking-time timer so the user
      // never has to touch the screen. We still start the GPS watcher below so
      // that — once we know the destination (possibly geocoded moments later) —
      // arrival is confirmed exactly rather than guessed by the timer.
      if (manualOnlyRef.current) {
        clearManualTimer();
        runManualAdvanceRef.current();
      }

      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') return;

      try {
        subRef.current = await Location.watchPositionAsync(
          {
            accuracy: Location.Accuracy.BestForNavigation,
            distanceInterval: 5,
            timeInterval: 2500,
          },
          onLocationUpdate
        );
      } catch (e) {
        console.warn('useTurnByTurnNavigation: failed to start location watcher', e);
      }
    },
    [clearManualTimer, fireStepCue, onLocationUpdate, stop]
  );

  const repeatCurrent = useCallback(() => {
    // Replay the current step on demand, bypassing the normal automatic-repeat timing gate.
    const r = routeRef.current;
    if (!r) return;
    const cur = r.steps[stepIndexRef.current];
    if (!cur) return;
    lastSpokenAtRef.current = 0;
    fireStepCue(cur);
  }, [fireStepCue]);

  const advanceManually = useCallback(() => {
    // Move to the next available step and immediately play its maneuver cue.
    const r = routeRef.current;
    if (!r) return;
    const max = r.steps.length - 1;
    const newIdx = Math.min(stepIndexRef.current + 1, max);
    stepIndexRef.current = newIdx;
    setStepIndex(newIdx);
    headsUpFiredRef.current.add(newIdx);
    const next = r.steps[newIdx];
    if (next) {
      lastSpokenAtRef.current = 0;
      fireStepCue(next);
    }
  }, [fireStepCue]);

  const goBack = useCallback(() => {
    // Move to the previous available step and immediately replay its maneuver cue.
    const r = routeRef.current;
    if (!r) return;
    const newIdx = Math.max(stepIndexRef.current - 1, 0);
    stepIndexRef.current = newIdx;
    setStepIndex(newIdx);
    const prev = r.steps[newIdx];
    if (prev) {
      lastSpokenAtRef.current = 0;
      fireStepCue(prev);
    }
  }, [fireStepCue]);

  // Tear down on unmount.
  useEffect(() => {
    // Install teardown for the location watcher, manual step timer, and repeating vibration.
    return () => {
      // Release navigation resources when the hook unmounts.
      try {
        subRef.current?.remove();
      } catch {
        /* noop */
      }
      subRef.current = null;
      if (manualTimerRef.current) {
        clearTimeout(manualTimerRef.current);
        manualTimerRef.current = null;
      }
      cancelPulse();
    };
  }, []);

  const currentStep = route?.steps[stepIndex] ?? null;
  const nextStep = route ? route.steps[stepIndex + 1] ?? null : null;

  return {
    active,
    route,
    stepIndex,
    currentStep,
    nextStep,
    totalSteps: route?.steps.length ?? 0,
    distanceToNext,
    arrived,
    offRoute,
    manualOnly: manualOnlyRef.current,
    start,
    stop,
    repeatCurrent,
    advanceManually,
    goBack,
  };
}
