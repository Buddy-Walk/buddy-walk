# #71 Investigation — `turned_since_capture` (local)

**Branch:** `investigate/71-turned-since-capture`  
**Status:** LOCAL COMPLETE — diagnostics + tests; no push/PR without approval  
**Coord:** #153 heading accuracy (OPEN) — optional `latestHeadingAccuracyLevel` only; do not overwrite teammate work

## Current gate

`sensorSafetyReasons` (`lastMetersSafety.ts`):

1. Require true-north on capture + latest heading references.
2. Require finite latest heading and freshness ≤ 15 s vs `snapshotTime`.
3. Else if shortest-arc `angularDifference(capture, latest) > 15` → `turned_since_capture`.

`TURNED_SINCE_CAPTURE_MAX_DEGREES = 15` (unchanged). Wrap-around uses `(+540 % 360)` shortest arc.

## Diagnostics (`turnedSinceCaptureDiagnostics`)

Persisted on Trial withhold when reason is present (angles/ages only — no lat/lng):

| Field | Meaning |
| --- | --- |
| captureHeadingDegrees / latestHeadingDegrees | Raw headings used in the comparison |
| circularDeltaDegrees | Shortest-arc delta |
| maxDeltaDegrees | 15 (policy constant) |
| capture/latest timestamps + ages vs snapshot | Freshness evidence |
| latestHeadingAccuracyLevel | Optional Expo 0–3 when client recorded it (#153) |
| failureKinds | missing/invalid/stale vs `circular_delta_above_max` |

Stale or unusable headings classify as `current_heading_unavailable`, **not** `turned_since_capture`.

## Client wiring (`MainScreen.tsx`)

| Field | Source |
| --- | --- |
| Capture heading (`heading` / `capturedPhotoHeadingRef`) | `headingRef` at shutter time |
| Live heading (`sensors.latestHeading`) | `headingRef` at request time |
| Timestamps / reference | `headingTimestampRef`, `headingReferenceRef` (true vs magnetic) |

## Mobile vs strict policy

- **Strict:** large unvalidated rotation withholds (`turned_since_capture`).
- **Mobile:** when a valid current true-north heading exists, `turnSensorReasons` strips `turned_since_capture` and `guidanceHeading` rebases the turn onto that reading. Other hard gates still apply. Threshold is not relaxed.

## Acceptance criteria

| AC | Coverage |
| --- | --- |
| Instrument raw headings, accuracy, timestamps, circular delta | `turnedSinceCaptureDiagnostics` + Trial `turnedSinceCapture` |
| Small jitter / wrap-around do not spuriously trigger | tests: 359↔1, 5° jitter, boundary 15° |
| Large unvalidated change blocks stale precise turns | strict path + Trial withhold test |
| Newer validated orientation permits recomputation after remaining checks | mobile `turnSensorReasons` / `guidanceHeading` test |
| Retest McDonald’s / distinct destinations on both sensor paths | unit fixtures mirror capture vs live; field retest remains WAITING_FOR_APPROVAL |

## Verdict

Observed field withholds are **correct fail-closed safety behavior** for unvalidated rotation under the 15° policy. Instrumentation gap closed locally. Do **not** reduce 15° without Safety Gate review. Publication of this branch requires explicit approval.
