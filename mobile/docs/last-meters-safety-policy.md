# Last Meters safety-gated pipeline

Version: `3.0.0-safety-gated`.

## Six changes

1. Precise turns require high heuristic confidence and all independent checks. A warning after a turn is not a substitute for withholding it.
2. Panorama target headings remain camera-origin evidence. Turn geometry uses the phone location to the mapped destination entrance.
3. Visual matches must agree within one 22.5-degree panorama sector. Preserve the observed sector instead of replacing it with the expected map heading.
4. Capture timestamps, true-north headings and position snapshots travel with the photo. The phone checks its live sensors again before speaking the answer.
5. Ambiguous nearby branches prompt for an address. Precise turns require a mapped entrance and a compatible walking route. Straight-line distance is not a walking route.
6. Trials record pipeline/commit provenance and versioned replay inputs. Admin-triggered replays create separate trials, retain source IDs, and never count as field outcomes.

## Conservative limits

- Photo: at most 60 seconds old. Capture GPS within 10 seconds and heading within 5 seconds of the photo.
- Latest GPS/heading: at most 15 seconds old at request receipt; checked against live readings again on the phone before speech.
- More than 5 meters of measured displacement or 15 degrees of rotation requires recapture.
- True north, compass accuracy level 3, and GPS accuracy at most 20 meters are required for precise turns.
- Exact mode requires distance plus reported GPS uncertainty to fit within 250 meters. Bearing uncertainty must also fit within 22.5 degrees.
- Walking-route endpoints must be within 25 meters of the requested endpoints. Reject nonwalking routes, incompatible initial bearings and long detours.

These are conservative engineering thresholds, not calibrated success probabilities or accessibility certification. GPS jitter may cause retakes. Many storefronts lack mapped entrances and will correctly withhold precise turns. Street View is historical; outdoor classification and vision matches can still be wrong. No path-clearance or safe-crossing claim is made.

## Review and replay

The internal trial detail shows safety reasons, route evidence, pipeline version, commit, phone-origin bearing and camera-origin visual bearing. Explicit reviewer outcomes determine field-success rates; legacy pass/fail labels are not silently converted into outcomes. Wrong-turn and wrong-entrance rates have separate scored denominators. Replays are excluded.

`GET /api/last-mile-tests/evaluation` groups by pipeline version, UTC week and destination address. It is a bounded sample (default 1000, maximum 5000), not an unlimited all-time report.

`POST /api/last-mile-tests/:id/replay` requires a configured admin token and local provider credentials. It permits one active replay and three starts per minute per server process. The dashboard asks for confirmation because each replay can incur provider charges. Horizontal replicas would require a shared limiter before scaling this feature.

Replay uses the stored compressed user photo, original sensor timestamps evaluated relative to original request time, current code and fresh provider data. It is not a bit-for-bit reproduction, field test, or instruction for a person currently standing there. Legacy trials without original capture metadata cannot replay. No original trial is changed.

## Rollout and field verification

The updated mobile client must supply capture metadata. Older clients receive a withheld-turn response rather than guessed timestamps. No TestFlight build is created as part of this change.

Automated tests mock providers. Before claiming improved field accuracy, repeat supervised trials across four facing directions, destination behind the user, indoor-image rejection, offset panorama cameras, similarly named nearby branches, stale photos, poor GPS, movement during processing, blocked entrances and route detours. Record actual participant outcomes, not just successful API responses.
