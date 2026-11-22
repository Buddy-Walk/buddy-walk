# Live Feedback Preview app

The iOS app for Live Feedback Preview.
It is an Expo app that runs as a development build, not in Expo Go.

## Variants

`APP_VARIANT` picks the variant when the app config is read:

| `APP_VARIANT` | Bundle ID | Home-screen name | Used for |
| --- | --- | --- | --- |
| unset (default) | `com.buddywalk.live-feedback-preview.dev` | BW Live Dev | your own iPhone and the simulator |
| `release` | `com.buddywalk.live-feedback-preview` | BW Live | TestFlight, through the `testflight` EAS profile |

Never sign the release variant with a personal Apple ID.
Bundle IDs are unique across Apple accounts, so it would be registered to you and the team account could no longer use it.

Both variants install next to the current Buddy Walk app.

## Commands

```bash
bun install         # install dependencies from bun.lock
bun start           # start Metro for a Debug build
bun run ios         # build and run on the iOS simulator
bun run typecheck
bun test
```

Add native packages with `bunx expo install <package>` so they match the Expo SDK.

After adding or updating packages, stop Metro and start it again with `bun start --clear`.
A Metro that was already running keeps its old Babel setup and cache.
For example, it bundles `react-native-worklets` without the worklets plugin, and the app then fails on launch with `cannot read property 'bytecode' of undefined`.

The camera and text recognition only work on a real iPhone.
Google ML Kit has no Apple Silicon simulator build, so `bun run ios` can fail on an Apple Silicon Mac unless the simulator runs under Rosetta.

## Code layout

