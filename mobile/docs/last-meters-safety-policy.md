# Last Meters safety-gated pipeline

Version: `3.0.0-safety-gated`.

## Six changes

1. Precise turns require high heuristic confidence and all independent checks. A warning after a turn is not a substitute for withholding it.
2. Panorama target headings remain camera-origin evidence. Turn geometry uses the phone location to the mapped destination entrance.
3. Visual matches must agree within one 22.5-degree panorama sector. Preserve the observed sector instead of replacing it with the expected map heading.
4. Capture timestamps, true-north headings and position snapshots travel with the photo. The phone checks its live sensors again before speaking the answer.
5. Ambiguous nearby branches prompt for an address. Precise turns require a mapped entrance and a compatible walking route. Straight-line distance is not a walking route.
6. Trials record pipeline/commit provenance and versioned original inputs. Stored replay lineage remains available for audit and Mykael's pending retry integration.

## Conservative limits

- Photo: at most 60 seconds old. Capture GPS within 10 seconds and heading within 5 seconds of the photo.
- Latest GPS/heading: at most 15 seconds old at request receipt; checked against live readings again on the phone before speech.
- More than 5 meters of measured displacement or 15 degrees of rotation requires recapture.
- True north, compass accuracy level 3, and GPS accuracy at most 20 meters are required for precise turns.
- Exact mode requires distance plus reported GPS uncertainty to fit within 250 meters. Bearing uncertainty must also fit within 22.5 degrees.
- Walking-route endpoints must be within 25 meters of the requested endpoints. Reject nonwalking routes, incompatible initial bearings and long detours.

These are conservative engineering thresholds, not calibrated success probabilities or accessibility certification. GPS jitter may cause retakes. Many storefronts lack mapped entrances and will correctly withhold precise turns. Street View is historical; outdoor classification and vision matches can still be wrong. No path-clearance or safe-crossing claim is made.

## Review and retry integration

The internal trial detail shows safety reasons, route evidence, pipeline version, commit, phone-origin bearing and camera-origin visual bearing. Explicit reviewer outcomes determine field-success rates; legacy pass/fail labels are not silently converted into outcomes. Wrong-turn and wrong-entrance rates have separate scored denominators. Replays are excluded.

`GET /api/last-mile-tests/evaluation` groups by pipeline version, UTC week and destination address. It is a bounded sample (default 1000, maximum 5000), not an unlimited all-time report.

The duplicate `POST /api/last-mile-tests/:id/replay` endpoint, replay assessment, and “Run replay” controls from Raymond's commit `816ddd0` have been removed. Mykael owns the replacement retry workflow in [PR #35](https://github.com/Justraymond99/buddy_walk/pull/35), branch `mykael-dashboard-retry-test`, which uses `POST /api/last-mile-tests/:id/retry`.

Integration comments mark the route, controller/detail response, dashboard action/click handler, and pipeline entry point. The `replayInput` schema, original photo hash, `runKind`/`retryOf` fields, and exclusion of historical replays from field metrics are retained so stored records and Mykael's work remain compatible. The mobile entry point evaluates sensor freshness at the actual request time; Mykael's separate retry pipeline can consume the stored snapshot without altering the original trial.

## Rollout and field verification

The updated mobile client must supply capture metadata. Older clients receive a withheld-turn response rather than guessed timestamps. The response now explicitly asks for an app update when that metadata is missing. No TestFlight build is created as part of this change.

Sensor-blocked mobile trials with valid reported coordinates now save a validated outdoor panorama in the background for review. The panorama uses the reported request location; it does not establish the traveler's current position or authorize a turn. Download or validation failures are attached to the trial. Questions routed from older mobile clients go to Q&A before turn-sensor checks.

The native app sends the original capture metadata even when sensors are insufficient, so the API can record the actual failure and save review imagery. It still requires a valid capture location before submitting and rechecks live sensors before speaking a turn. Explicitly withheld answers remain audible when live sensors are unavailable. Ship the mobile update and mobile API changes together to get the complete capture behavior.

For mobile retesting, use an older request without `sensors` and a current capture with stale timestamps, poor GPS, a missing heading, and rotation after capture. Each should withhold a turn, state the specific recovery action, and save either a review panorama or its failure reason. A fully verified fresh capture should still provide a turn; movement during processing must suppress it. Repeat the reported angled-photo case on a physical iPhone and compare its recorded compass and visual headings before attributing it to photo angle.

Automated tests mock providers. Before claiming improved field accuracy, repeat supervised trials across four facing directions, destination behind the user, indoor-image rejection, offset panorama cameras, similarly named nearby branches, stale photos, poor GPS, movement during processing, blocked entrances and route detours. Record actual participant outcomes, not just successful API responses.
