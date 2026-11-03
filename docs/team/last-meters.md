# Last Meters

Guidance that takes a user standing near a Verified destination the final stretch to its door, using their photo, GPS, compass, and Street View panoramas to produce a turn instruction.

The pipeline is `LastMetersService.runLastMeters` in `mobile/server/services/lastMetersService.ts`.
Steps take inputs and return a result. `LastMetersTrial` owns the Trial being recorded (ADR 0002).
A step that ends the run early returns that exit; `runLastMeters` decides what happens next.

## Steps

1. **Pre-check and classify** — sensor freshness, then whether this input is Last Meters or a Question.
2. **Verified destination and entrance** — `verifyDestination` / `findEntrance` in `lastMetersDestination.ts`, including the nearby-branch check.
3. **Proximity gate** — aligned, approach, or exact. No outside calls (`lastMetersProximityGate.ts`).
4. **Panorama heading matching** — `startPanoramaSearch` then `matchPanoramaHeadings`: current view, destination, reference photo and sign text backups, next panorama.
5. **Turn decision** — confidence, walking route, guidance policy (`lastMetersTurnDecision.ts`).
6. **Compose guidance** — turn instruction, landmarks, final answer (`lastMetersGuidance.ts`).

If classification says this is a Question, the Last Meters handler hands it to `OpenAIQuestionService.textRequest`. The two pipelines share Verified destination lookup and no other new module.

## Panorama selection

`selectOutdoorPanorama` (`mobile/server/services/outdoorPanoramaSelection.ts`):

- Probe the user's point, then offsets around them.
- Street View metadata, radius 40, `source=outdoor`, Google copyright.
- Reject contributor photospheres (`metadata_rejected`).
- gpt-4o-mini outdoor classifier; 16 fov-22.5 tiles; 45 second budget; at most 3 panoramas.

On current `main`, after a rejected nearest panorama the search jumps to 30 m N/E/S/W.
[PR #45](https://github.com/Buddy-Walk/buddy-walk/pull/45) (open) inserts a 10 m ring after a photosphere at the user's position, then the 30 m ring. `destination_not_visible` and duplicates still go 30 m.

## Nearby branch

Another relevant candidate within destination distance + max(20, gpsAccuracy) withholds the turn as `destination_branch_ambiguous` *before* panorama search starts.

[PR #43](https://github.com/Buddy-Walk/buddy-walk/pull/43) (open) drops candidates at the Verified destination's own street address first (`candidatesAtOtherAddresses` in `nearbyPlaces.ts`). A store listed twice at 275 Greenwich St is one building. A branch on a different street still withholds.

## Client safety

The phone applies `mobileLastMetersGuidance` before and around the server answer: sensor freshness, withhold reasons, turn-only policy. Do not weaken that to make a Trial look successful.

## Dashboard and retries

Each run is a **Trial**. The team reviews and retries Trials on `/last-meters-tests`.
Retries replay the saved row; they must not write a new "live" Mongo retry path from a laptop.

Characterization of every exit: `mobile/src/test/lastMetersExits.test.ts` plus its snapshot.
Do not edit the snapshot, and do not edit Mykael's or Hanyuan's tests, to land a behavior change.

## More detail

- `mobile/docs/last-meters-localization-algorithm.md`
- `mobile/docs/last-meters-safety-policy.md`
- `mobile/docs/last-meters-issue-triage.md`
- `mobile/docs/mobile-review-panoramas.md`
- [Nov 2 briefing](nov2-panorama-fixes.md)
