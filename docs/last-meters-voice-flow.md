# Last Meters voice flow

A user can take a photo, say or type a destination, request Last Meters, and pause or replay the final answer. The mobile client uses a typed catalog for spoken messages. During a request it can announce module starts streamed by the backend, then give the final answer or Safety Gate recovery prompt priority over progress speech.

## Capture, destination and recovery

| Event | Trigger | Spoken text |
| --- | --- | --- |
| `capture_success` | The captured photo is available. | Photo captured. Speak or type the destination, then tap Last Meters for entrance guidance. Or Submit to ask about the photo. |
| `camera_starting` | The preview is still starting. | Camera is still starting. Try again in a moment. |
| `camera_busy` | Native still capture reports a busy camera. | Camera is still getting ready. Try again in a moment. |
| `capture_failed` | Still capture fails or supplies no usable image. | Could not capture image |
| `video_started` | Recording starts (accessibility announcement). | Video recording started |
| `video_ended` | A video is available. | Video recording ended. Ready to describe the video. |
| `video_mic_permission` | Recording permission is missing. | Microphone permission is required to record video. |
| `video_camera_unready` | Video recording reports an unready camera. | Camera not ready. Wait a second, then try again. |
| `video_failed` | Video capture fails. | Could not capture video |
| `missing_destination` | Last Meters is tapped with an empty destination. | Please enter the name of the store or destination first. |
| `missing_photo` | A destination was supplied without a photo. | Please take a photo of your surroundings first. |
| `answer_loading` | A transcript arrives while an answer is pending. | Still loading the last answer. Please wait. |
| `mic_while_loading` | The user activates the microphone while an answer is pending. | Still loading your last answer. Wait a moment, then try again. |
| `transcription_busy` | A new recording is requested during transcription. | Still transcribing your last question. Wait a moment. |
| `voice_unavailable` | The speech service token is unavailable. | Voice input is unavailable. Make sure the backend is running and try again. |
| `mic_permission` | Microphone permission is missing. | Microphone permission is required for voice questions. |
| `browser_mic_permission` | The browser returns no recording session. | Could not start microphone. Check browser permissions and try again. |
| `browser_mic_failed` | Starting browser capture throws. | Could not start microphone |
| `native_mic_failed` | Starting native capture throws. | Could not start microphone. Tap again in a moment. |
| `no_speech` | Recording ends before enough audio is available. | I didn't hear anything. Ask again. |
| `no_transcript` | Recognition returns no usable words. | I didn't catch that. Ask again. |
| `speech_service_error` | The speech service fails to transcribe. | Speech service error. Please try again. |
| `recognition_failed` | Recognition throws. | Voice recognition failed. Tap the voice button and speak again. |
| `recording_unreadable` | The native recording has no usable URI. | Could not read the recording. Please try again. |
| `offline` | Connectivity changes to offline. | No internet connection. |
| `new_test` | An explicit reset uses app TTS. | New test started. |
| `new_test_accessible` | An explicit reset uses native VoiceOver or TalkBack. | New test started. Previous question, answer, and AI memory cleared. |
| `destination_confirmed` | Voice supplies a destination with a photo attached. | Destination set to {destination}. Starting Last Meters. |
| `photo_transcript` | Voice supplies another kind of input with a photo attached. | Got {transcript}. Double-tap Last Meters for entrance guidance, or Submit to ask about the photo. |

Typing a destination provides no extra confirmation. Opening the microphone uses the existing haptic cue to keep its own audio out of the recording. Shared video capture cues are listed because the same camera controls produce them. Submitting a general question uses the separate Q&A flow.

## Request events

| Event | Trigger | Spoken text |
| --- | --- | --- |
| `initial_wait` | 1.5 s, still active without a module event. | Checking your photo and location. |
| `continued_wait` | 4.5 s, still active without a module event. | Analyzing your surroundings. Please wait. |
| `still_processing` | 9 s, still active, speech idle and no module announcement in the preceding 4.5 s. | Still checking your surroundings. Tap Last Meters again to cancel. |
| `cancelled` | The user taps Last Meters again during a request. | Last Meters cancelled. |
| `timeout` | The request ends with `ECONNABORTED`. | Last Meters took too long to answer. The server may be busy. Take a new photo and try again. |
| `error` | The request fails. | Last Meters error: {message} |
| `error` without detail | No error message is available. | Error calculating last meters navigation. Please try again. |
| `recapture_required` | The existing client sensor checks reject the capture or returned turn. | I cannot verify your current position and orientation well enough for a precise turn. Stay in a safe place, hold the phone steady, and take a new photo. Make sure the app is updated and precise location is enabled. |
| `safety_gate` | The server supplies safety reasons, a warning or a withheld result. | Recovery selected below, or the original backend output. |
| `navigation_result` | A response passes the existing client checks. | The backend output, verbatim. |

