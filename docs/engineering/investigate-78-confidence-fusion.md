# #78 — `confidence_not_high` / confidence fusion (local)

**Branch:** `investigate/78-confidence-fusion`  
**Status:** LOCAL COMPLETE — provenance + tests; no push/PR without approval

## Fusion rule

`additive_independent_evidence_with_heading_conflict_cap`

- Base 0.15; independent evidence slots add deltas.
- Destination visual and Street View reference share one slot (no double-count).
- Compass↔panorama conflict caps score at `LAST_METERS_HEADING_CONFLICT_MAX_SCORE` (0.5).
- High threshold remains **0.75**. Do not lower without Safety Gate review.

## Diagnostics

`calculateLastMetersConfidence(...).fusion` records components, provenance, combination rule, thresholds, raw vs final score, and hard-gate hints (`heading_sources_disagree`, `orientation_not_corroborated`). Persisted on Trial as `confidenceFusion`.

## Verdict

Low-confidence withhold with co-occurring orientation/bearing gates is correct fail-closed behavior. Provenance gap closed locally. Publication requires approval.
