# #72 — `gps_uncertain` calibration (local)

**Branch:** `investigate/72-gps-uncertain`  
**Status:** LOCAL IMPL DONE — WAITING_FOR_APPROVAL to commit/push/PR  
**Do not overwrite:** #146 (CONFLICTING), #153/#168 (MERGEABLE)

## Definition (documented)

- Expo / Geolocation `coords.accuracy` is a **horizontal accuracy radius in meters** (OS confidence circle).
- Client passes it as `gpsAccuracyMeters` / `sensors.latestPosition.accuracy` with **no unit conversion**.
- Absolute cap remains **`GPS_ACCURACY_MAX_METERS = 20`** — not relaxed.
- When entrance `distanceMeters` is known, an **additive** check requires  
  `accuracy / distance ≤ sin(22.5°)` (same budget as `bearing_uncertainty_too_large`).  
  This never raises the 20 m cap (e.g. 25 m at 200 m distance still withholds).

## Implementation (uncommitted)

- `gpsAccuracyDiagnostics` + named constants in `lastMetersSafety.ts`
- `sensorSafetyReasons` optional 7th arg `distanceMeters`
- Turn/late paths pass `entrance.distanceMeters`
- Trial persists `gpsAccuracy` diagnostics on withhold (meters/ratios only)
- `preciseTurnReasons` / exact-mode gate share `GPS_ACCURACY_MAX_METERS`

## Test evidence

`npx tsx --test src/test/lastMetersSafety.test.ts` → **11 pass / 0 fail**  
Covers: missing/invalid/boundary 20 / 20.1, Chase-style 22.2 m, additive distance ratio, co-occurrence with `moved_since_capture` + `bearing_uncertainty_too_large`, reliable 5 m @ 50 m.

## Next

Await publish approval. Coordinate threshold policy with Hanyuan before any further gate changes.