### Confirmed module starts

Only a request-scoped `{ type: "module_started", module }` event can select these lines. B and C can overlap. Two nearby start events can share a single utterance.

| Module | Meaning | Spoken text |
| --- | --- | --- |
| `preCheck` | Input and preliminary location/destination checks. | Checking your location and destination. |
| `currentViewMatch` | Matching the user’s view. | Matching your photo with nearby Street View images. |
| `destinationMatch` | Locating the destination in available imagery. | Locating your destination in the surrounding area. |
| `turnDecision` | Evaluating evidence for a direction. | Checking the reliability of your navigation directions. |
| `guidance` | Generating guidance. | Preparing your navigation instructions. |

### Safety Gate selection

`getSafetyGateVoicePrompt` owns all Safety Gate wording and reason ordering. It considers recognized reasons and the warning, removes duplicates, and first looks for `destination_branch_ambiguous`, `current_gps_unavailable`, then `gps_uncertain`. Several other recognized reasons together select one recovery line. Unknown codes alone preserve the backend output. The original response stays visible when a speech override is selected.

| Reason | Existing spoken recovery |
| --- | --- |
| `bearing_uncertainty_too_large` | I cannot reliably determine the direction to the destination. Stay in a safe place and wait for a more accurate location reading before trying again. |
| `destination_branch_ambiguous` | I found more than one possible destination. Please enter a more specific store name or street address. |
| `capture_metadata_missing` | I could not link this photo to its location and direction readings. Stay in a safe place and take a new photo. |
| `moved_since_capture` | Your reported position changed after the photo. Stay in a safe place and take a new photo before following a turn. |
| `turned_since_capture` | Your phone's direction changed after the photo. Stay in a safe place, hold the phone steady, and take a new photo. |
| `gps_uncertain` | Your location is not accurate enough for a precise turn. Stay in a safe place and wait for a more accurate reading before trying again. |
| `current_heading_unavailable` | I do not have a usable phone direction. Stay in a safe place and wait for the compass to update before trying again. |
| `heading_sources_disagree` | Your phone compass and the photo-based direction disagree. Stay in a safe place, recheck the phone's direction, and take a new photo. |
| `orientation_not_corroborated` | I could not confirm the phone's direction from this view. Stay in a safe place and take a clear, current photo. |
| `entrance_not_visually_confirmed` | I found the destination on the map, but could not confirm its entrance. Use your primary navigation or ask for assistance. |
| `capture_gps_stale` | The location reading linked to this photo is out of date. Stay in a safe place, wait for a fresh location reading, and take a new photo. |
| `confidence_not_high` | I do not have enough reliable information for a precise turn. Stay in a safe place and take a clear, current photo. |
| `current_gps_unavailable` | Your current location is unavailable. Stay in a safe place, wait for a fresh location reading, and try again. |
| Multiple remaining recognized reasons | I could not confirm your current direction. Stay in a safe place and take a new photo before following a turn. |

## Priority, cancellation and replay

1. A validated answer, Safety Gate response or client recapture message takes ownership of playback immediately. Only one terminal response is presented per request.
2. Cancellation, timeout and terminal errors stop pending and active progress. The Cancel button aborts the request and announces cancellation once. Leaving the main screen, unmounting, resetting or replacing the capture silently cancels the active request.
3. A genuine module start can replace this request’s generic waiting speech. Each module is considered once per request. A 120 ms window combines concurrent B/C starts or replaces a superseded pending start. Busy content or module speech wins over a new module announcement.
4. The three generic hints use the existing waiting timer. Busy speech or a pending module suppresses the hint. The long reminder also yields to recently spoken module feedback.

Input and reset events use the existing accessibility status routing. A native screen reader gets the longer New Test confirmation once. App TTS supplies the short version otherwise. Optional request progress uses idle device TTS. Answers and recovery content use app TTS so Stop, Replay and VoiceOver’s Magic Tap control the selected response. Replay reads the saved final speech (including a terminal error shown as the response). It never reads a waiting or module event. A cancelled run cannot replace the replay target.

## Progress transport and deployment

This PR adds progress streaming to the Last Meters endpoint and its mobile client. When the client requests `application/x-ndjson`, the backend streams a `module_started` event for each module it enters, followed by a `result` event carrying the final status and body. B and C can start concurrently. Skipped modules produce no events.

Live module prompts require deploying the streaming backend and using a client that reads the stream. With a JSON-only backend, the client can still speak its timed waiting hints and the final response. Only a module-start event triggers a module prompt.
