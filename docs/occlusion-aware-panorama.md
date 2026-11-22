# Experimental entrance assessment

## Configuration

Set `LAST_METERS_OCCLUSION_AWARE=true` on the mobile backend to enable entrance assessment. The default is disabled. The app and dashboard retries use the server setting. The request body cannot enable the experiment.

## Matching and fallback

After destination verification and the proximity gate, the server compares the current photo with a selected outdoor panorama and looks for the verified business in that panorama. When the compass checks allow matching to continue, a structured assessment examines the doorway independently in both sources.

| Doorway state | Interpretation for that image |
| --- | --- |
| `VISIBLE` | The identifiable door of the verified business is visible. |
| `OCCLUDED` | An obstruction prevents inspection of the likely entrance area. |
| `NOT_VISIBLE` | No matching entrance can be found. |
| `UNCERTAIN` | Evidence is missing, ambiguous or contradictory. Malformed model output receives this classification. |

Verification requires a map-consistent storefront match, a visible door in both images, matching doorway geometry, and a door heading consistent with the mapped entrance. A sign alone supplies storefront evidence. A blocked or missing door in the current photo, or an incompatible entrance layout, prevents a later camera from restoring verification.

The search shares one 45-second deadline and examines at most three distinct camera IDs, including rejected cameras. Each experimental vision call for current-view matching, destination matching or entrance assessment also has an eight-second cap. A dashboard retry pinned to the original camera stays pinned. Alternative cameras are nearby viewpoints. The system does not retrieve historical capture periods. Historical imagery alone cannot verify the present doorway.

When a door is verified at a camera offset from the user and the current view cannot be matched there, the search may try another camera. If that attempt yields no suitable alternative, the Trial can retain the earlier verified camera and its evidence. A contradictory current photo, compass conflict, expired deadline or service failure prevents a precise turn. The device heading, GPS, movement, confidence and walking-route checks continue to govern guidance.

The vision module builds the labeled photo and panorama request and parses the model reply. The assessment tracks evidence across cameras for one Trial. Both matching and assessment use the same search budget.

## Trial diagnostics

The existing `entrance_assessment` step records the original camera ID and date, examined cameras, per-camera observations, selected entrance evidence, failure reason and additional request count. The panorama validation audit and per-camera steps retain all attempts. The selected camera's photo, metadata, heading comparison and destination evidence are saved together. The step duration covers matching and fallback after the initial panorama download.

`additionalApiRequests` counts initiated entrance assessment requests and alternative-camera metadata, preview, scene classification, tile and matching requests. It excludes initial camera acquisition and the first ordinary current-view and destination matches. An initiated request counts even when it fails. A request that misses the deadline before starting contributes zero.

An exhausted visual search with an unverified door returns `turn_withheld` with `entrance_not_visually_confirmed`. A deadline or backend failure produces a failed Trial with its stage and a sanitized diagnostic. A recorded `PANORAMA_SEARCH_DEADLINE` identifies the shared deadline. The deadline excludes subsequent route checks, guidance generation and persistence. Older step payloads remain part of their original Trial. A retry assesses the current inputs again.

## Field limits

Door visibility alone cannot establish accessibility, opening hours or a safe route. Repeated storefronts, viewpoint offsets, construction and changes since Street View capture can affect the model's classifications. Estimating missed doors, false verification and latency requires labeled field Trials with representative phones, locations and network conditions.
