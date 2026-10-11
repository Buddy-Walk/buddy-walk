# Buddy Walk Last Meters Localization Algorithm

## Purpose

Use visual localization only when a blind traveler is close enough to a verified destination. The system combines GPS, compass, Street View, the user's photo, and a destination name. It must report uncertainty instead of pretending a weak match is precise.

## Inputs

| Input | Source | Required use |
| --- | --- | --- |
| User photo | Phone camera | Match the traveler’s view to Street View. |
| Latitude, longitude, and horizontal accuracy | Phone location sensor | Coarse location and GPS confidence. |
| Phone compass | Phone heading sensor | The only source allowed to control a turn instruction. |
| Destination name | User text | Resolve the correct nearby Google Place. |
| Sixteen Street View views | Google Street View | 360-degree visual comparison at 22.5-degree intervals. |

## Pipeline

1. Resolve the destination with Google Places and rank candidates by relevance and distance from the user. Store the chosen place name, address, coordinates, and distance.
2. Run the approach gate. When the destination is beyond `LAST_METERS_EXACT_RADIUS_METERS` (currently 250 m), return rough compass/map guidance without waiting for vision. A review-only panorama can still be validated and saved in the background. Ask the traveler to try Last Meters again closer to the destination.
3. In exact mode, retrieve sixteen non-overlapping Street View images centered at 0 through 337.5 degrees in 22.5-degree increments, each with a 22.5-degree horizontal field of view. Select metadata with `source=outdoor`, require Google attribution and valid camera coordinates and panorama ID, then use that same ID for all tiles. Never fall back to an unrestricted location image. Store the panorama date and coordinates. The review grid has four rows of four labeled views, including decimal headings.
4. Independently match the user photo to the sixteen panorama views. Record the panorama heading only as visual evidence; it must never replace the phone compass. More sectors improve angular sampling, not guaranteed real-world localization accuracy. Ambiguous matches and indoor scenes must return NOT_VISIBLE.
5. Compare the snapped compass heading to the panorama heading. Agreement within 45 degrees increases confidence; disagreement lowers confidence and is saved for evaluation.
6. Independently locate the destination in the panorama. Steps 1 and 2 run concurrently; a compass conflict discards Step 2's result. If the destination is not visible, destination-reference and sign close-up checks run concurrently within 75 m. Skip the reference check for panoramas older than `LAST_MILE_REFERENCE_MAX_AGE_YEARS` (8), but retain sign close-ups and the separate three-year confidence penalty.
7. Compute the turn using the phone compass heading and the verified target heading. Express the result as left, right, forward, or turn around.
8. Fuse evidence into a confidence score. GPS accuracy, user-photo panorama match, compass/panorama agreement, and destination verification each contribute evidence. If confidence is low, ask the traveler to stop safely and take another photo before moving forward.

## Recovery Rules

### Outdoor Validation

Before downloading the sixteen matching tiles, inspect four 90-degree views of each candidate with the visual model. Classify the camera surroundings as OUTDOOR, INDOOR, or UNCERTAIN. Only an exact OUTDOOR result passes; malformed responses, API failures, and uncertainty fail closed. Windows showing a street from inside a restaurant or subway station do not count as outdoor surroundings.

Search the original position and four points offset 30 m north/east/south/west, with a 40 m metadata search radius. Evaluate at most three distinct eligible panorama IDs, reject cameras farther than 75 m from the requested location, and skip duplicate IDs. Selection has a 45-second budget, individual network/classifier calls are capped at 10 seconds, and classifier SDK retries are disabled. A successful first candidate adds four preview requests and one classification call. Matching-tile downloads have their existing separate timeout.

Destination-reference selection uses the same validation gate; sign close-ups reuse the already validated main panorama ID. In exact mode, exhaustion of the main panorama search withholds precise turns and entrance directions. Approach/aligned responses remain map/compass-only and do not depend on the background panorama.

If an outdoor panorama passes scene validation but fails destination matching, try a distinct nearby panorama within the same main-search budget. At most three main candidates are evaluated in total, including rejected indoor candidates. Each matched-view and target-match step records its panorama ID. The dashboard uses the last attempt for module summaries. Source dates and per-step durations remain in the log; parallel durations must not be summed as wall-clock latency.

At close range inside GPS uncertainty, compass/map agreement changes the wording but never proves the door is directly ahead. Keep the user's orientation without inventing a turn, and explicitly say that the entrance is unconfirmed.

This is a model-based safeguard, not a guarantee of scene classification accuracy. Field-test the nine comparison cases, especially the misclassified interior in Case 3, before deployment.

| Failure | Response |
| --- | --- |
| Google Places cannot verify a local destination | Ask for a more specific destination or address. |
| Destination is too far away | Use rough approach guidance only; skip vision. |
| User photo cannot match panorama | Continue only with the compass; lower confidence. |
| Compass missing | Do not calculate a turn. Capture the panorama result for research only. |
| No panorama passes outdoor validation | Withhold precise turns and entrance directions; report uncertainty. |
| Destination missing from panorama | Use destination reference only in the close range; otherwise guide the traveler closer and repeat. |
| Low confidence | Do not treat the result as confirmed. Stop safely, recapture, and repeat the pipeline. |

## Evaluation Data

Every Last Meters trial stores the user photo, panorama, place information, GPS accuracy, individual test steps, compass heading, panorama heading, heading difference, confidence score, final guidance, and reviewer notes. The dashboard and CSV export make it possible to compare compass and panorama localization separately.

`panoramaValidation` stores candidate IDs, approximate camera distances, acceptance/rejection reasons, duplicates, and validation errors. It is included in the dashboard, CSV export, and background review updates. Render logs use the `[panorama-validation]` prefix and exclude raw provider errors and credentials.
