# #74 Investigation — `heading_sources_disagree` (local)

**Branch:** `investigate/74-heading-sources-disagree`  
**Status:** LOCAL COMPLETE — diagnostics + tests; no push/PR without approval

## Gate

`compareCompassAndPanoramaHeadings` snaps the device compass to a panorama tile, then shortest-arc compares to the visual match. Agreement budget: **45°** (`HEADING_SOURCES_AGREEMENT_MAX_DEGREES`). Disagreement exits with dedicated outcome `heading_sources_disagree` and withholds a precise turn. Panorama never becomes authoritative.

## Diagnostics (`headingSourcesDisagreeDiagnostics`)

Persisted on Trial when conflict fires:

| Field | Meaning |
| --- | --- |
| rawCompassHeadingDegrees | Pre-snap device heading |
| compassHeadingDegrees | Snapped compass (authoritative) |
| panoramaMatchedHeadingDegrees | Visual/tile heading |
| circularDiscrepancyDegrees | Shortest-arc delta after snap |
| maxAgreementDegrees | 45 |
| compass/panorama reference frames | `compass_true_north_snapped` / `panorama_tile_heading` |
| timestamps / compassAccuracyLevel | When known |
| failureKinds | unavailable vs `circular_discrepancy_above_max` |

Missing sources → unavailable kinds, **not** `heading_sources_disagree`.

## Acceptance criteria

| AC | Coverage |
| --- | --- |
| Log raw sources, timestamps, confidence, frames, discrepancy | diagnostics + Trial field |
| 359° vs 1° / agreeing fixtures do not conflict | unit tests |
| Trusted conflict → safe no-turn; panorama not authoritative | unit + existing conflict exit |
| Unusable sources classified separately | missing compass/panorama tests |
| Recorded scenarios without wrong-direction leakage | McD / Main / Xi’an-style compass↔visual fixtures |

## Verdict

Field conflicts are **correct fail-closed behavior**. Instrumentation gap closed locally. Do not widen 45° without Safety Gate review. Publication requires approval.
