# Buddy Walk

Buddy Walk helps blind and low-vision pedestrians get where they are going.
This glossary covers the whole product: the web app, the mobile app, and their servers.

## Language

**Question**:
Free-form voice or text input, optionally with a photo or video, that Buddy Walk answers from the user's location, chat history, and outside data such as trains, Doorfront, nearby features, or directions.
A directions Question with an attached photo or video is still a Question, not a Last Meters request.
_Avoid_: Assistant, chat, text request

**Verified destination**:
A place Buddy Walk has confirmed exists within walking range of the user.
It is the only kind of destination Buddy Walk will give directions or Last Meters guidance to.
_Avoid_: Destination lookup result, place match

**Entrance assessment**:
A Last Meters check that examines the doorway in one selected Street View panorama and in the user's current photo. It records storefront identity and doorway visibility separately for each camera.

**Entrance verification**:
Confirmation that the verified destination's identifiable door is visible in both sources, that the doorway geometry matches, and that its panorama heading agrees with the mapped entrance. The Trial records this as `entranceVerified`. A storefront sign alone supplies only identity evidence. Older imagery cannot confirm the current entrance. Visibility alone cannot establish that a door is accessible or that a walking route is safe.

**Occlusion**:
An obstruction, such as scaffolding or a vehicle, that prevents inspection of the likely entrance area in an image. The presence of a door behind it remains unknown.

**Current-view and destination matching**:
Current-view matching (B) compares the user's photo with panorama views. Destination matching (C) locates the verified business in those views and compares its heading with the map. The device compass supplies the user's heading for a turn. Panorama matching cannot supply a missing or invalid compass heading.

**Last Meters**:
Guidance that takes a user standing near a destination the final stretch to its door, using their photo, GPS, compass, and Street View panoramas to produce a turn instruction.
_Avoid_: Last mile

**Trial**:
One recorded Last Meters run, from the app or replayed from the Team console, with the evidence gathered, each step taken, and the answer given.
The team reviews and retries Trials on the Team console.
_Avoid_: Test log record, field test, last mile test

**Team console**:
The internal site where the team reviews and retries Trials and checks usage.
Only team members can reach it.
_Avoid_: Dashboard, test app, admin page
