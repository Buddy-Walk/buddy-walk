# Mobile contributor guide

Start with the native entry point, [App.tsx](../App.tsx), then the [navigation stack](../src/navigation/index.tsx). Navigation loads the saved onboarding state and decides whether to show sign-in, permissions, the waiver, name entry, or the main screen. [authSession.tsx](../src/navigation/authSession.tsx) owns the shared authentication state.

Function comments explain purpose, important inputs, asynchronous ownership, and fallbacks. Short callbacks have nearby comments describing their part in the enclosing operation. Existing Mykael-authored functions and tests were excluded from the commenting pass.

## Native capture and questions

[MainScreen.tsx](../src/screens/MainScreen.tsx) coordinates photo/video capture, microphone input, GPS and heading subscriptions, question submission, answer playback, and Last Meters. Its refs let asynchronous callbacks read current state without relying on an old React render. Request cancellation and generation checks prevent an obsolete request from replacing the current answer.

Follow ordinary questions through [api/openAi.ts](../src/api/openAi.ts) into the mobile API's [AI controller](../server/controllers/openAI.ts) and [OpenAI service](../server/services/openAI.ts). [api/client.ts](../src/api/client.ts) resolves backend origins; [apiHosts.ts](../src/config/apiHosts.ts) protects production traffic from retired hosts. Image/video and text questions can use different feature instructions and token budgets.

[audioSession.ts](../src/utils/audioSession.ts) serializes microphone/playback mode changes. [announce.ts](../src/utils/announce.ts) chooses between screen-reader announcements and app speech; [speakText.ts](../src/utils/speakText.ts) owns cancellable answer playback. These separate transient status cues from content that the user may need to hear again.

## Last Meters evidence

The active endpoint is registered in [server/index.ts](../server/index.ts), validated by the AI controller, and handled by `OpenAIService.lastMileRequest`. [services/lastMile.ts](../server/services/lastMile.ts) contains the older visual-comparison service; it is separate from that active handler.

The photo's original position, heading, timestamps, and north reference travel with the request. [lastMileSafety.ts](../src/utils/lastMileSafety.ts) checks missing/stale evidence, movement, rotation, and GPS uncertainty. The phone checks current sensors again before speaking a turn. Missing readings must remain missing.

The service resolves a nearby destination and collects map, walking-route, building-entrance, compass, and visual evidence. [lastMilePolicy.ts](../server/utils/lastMilePolicy.ts) determines whether that evidence supports a precise turn. [lastMileNavigation.ts](../server/utils/lastMileNavigation.ts) formats results and handles heading comparisons, distance, imagery age, and close-range uncertainty. See the [safety policy](last-meters-safety-policy.md) for the requirements.

[outdoorPanoramaSelection.ts](../server/services/outdoorPanoramaSelection.ts) bounds metadata probes, distinct candidate IDs, and elapsed time. It validates preview images and rejects indoor or uncertain scenes. `processPanoramaTiles` downloads the required headings from the selected panorama ID; `buildPanoramaDebugImage` labels and combines them for review.

A sensor-blocked destination request returns its withheld-turn explanation before fetching review imagery. `saveBackgroundPanorama` later attaches validated imagery or a download-failure status to that same trial. Background imagery remains review evidence and cannot authorize a turn. Requests parsed as ordinary questions follow Q&A instead of downloading a panorama.

## Other mobile features and storage

| Feature | Start here | Supporting code |
| --- | --- | --- |
| Walking navigation | [useTurnByTurnNavigation.ts](../src/hooks/useTurnByTurnNavigation.ts) | [navigationMath.ts](../src/utils/navigationMath.ts), [parseSteps.ts](../src/utils/parseSteps.ts), [hapticPatterns.ts](../src/utils/hapticPatterns.ts) |
| Saved destinations | [SavedPlacesScreen.tsx](../src/screens/SavedPlacesScreen.tsx) | [savedPlaces.ts](../src/utils/savedPlaces.ts) handles local persistence and alias expansion |
| Companion sharing | [CompanionScreen.tsx](../src/screens/CompanionScreen.tsx) | [api/companion.ts](../src/api/companion.ts), [server/services/companion.ts](../server/services/companion.ts) |
| Usage and feedback | [api/telemetry.ts](../src/api/telemetry.ts), [FeedbackModal.tsx](../src/components/FeedbackModal.tsx) | Mobile API controllers, services, and Mongo models |

[serverMode.ts](../server/config/serverMode.ts) selects local services or the upstream proxy from available credentials. [usageStore.ts](../server/database/usageStore.ts) provides bounded process-local buffers when Mongo is unavailable; that fallback is lost when the process restarts. Companion sessions use their own expiring fallback store.

Retry integration belongs to Mykael's [PR #35](https://github.com/Justraymond99/buddy_walk/pull/35). Existing integration comments identify the intended route/controller, trial provenance, and pipeline seams. The documentation pass preserves his implementation and branch.

## Checks and testing tools

From `mobile/`, run:

```sh
npm run typecheck
npm run typecheck:server
npm test
```

When the test runner cannot create its CLI IPC socket in a restricted environment, use the same suite through Node's loader:

```sh
node --import tsx src/test/runAll.test.ts
```

The [test runner](../src/test/runAll.test.ts) imports the regression suites. Capture/pipeline tests stub external services and assert evidence, timing, and withheld-turn behavior. Physical camera, compass calibration, audio routing, and VoiceOver behavior still need device testing.

The Python files at the mobile root generate testing workbooks/slides or patch collected testing templates. Their functions are documented without running artifact generation during this pass.

Browser-only pages, adapters, and client components are outside this native-mobile documentation scope. Native adapters with a `web` prefix still provide platform-resolution stubs and are documented where applicable.
