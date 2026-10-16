import type { NavLatLng, NavRoute, NavStep } from '../types';

/**
 * Compute great-circle distance in meters between route coordinates for arrival and step-progress
 * checks.
 */
export function haversineMeters(a: NavLatLng, b: NavLatLng): number {
  const R = 6371000;
  /** Convert degrees to radians before applying the great-circle distance formula. */
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const sa =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(sa), Math.sqrt(1 - sa));
}

/**
 * Format metric distances as short spoken feet estimates, avoiding false precision for very short
 * distances.
 */
export function metersToFeetText(m: number): string {
  if (!Number.isFinite(m)) return '';
  if (m < 6) return 'a few feet';
  const ft = Math.round(m * 3.28084);
  if (ft < 100) return `${Math.round(ft / 5) * 5} feet`;
  return `${Math.round(ft / 10) * 10} feet`;
}

/** Distinguish mapped route steps from text-only fallback steps whose coordinates are all zero. */
export function stepHasUsableCoords(s: NavStep | undefined): boolean {
  if (!s) return false;
  const { startLocation: a, endLocation: b } = s;
  return !(a.lat === 0 && a.lng === 0 && b.lat === 0 && b.lng === 0);
}

/**
 * True when the route's destination has a real coordinate (not the 0,0
 * placeholder used by text-parsed routes). Lets us confirm exact arrival by
 * GPS even when the individual steps lack coordinates.
 */
export function hasUsableDestination(route: NavRoute | null | undefined): boolean {
  const d = route?.destination;
  if (!d) return false;
  if (!Number.isFinite(d.lat) || !Number.isFinite(d.lng)) return false;
  return !(d.lat === 0 && d.lng === 0);
}

/** Minimum pause between auto-timed steps (text-parsed routes without GPS corners). */
export const NAV_MIN_AUTO_STEP_MS = 10_000;
export const NAV_MAX_AUTO_STEP_MS = 90_000;
/** Blind users need more time than Google's optimistic walk estimate. */
export const NAV_AUTO_STEP_MULTIPLIER = 1.35;
const NAV_WALK_SPEED_MPS = 1.0;

/**
 * Estimated time to walk a step for timer-based advancement when steps lack GPS.
 */
export function estimateStepDurationMs(step: NavStep | undefined): number {
  let ms = 0;
  const secs = step?.duration?.value;
  if (typeof secs === 'number' && secs > 0) {
    ms = secs * 1000;
  } else {
    const meters = step?.distance?.value;
    if (typeof meters === 'number' && meters > 0) {
      ms = (meters / NAV_WALK_SPEED_MPS) * 1000;
    }
  }
  if (!ms) ms = 20_000;
  ms *= NAV_AUTO_STEP_MULTIPLIER;
  return Math.min(Math.max(ms, NAV_MIN_AUTO_STEP_MS), NAV_MAX_AUTO_STEP_MS);
}

