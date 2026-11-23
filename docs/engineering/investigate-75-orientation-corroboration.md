# #75 — `orientation_not_corroborated` (local)

**Branch:** `investigate/75-orientation-corroborated`  
**Status:** LOCAL COMPLETE — diagnostics + tests; no push/PR without approval

## Decision table (v1)

| Source | Role | Required | Passes when |
| --- | --- | --- | --- |
| panorama_current_view_match | independent_visual | yes | `photoMatched === true` |
| compass_vs_panorama_heading | independent_sensor_cross_check | yes | `headingAgrees === true` |

Correlated duplicates (deriving heading agreement only from the photo match) are **not** independent corroboration.

## Diagnostics

`orientationCorroborationDiagnostics` reports each source as `pass` | `unavailable` | `conflicting` | `mismatched` | `correlated_duplicate`. Persisted on Trial via `orientationCorroboration`. Thresholds unchanged.

## Verdict

Fail-closed corroboration is correct safety behavior. Instrumentation + decision table documented. Publication requires approval.
