# Last Meters runs on the phone from one Destination brief

In Live Feedback Preview, the server sends one Destination brief when a run starts, and the phone does everything after that: reading text from the camera, matching Readings against the brief, and giving live feedback.
No server and no AI model is called during the run, and the phone uploads the Trial when the run ends.
Live feedback has to arrive while the user is still panning, and street signal is unreliable, so a network round trip per Reading would make the feedback late or missing.

The server still exists: it signs testers in, builds the Destination brief from Google and OpenStreetMap data, and stores Trials.

The one exception is a Scene description, given automatically at "can't tell" and on request while the app has directions to give.
It sends a few frames to a vision model on the server, at moments where a few seconds' wait is acceptable, and it never sits in the live loop: with no signal, the app still finishes the run and gives a plain "can't tell".

## Considered Options

- **The server checks each Reading as it arrives.**
  Rejected: every piece of feedback would wait on the network, for matching that is plain text and number comparison.
- **Send camera frames to the server for recognition.**
  Rejected: too slow and costly for real time, and it fails with poor signal.
