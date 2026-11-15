import { distanceBetween, validPoint } from "../../src/utils/lastMetersSafety";
import type { LatLng } from "./googleMaps";

export interface HistoricalPanorama {
  panoId: string;
  /** An actual capture period, YYYY or YYYY-MM; never a publication date. */
  date: string;
  camera: LatLng;
  placeId: string;
}

/**
 * Server-owned adapter for a documented, authorized historical imagery service.
 * No implementation is configured. Google Static API cannot enumerate history.
 * Each method represents one outbound request, honors cancellation, and must not
 * follow private Google endpoints or retry internally. list returns at most 12
 * metadata entries, ordered newest first, covering at most three requested periods.
 */
export interface HistoricalPanoramaProvider {
  /** Stable diagnostic identifier, never a URL, credential or user input. */
  id: string;
  list(input: { placeId: string; location: LatLng; before: string; maxPeriods: 3; signal: AbortSignal }): Promise<HistoricalPanorama[]>;
  loadView(panorama: HistoricalPanorama, input: { heading: number; signal: AbortSignal }): Promise<string>;
}

/** Year-only periods overlap every month in that year. Unknown dates are unusable. */
export function capturePeriod(date: string): { start: number; end: number } | undefined {
  const match = /^(\d{4})(?:-(0[1-9]|1[0-2]))?$/.exec(date);
  if (!match) return undefined;
  const year = Number(match[1]), month = match[2] ? Number(match[2]) - 1 : 0;
  if (year < 1900) return undefined;
  return { start: Date.UTC(year, month), end: Date.UTC(year + (match[2] ? 0 : 1), match[2] ? month + 1 : 0) };
}

/** Validate eligible metadata only; orchestration owns attempted IDs, periods, I/O, and early stopping. */
export function selectHistoricalPanoramaCandidates(candidates: HistoricalPanorama[], before: number, placeId: string, target: LatLng) {
  return candidates.slice(0, 12).map(panorama => ({ panorama, period: capturePeriod(panorama.date) }))
        .filter(o => o.period && o.period.end <= before && o.period.end <= Date.now()
          && o.panorama.placeId === placeId && validPoint(o.panorama.camera)
          && /^[\w-]{1,160}$/.test(o.panorama.panoId) && distanceBetween(o.panorama.camera, target) <= 75)
        .sort((a, b) => b.period!.start - a.period!.start);
}
