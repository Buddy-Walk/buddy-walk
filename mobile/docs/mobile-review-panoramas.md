# Mobile Last Meters guidance and panoramas

The Expo app and `mobile/server` deploy separately. An iOS submission does not deploy API changes. Check the running mobile field policy with:

```sh
curl https://buddy-walk-api.onrender.com/api/last-mile/review-status
```

Version `2.0.0` identifies the guidance correction. The response also reports the exact deployed commit and whether the server has the provider configuration required for local Last Meters.

## Why unchanged field tests began failing

Commit `816ddd0` on October 11 added an initial sensor gate before place lookup, Street View download, or photo matching. One missing timestamp, a 5-meter location difference, or GPS uncertainty could stop the entire feature. Its final gate also required Google's optional entrance listing, maximum compass accuracy, high heuristic confidence, and a verified walking route together. Many ordinary storefront captures could never reach the final guidance model.

The original checks also aged the capture during server processing. A fresh submission could become stale while awaiting an API response. The client then applied the same turn requirements to descriptive answers, hiding useful destination information.

Version `1.0.0` added background review panoramas after the initial refusal. It did not restore guidance generation. Version `2.0.0` replaces that adapter with complete field analysis before turn-only checks.

## Mobile field behavior

- Photo matching and validated outdoor panorama downloads run even when sensor metadata is imperfect. Submitted coordinates, timestamps, headings, and replay inputs are preserved.
- A visually confirmed destination does not need an additional Google entrance listing. Medium compass calibration and medium heuristic confidence can support a turn when the independent photo, compass, target, GPS geometry, and remaining sensor checks agree.
- Turning in place does not require a walking route. When route verification is unavailable or fails, the answer explicitly describes orientation only and does not authorize walking. Existing landmark prompts prohibit walking and street-crossing instructions.
- GPS displacement within the root-sum-square of the two reported accuracy radii is treated as uncertainty rather than proven movement. The separate GPS quality and bearing-uncertainty requirements still apply to precise turns.
- The original compass reading remains the independent check for photo matching. A fresh, real true-north heading at submission controls the final turn, so turning the phone after capture does not invalidate an otherwise useful photo. The returned `currentHeading` identifies the heading used for that instruction; the native app compares it with live readings before speaking.
- Missing metadata, real displacement, poor photo matching, conflicting capture headings, and unreliable bearing geometry still prevent precise turns. The answer retains the verified destination, address, and capture-relative distance when available. A further rotation while the API is processing still triggers a fresh-photo request before speaking a precise turn.
- Capture freshness is evaluated at request receipt. The updated app checks current position and orientation again before speaking an actual turn, without counting processing time against the original capture. Descriptive answers remain available when a turn cannot be given.

The existing shared pipeline version remains unchanged. The trial's `mobile_guidance_policy` step records version `2.0.0`, alongside the deployed commit, so reviewers can distinguish field behavior from the shared engine version.

## Contributor boundaries and release

Mykael's retry files, invocation options, snapshots, pinned panorama handling, and tests are unchanged. The shared service defaults to its original strict policy. The mobile subclass also selects that original policy whenever retry or pinned options are supplied. The policy hooks replace only Raymond-authored checks and formatting lines; no Mykael-authored lines are removed or replaced.

The API deployment restores analysis and useful descriptive answers for existing mobile builds that send a capture to the server. The native update fixes the local early refusal and the response-time stale-capture check, so a new TestFlight build is needed for the complete correction. Historical trials are not modified or rerun.

The production EAS profile retains the prebuilt Sharp setting used by the previous successful iOS release. The mobile API Dockerfile and server TypeScript project explicitly include the new shared sensor helper.

## Validation

```sh
npm run typecheck
npm run typecheck:server
node --import tsx src/test/runAll.test.ts
```

The mobile integration fixtures execute the real pipeline for an ordinary storefront without an entrance listing, medium compass accuracy, an unavailable walking API, GPS jitter, long processing, movement, rotation, missing sensors, unavailable/indoor imagery, failed image matching, and conflicting headings. They assert that final guidance is actually generated when justified, factual results survive withheld turns, sensor evidence is unchanged, and retries/pinned runs retain their original early gate. All providers and storage are replaced with fixtures; tests create no production trials or paid requests.
