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

**Last Meters**:
Guidance that takes a user standing near a destination the final stretch to its door, using their photo, GPS, compass, and Street View panoramas to produce a turn instruction.
_Avoid_: Last mile

**Trial**:
One recorded Last Meters run, from the app or replayed from the dashboard, with the evidence gathered, each step taken, and the answer given.
The team reviews and retries Trials on the dashboard.
_Avoid_: Test log record, field test, last mile test
