# Buddy Walk Last Meters Localization Algorithm

## Purpose

Guide a blind traveler to a verified destination using GPS, compass, Google Places, and the user's photo. The system must report uncertainty instead of pretending a weak reading is precise.

## Inputs

| Input | Source | Required use |
| --- | --- | --- |
| User photo | Phone camera | Describe nearby landmarks after the turn is known. |
| Latitude, longitude, and horizontal accuracy | Phone location sensor | Coarse location and GPS confidence. |
| Phone compass | Phone heading sensor | The only source allowed to control a turn instruction. |
| Destination name | User text | Resolve the correct nearby Google Place. |

## Pipeline

1. Resolve the destination with Google Places and rank candidates by relevance and distance from the user. Store the chosen place name, address, coordinates, and distance.
2. Run the approach gate. When the destination is beyond `LAST_METERS_EXACT_RADIUS_METERS` (currently 250 m), return rough compass/map guidance and do not run vision. Ask the traveler to try Last Meters again closer to the destination.
3. In exact mode, require a usable compass heading. Snap it to the nearest 45-degree increment.
4. If the destination bearing is reliable, compute the turn from the phone compass and the Google Maps bearing. If the traveler is already beside the building or GPS cannot tell which side the door is on, withhold the turn and give close-range copy instead.
5. Fuse GPS and compass into a confidence score. If confidence is low, ask the traveler to stop safely and take another photo before moving forward.
6. Use the user's photo only to name nearby landmarks after the turn or close-range instruction is already decided.

## Recovery Rules

| Failure | Response |
| --- | --- |
| Google Places cannot verify a local destination | Ask for a more specific destination or address. |
| Destination is too far away | Use rough approach guidance only; skip vision. |
| Compass missing | Do not calculate a turn. |
| Destination bearing is unreliable | Do not guess a turn. Ask the traveler to retake or ask someone nearby. |
| Low confidence | Do not treat the result as confirmed. Stop safely, recapture, and repeat the pipeline. |

## Evaluation Data

Every Last Meters trial stores the user photo, place information, GPS accuracy, individual test steps, compass heading, destination bearing, heading difference, confidence score, final guidance, and reviewer notes. Older trials may still include unused panorama fields; new trials do not download street-level imagery.
