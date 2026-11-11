# Buddy Walk

Buddy Walk helps blind and low-vision pedestrians get where they are going.
This glossary covers the whole product: the web app, the mobile apps, and their servers.

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
Guidance that takes a user from where their own map app left them, on the right street near a Verified destination, to that destination's door.
The current app and Live Feedback Preview are two different ways of giving it.
_Avoid_: Last mile, beta guidance

**Team console**:
The internal site where the team reviews and retries Trials and checks usage.
Only team members can reach it.
_Avoid_: Dashboard, test app, admin page

## Live Feedback Preview

**Live Feedback Preview**:
A separate testing-ground app that gives Last Meters guidance from live camera feedback instead of a single photo.
It exists to find out whether this approach is more helpful than the current app; what works moves into the main app, and the Preview then retires.
_Avoid_: Beta, Labs, the beta app

**Destination brief**:
Everything the phone needs to know about a Verified destination to run Last Meters on its own: its side of the street, street number, name variants, and its neighbouring businesses.
_Avoid_: Destination payload, place data

**Scan**:
One stretch of the user panning the phone from one spot while the camera reads text.
_Avoid_: Sweep, capture, photo

**Reading**:
One piece of text the camera recognised during a Scan, such as "34", "Joe's Pizza", or "OPEN".
_Avoid_: OCR result, detection

**Match**:
A Reading tied to the Destination brief: the destination's own name, a street number, or a neighbouring business.
The Matches in a Trial are its evidence.
_Avoid_: Hit, evidence item

**Guided turn**:
A turn that starts with a coarse spoken word ("turn to your right", "turn around") and ends on a stop cue when the user faces the right way, with a continuous haptic or audio cue in between.
Live Feedback Preview never speaks degrees or clock positions.
_Avoid_: Turn instruction, bearing, heading

**Bounded walk**:
Walking the user along the same sidewalk toward a direction established by a Match, rescanning at each doorway, up to a set distance.
Without a Match there is no Bounded walk.
_Avoid_: Probe walk, search walk

**Scene description**:
A short spoken account of what is around the user, made by an AI model from the camera frames when the user asks for one.
It describes and never directs: a possible sighting of the destination only starts a Guided turn and a Scan to check it.
_Avoid_: AI description, scene summary, image caption

## Trials and testing

**Trial**:
One recorded Last Meters run, from an app or replayed from the Team console, with the evidence gathered, each step taken, and the answer given.
The team reviews and retries Trials on the Team console.
_Avoid_: Test log record, last mile test

**Field test**:
A Trial run through an app on a real street, as opposed to a retry replayed from the Team console.
Every Live Feedback Preview Trial is a Field test, and each is one of three kinds: Sighted test, Blindfolded test, or User test.
_Avoid_: Street test, live test

**Sighted test**:
A Field test run by a sighted tester with their eyes open, checking whether the guidance is correct.
Its Outcome means the guidance would have got a user there, not that it is intuitive without sight.
_Avoid_: Eyes-open test, internal test

**Blindfolded test**:
A Field test run by a blindfolded sighted tester with a chaperone, to catch problems early without sight.
It does not show whether the app suits blind users, who bring skills a blindfolded tester lacks.
_Avoid_: Eyes-closed test, simulated blind test

**User test**:
A Field test run by a blind or low-vision tester, judging whether the guidance is intuitive for the people Buddy Walk is for.
_Avoid_: Blind test, accessibility test

**Outcome**:
How a Field test ended for the person who ran it: Guided to the door, Helped part of the way, Couldn't tell, or Misled.
The share of Trials Guided to the door is the main measure of success, and Misled is the safety measure, which should stay at zero.
_Avoid_: Result, success, pass/fail

**Misled**:
The Outcome where the app pointed the user at the wrong door or the wrong way.
It is worse than Couldn't tell, where the app honestly said it did not know.
_Avoid_: Failure, wrong answer