- `src/readings/` turns live camera frames into Readings, on the phone, with `react-native-vision-camera` and `react-native-vision-camera-ocr-plus` (Google ML Kit).
  It knows nothing about experiment sessions, so later screens (#118) use it as it is.
- `src/experiment/` is the first experiment's screen (#106): live Readings, experiment sessions, Marks and export.
  It goes away after the experiment.

`patches/` holds two patches, applied by `bun install`:

- `react-native-vision-camera-ocr-plus`: as released, ocr-plus returns the result of an earlier frame for each frame it is given.
  The patch makes it read each frame before returning, so every Reading has its own frame's timestamp and recognition time.
  VisionCamera drops the frames that arrive while a frame is being read.
- `react-native-vision-camera`: as released, turning a frame into an image rotates it the wrong way, so a phone held upright saves Mark frames upside down.
  The patch rotates them the right way.

Both packages are pinned to the exact versions the patches are for.

## The experiment screen

The app opens on the camera.
The first time, iOS asks for camera and location permission as it opens, because it only gives a compass heading with location.
Nothing is read until you tap **Start**.

1. Tap **Start** to begin an experiment session.
   The app reads text from then on, with a box over each Reading and a list of the most recent Readings below.
2. Walk the street.
   Every Reading is logged with the compass heading.
   The status line says "no compass heading" while there is none, for example when location permission is denied.
   The screen stays on while recording, because a locked phone stops the camera.
3. Tap **Mark** at a target.
   The app saves the frame at the tap with its Readings, then asks whether the target is a door number or a sign, its side of the street, whether you can read it yourself, its style, what makes it hard to read, and the distance in feet.
   Choose every condition that applies, or **Clear** when nothing does.
   **Other** opens a text box for a condition that isn't listed.
   **Cancel** throws the frame away.
   Nothing is read or logged while the form is open, so no boxes move behind it, and reading starts again when you save or cancel it.
4. Tap **Stop** to end the session.

The session is saved on the phone every 2 seconds while it runs, so closing or killing the app loses at most the last 2 seconds.
A session that was never stopped still appears under **Sessions**, marked "cut off".
A session whose log can't be read appears too, so it can be deleted.

### Exporting a session

Tap **Sessions**, then **Export** on a session.
The share sheet opens with one zip file, which AirDrop sends to a Mac.
The zip holds a folder named after the session, with `session.json` and one JPEG per Mark.
**Delete** removes a session from the phone, after asking to confirm.

To export or delete several sessions at once, tap **Select**, then tap the sessions, or **Select All**.
**Export** puts them all in one zip, with a folder per session.
A session that can't be read can be deleted but not exported, so it is left out of the export.

Frames from public streets can show people, so exported sessions stay out of git (#139).

### Sessions on the laptop

A Debug build running against Metro also copies each session to the laptop as it records, into `experiment-sessions/<session>/` in this directory.
The copy has the same `log.jsonl` and Mark frames as the phone and is at most a couple of seconds behind it, so there is nothing to export.
`experiment-sessions/` is ignored by git, for the same reason as exports.

- The phone's files are the real ones: recording carries on when the laptop is out of reach, and the next thing the phone sends brings the copy up to date.
- Deleting a session on the phone keeps the laptop's copy.
- A Release build, or a session recorded away from the laptop, is not copied, so export it instead.

Metro receives the sessions through `metro.config.js`, so restart Metro after changing that file or `devServer/`.

### Session files

On the phone, each session is a folder in the app's documents, named after its start time, such as `2026-11-15T14-00-00Z`.
A second session started within the same second gets `-2` added.
It holds the Mark frames and `log.jsonl`, with one JSON object per line.
The log is only ever appended to, so a session cut off partway loses at most its last, half-written line, where a single JSON file could be left unreadable.
The export turns the log into `session.json`.

`session.json` looks like this:

```json
{
  "version": 3,
  "id": "2026-11-15T14-00-00Z",
  "device": { "model": "iPhone 15", "osVersion": "26.1" },
  "app": { "version": "1.0.0", "build": "1" },
  "startedAt": "2026-11-15T14:00:00.000Z",
  "endedAt": "2026-11-15T14:20:00.000Z",
  "framesProcessed": 6000,
  "framesPerSecond": 5,
  "readings": [
    {
      "text": "34",
      "box": { "x": 0.4, "y": 0.475, "width": 0.2, "height": 0.05 },
      "frameTimestamp": 1794751205123,
      "recognitionMs": 42,
      "heading": { "trueDegrees": 92.5, "magneticDegrees": 80.1, "accuracy": 3 }
    }
  ],
  "marks": [
    {
      "markedAt": "2026-11-15T14:03:12.034Z",
      "frameFile": "mark-001.jpg",
      "heading": { "trueDegrees": 92.5, "magneticDegrees": 80.1, "accuracy": 3 },
      "readings": [
        {
          "text": "34",
          "box": { "x": 0.4, "y": 0.475, "width": 0.2, "height": 0.05 },
          "frameTimestamp": 1794751392034,
          "recognitionMs": 40
        }
      ],
      "targetKind": "door-number",
      "side": "same-sidewalk",
      "visibleToTester": true,
      "signStyle": "plain",
      "conditions": ["faded", "obstructed"],
      "otherCondition": null,
      "distanceFeet": 12
    }
  ]
}
```

- `version` goes up whenever the shape changes.
  A session keeps the version it was recorded in, so one from an older version exports in that shape.
- `endedAt` is `null` for a session that was cut off; `framesProcessed` and `framesPerSecond` then run to its last save.
- `framesPerSecond` is frames read per second while the session was logging, which leaves out time with the app in the background or a Mark's form open, or `null` if it never logged.
  `framesProcessed` leaves out the same frames.
- A Reading is one line of text ML Kit recognised.
- `box` is where the Reading sits in the upright frame, as fractions (0 to 1) of the frame's width and height from its top-left corner.
- `frameTimestamp` is when the frame reached the text reader, shortly after the camera captured it, as Unix time in milliseconds.
  It is on the same clock as `startedAt`, `endedAt` and `markedAt`, so Readings line up with the session and its Marks.
  The camera's own timestamps are not used, because they are on a clock the app can't read.
- `recognitionMs` is how long the frame took to read: turning the camera buffer into an upright image, then ML Kit recognising the text.
- `heading` is the phone's latest compass heading when the frame's Readings were logged, a few milliseconds after the frame was read.
  It is `null` before the first compass reading or without location permission.
  `trueDegrees` is `null` when iOS can't give true north, and `accuracy` runs from 0 (over 50° uncertainty) to 3 (under 20°).
- `targetKind` is `door-number` or `sign`; version 1 sessions store `street-number` for a door number.
  `side` is `same-sidewalk` or `across-street`, and `signStyle` is `plain`, `stylised` or `angled`.
- `visibleToTester` is whether the tester could read the target themselves.
- `conditions` is what the tester chose as making the target hard to read, always in this order:

  | Value | Meaning |
  | --- | --- |
  | `clear` | Nothing makes it harder to read. Never combined with any other condition. |
  | `faded` | The lettering is worn or doesn't stand out from its background. |
  | `dirty` | Grime, rust or peeling paint over the lettering. |
  | `damaged` | Characters are missing, broken or hanging loose. |
  | `obstructed` | Partly hidden, for example by a tree, car, pole, person or awning. |
  | `glare` | Sunlight or a reflection on the target. |
  | `dark` | In shadow, with bright light behind it, or at dusk or night. |

  `faded`, `dirty` and `damaged` are about the target itself, and `obstructed`, `glare` and `dark` about the moment it was marked.
- `otherCondition` is what the tester typed in after choosing **Other**, for something not listed, trimmed, or `null` when Other wasn't chosen.
  It can sit beside any of `conditions` except `clear`, and `conditions` is empty when it is the only one.
  A condition typed in often enough becomes a new value in a later version, and Marks recorded before that keep it here.
- Version 1 and 2 Marks have no `conditions` or `otherCondition`.
- A Mark's frame, `frameFile`, is the first frame read after the tap, a frame or two after it.
  Its `readings` are that frame's Readings, and `markedAt` and `heading` are that frame's too, so `markedAt` matches its Readings' `frameTimestamp`.

## Running on your own iPhone

You need Xcode, an iPhone connected by cable, and an Apple ID added in Xcode → Settings → Accounts.
A free personal Apple ID is enough for the development variant.

1. Generate the iOS project:

   ```bash
   bunx expo prebuild --platform ios
   ```

   `ios/` is generated and not committed.
   Run `bunx expo prebuild --platform ios --clean` after changing the app config or adding a native package, then pick the team again in step 3.

2. Open it in Xcode with `xed ios`.
3. Select the `BWLiveDev` target, open Signing & Capabilities, and set Team to your Personal Team.
4. Pick your iPhone as the run destination.

The first install needs two settings on the iPhone:
turn on Settings → Privacy & Security → Developer Mode, and trust your Apple ID under Settings → General → VPN & Device Management.

### Debug build against Metro

1. Run `bun start` in this directory.
2. In Xcode, press Run.

The app loads its JavaScript from Metro, so the iPhone and the laptop must be on the same network.
Code changes reload on the phone.

### Release build that runs without the laptop

1. In Xcode, open Product → Scheme → Edit Scheme, select Run, and set Build Configuration to Release.
2. Press Run.

The JavaScript is bundled into the app, so it opens with the laptop disconnected and Metro stopped.
Set Build Configuration back to Debug to work against Metro again.

### Free signing limits

- An app signed with a personal Apple ID stops opening after 7 days.
  Build and run it from Xcode again to renew it.
- A personal Apple ID can have at most 3 of these apps installed on a device at once.

## EAS builds

`eas.json` has two profiles:

- `development`: a development build with the dev client.
- `testflight`: a store build of the release variant for TestFlight.
