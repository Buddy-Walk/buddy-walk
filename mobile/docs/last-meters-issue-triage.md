# Last Meters Issue Triage - 2026-10-11

## Medium Issues

| Issue | Implementation status | Remaining verification or work |
| --- | --- | --- |
| #32 Close-range aligned wording | Complete: acknowledges compass/map alignment without claiming GPS proves the door is ahead; aligned and opposite Citi fixtures covered. | Field confirmation remains part of #31. |
| #30 Skip very old destination reference | Complete: skips Step 2B over eight years, logs stale_imagery, still runs Step 2C. Integration tests cover stale and recent imagery. | Collect Step 2C field performance under #31; do not automatically disable close-ups. |
| #26 Alternate panorama | Main matching now retries distinct nearby panoramas after a visual miss, bounded by shared three-candidate / time limits. First-fails/second-succeeds integration fixture passes. | Field consistency and wrong-entrance-rate acceptance remain unverified. Candidates are discovered by bounded offset probes, not a comprehensive newest-first imagery inventory. |
| #28 Parallel vision and logging | Steps 1/2 and 2B/2C run concurrently. Conflict still withholds a turn. Step 1/2 durations are persisted. | Keep durable log saving on the response path until a persistent queue exists; no unmeasured claim of a two-second median improvement. Full end-to-end timing still belongs to #27. |
| #29 Prefetch and smaller upload | Not implemented in this change. Automatic speculative API spending has not been enabled. | Decide opt-in behavior, implement bounded cancellation/cache and device resize, then measure uploads and latency on a device. A mobile build would be needed. |
| #31 October field retest | Still relevant and open. | Human outcome scoring, location walks, and October rates cannot be replaced by mocked unit/integration tests. |

No remaining open issue authored by Justraymond99 was identified as obsolete. Close completed fixes, not unresolved measurement or implementation work. Other contributors' issues and pull requests are not closed by this triage.

## Remaining Algorithm Risks

1. Low confidence still appends a caution after a precise turn; it must gate the turn itself.
2. A panorama camera's bearing is not necessarily the user's bearing to the destination. Keep camera-origin visual evidence separate from phone-origin guidance.
3. The visual-target reconciliation still accepts differences up to 90 degrees and replaces the visual heading with the map heading. This can conceal false matches.
4. Captured GPS/heading need timestamps, north-reference metadata, freshness checks, and motion detection before delayed guidance is spoken.
5. GPS error currently widens exact mode. Higher uncertainty should instead reduce precision or require recapture.
6. A verified business pin does not prove a usable entrance or pedestrian route. Nearby chain-branch ambiguity and accessible entrances need explicit handling.
7. Vision confidence is heuristic, not calibrated correctness probability. Versioned replay, held-out field outcomes, and wrong-turn / wrong-entrance rates remain essential.

The outdoor scene check and sixteen sectors improve reference selection and angular sampling; neither makes guidance guaranteed or independently safe.
