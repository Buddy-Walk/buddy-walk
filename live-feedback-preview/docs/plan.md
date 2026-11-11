# Buddy Walk Live Feedback Preview: plan

This document is the plan for Live Feedback Preview, a second Buddy Walk app built beside the current one without changing it.
It comes from a review of issue #67 (`bearing_uncertainty_too_large`) on 2026-11-09 and design sessions on 2026-11-09 and 2026-11-10.
Code references point to the `Buddy-Walk/buddy-walk` repo at commit `96dfea0` (2026-11-09).
It is a working draft for triaging issues, not a final spec.
Issues for it carry the `live-feedback-preview` label and hang off the tracking issue #104.

Related documents:
- `CONTEXT.md` at the repo root: the glossary, including the Live Feedback Preview terms used here
- `docs/adr/0005-last-meters-runs-on-the-phone-from-one-destination-brief.md`
- `text-recognition-research.md` next to this plan: on-device text recognition options, checked 2026-11-10

## 1. Scope

Buddy Walk is not a maps app.
The user's map app of choice (Apple Maps, Google Maps, Waze, etc.) gets them onto the right street and block.
From there they are usually within about 50 ft (15 m) of the destination.
Live Feedback Preview's only job is to close that last gap and find the door.

Live Feedback Preview is a testing ground.
It exists to find out whether live camera feedback gives a better experience and gets more users to the door than the current app.
What works moves into the main app, and the Preview then retires.

**In scope:**
- which side of the street the destination is on
- whether the destination is ahead or behind
- finding the destination with the camera and guiding the final turn
- walking the user along the same sidewalk to the door, once the safety rules are approved (see 3.6)
- street-fronted businesses with their own street door and street address

**Out of scope:**
- routing, turn-by-turn directions and getting the user to the right block
- crossing streets
- obstacle avoidance, which stays with the user's cane or guide dog
- large venues with several entrances, malls, residential buildings and offices above street level; for these the app says it can't help with that kind of place yet
- Android, for now

## 2. Why the current approach struggles

The current pipeline calculates a precise turn from two map points: the phone's GPS position and the destination's entrance or map pin.
Every other check (panorama match, compass comparison, walking route, confidence score) only decides whether to trust that turn.
It does not change the angle.

### 2.1 GPS is too coarse for the last 50 ft

- Reported GPS accuracy in the Trials reviewed was about 14 m (46 ft), for example 14.0, 14.2 and 17.6 m.
- The phone's accuracy figure is itself an estimate and can be optimistic in dense city streets.
- At 19 m (62 ft) from a door with 14 m accuracy, the direction to the door can be off by about ±48°.
- At 5.5 m (18 ft) with the same accuracy, the user could be on the far side of the door.
- The issue #67 gate (`mobile/server/utils/lastMetersPolicy.ts:33-34`) correctly withholds these turns.
- At 14 m accuracy it needs the user to be at least 37 m (121 ft) away, which is outside the range Last Meters is for.

### 2.2 The entrance is often just a map pin

- The entrance comes from Google's map data, not from the panorama (`findEntrance`, `mobile/server/services/lastMetersDestination.ts:130-185`).
- Listed building entrances are only used for whole buildings and large venues such as hospitals, schools, stations and malls (`mobile/server/utils/buildingEntrances.ts:26-61`).
- Small shops always use the Google Places pin, which is not necessarily the door.
- A pin 10 m (33 ft) to the side of the door puts the turn off by about 11° at 50 m, 27° at 20 m and 45° at 10 m.
- The issue #67 gate does not account for pin error at all.

### 2.3 The Street View panorama adds little

- It never provides a location. An image gives a direction from the camera, not a distance, and the Street View API used returns no depth data.
- It is picked as the first acceptable panorama near the user's GPS position, never ranked for how well it shows the destination (`mobile/server/services/outdoorPanoramaSelection.ts:52-97`).
- Imagery can be years old. Imagery 3 or more years old only lowers the confidence score by 0.05 (`mobile/server/utils/lastMetersNavigation.ts:10-11, 120-127`).
- The panorama search can take up to 45 seconds.
- Panorama-dependent steps fail often in the 30-day report (2026-10-02 to 2026-11-01, 53 runs): `heading_source_comparison` 8 runs, `target_store_match` 8, `sign_text_match` 7, `destination_reference_match` 6, `panorama_current_view_match` 6. These overlap and must not be added together.

### 2.4 The single photo is the wrong tool

- The photo does not make the user's position more accurate.
- It mainly exists to be matched against the panorama to confirm the compass.
- A blind user has to aim at a door they cannot see, then wait 15-45 seconds for an answer.

### 2.5 Outcomes in the 30-day report

- 41 of 53 runs (77.4%) withheld the turn, and only 5 of 53 (9.4%) succeeded.
- `bearing_uncertainty_too_large` was the most common safety reason: 10 runs, all Field tests.
- When the safety layer rejects about three quarters of attempts, the main input is not good enough at this range, rather than one rule being wrong.

### 2.6 A related safety problem in the current app

- On 2026-11-03, commit `f36ced4` (PR #54, for issue #53) made the mobile policy ignore `bearing_uncertainty_too_large` when the photo matched and the compass agreed (`mobile/server/utils/lastMetersGuidancePolicy.ts:64-65`).
- The photo proves which way the phone faces, not where the user stands, so turns are again calculated from the uncertain GPS bearing.
- At least 7 of the 10 runs that hit the gate had corroborated orientation, so under current code they could now receive an unverified precise turn.
- This affects the current app, not Live Feedback Preview, and is tracked under issue #67.

## 3. The design

A run has four parts: start, orient, find, and the fallbacks when the destination is not found straight away.

### 3.1 Starting a run

- The user starts in Live Feedback Preview and names the place.
- The app makes it a Verified destination, including the check for ambiguous nearby branches.
- The server returns a Destination brief, and the app opens the user's map app with that exact place, so both apps aim at the same door.
- The user follows their map app until it says they have arrived, then returns to Live Feedback Preview.
- Fallback: a user who opens the app cold on arrival names the place then.

### 3.2 Orient: facing the destination's side of the street

- The side of the street comes from the Destination brief: the street's geometry and where the destination's address sits on it, not the GPS point to the pin.
- Beside the building, 14 m of GPS error could flip a GPS-to-pin answer, so it is never used.
- The app does not need to know which way the user was walking.
- It uses the compass reading at that moment to start a Guided turn toward the destination's side ("turn to your right"), with about ±45° of tolerance.
- The parity of the first street number read (odd or even) confirms the side, which catches compass error near steel buildings.
- If the compass is unreliable, the user pans a full circle instead.

**The opposite sidewalk:**
- The map app gets the user onto the right street, but not necessarily the right sidewalk, and GPS cannot tell them apart.
- Before anything else, the app reads the storefront beside the user.
- If its number has the opposite parity to the destination's, the app says the destination is across the street, that it does not guide crossings, and that the user can cross the way they usually do and start again.

### 3.3 Find: live panning instead of a photo

- The user slowly sweeps the phone, and the app gives real-time feedback ("sign to your left").
- Text recognition runs on the phone, with no server and no AI model during the run (ADR 0005).
- Each Scan produces Readings, and the app ties Readings to the Destination brief as Matches.
- The destination counts as **found** when a Match on its own name or street number is close and centred in the camera view.
- A Guided turn then faces the user toward it, and the app says "the entrance is in front of you".
- Detecting the door itself is a later experiment (see 6.2).
- Assumed working range from the same sidewalk is about 10 ft, because signs along the shop fronts appear edge-on from there; the first experiment measures this.

### 3.4 Evidence and fallbacks

One Scan reads all the text in view: door numbers, shop names, awnings and window decals.
The fallbacks are an order of preference over the Matches, not separate modes.

**Matches, strongest first:**
1. **The destination's own sign or name.** If visible, it settles everything.
2. **A street number** on the door, awning or glass.
   - Numbers usually rise in one direction along a block, with odds on one side and evens on the other.
   - If the door beside the user reads 34 and the destination is 40, the user is a few doors away.
   - The rising direction and the parity come from the Destination brief.
3. **A neighbouring business's name**, matched against the neighbours in the Destination brief to place the user on the block.
   - Weaker than numbers, because neighbouring pins can be a few metres off and swap adjacent shops.

**When nothing matches:**
- The app asks for rescans first: raise the phone, aim at the door glass, try the awning.
- Then it says honestly that it cannot tell, for example: "The shop is within about 50 ft on this side of the street, but I can't tell which door. Ask someone nearby or use your primary navigation."
- It never tells the user to keep walking the way they were going, and never replaces an unknown with a confident guess.
- Leading a user further from the destination is worse than an honest "can't tell".

**Bounded walk:**
- A Bounded walk closes the gap one door at a time: "This is 34, the shop is at 40, about three doors to your right." Then "38". Then "40, the entrance is on your right."
- It only happens when a Match gives a direction.
- It rescans at each doorway, and the pedometer measures the distance walked, which is much more reliable than GPS over short distances.
- It stops at a distance cap, or earlier at the end of the block, so it never leads to a crossing, and it says so honestly if the destination has not turned up.
- It is built behind a setting that is off by default and turned on only once the safety rules are approved (see 3.6).
- Until then, the app only describes where the destination is and gives Guided turns while the user stands still.

**Known gaps:** some doors have no visible number, several storefronts can share one, and some areas break the pattern (Queens uses hyphenated numbers).

### 3.5 Guided turns

- The app never speaks degrees or clock positions: "30 degrees to your left" is hard to act on even with sight.
- Every turn is a Guided turn:
  1. A coarse spoken start: "turn to your right", "turn around".
  2. A continuous cue that strengthens as the user nears the target.
  3. A distinct stop cue when they face the right way.
- The cue is haptic by default, with audio as a user preference.
- The same pattern centres the destination's sign or number in the camera at the end.
- The exact haptic and sound design is tried with testers.

### 3.6 Safety rules

- Never give street-crossing instructions; say when the destination is across the street.
- Obstacle avoidance stays with the user's cane or guide dog.
- When evidence conflicts or is missing, say so rather than guess.
- Be very careful with any instruction to move.

**Before the Bounded walk is turned on**, its rules are written down and approved:
- a distance cap, and stopping at the end of the block if that comes first
- the user can stop it at any moment by touch or voice
- wording describes ("the shop is about three doors ahead") rather than commands ("go")

The rules are drafted by the team, approved by the team, and ideally reviewed by an orientation and mobility specialist before User tests begin.

## 4. Architecture

Live Feedback Preview is fully separate from the current app and `mobile/server`, so it cannot disrupt them.
It lives in the same monorepo under `live-feedback-preview/app` and `live-feedback-preview/server`, sharing no code with `mobile/` (copies only).
Both use bun as their package manager, each with its own lockfile, as `team-console/` does.

### 4.1 Mobile app

- A separate Expo app with its own `package.json`, so its native libraries never enter the main app's build.
- iOS only to start.
- Bundle ID `com.buddywalk.live-feedback-preview`, home-screen name "BW Live" (iOS cuts home-screen names after about 12 characters). The current one is `com.buddywalk.app`.
- Its own App Store Connect record and EAS build profile, and so its own TestFlight.
  - Testers install it next to the main app.
  - Internal testers can be added right away. External testers need Apple's beta review for the new app, usually about a day.
- Camera: `react-native-vision-camera` v5, which runs in an EAS build but not Expo Go. `expo-camera` cannot read live frames.
- Text recognition: `react-native-vision-camera-ocr-plus` (Google ML Kit), the most used and maintained option (see `text-recognition-research.md`).
- If ML Kit reads angled or stylised signs poorly, the fallback is a small Swift VisionCamera plugin calling Apple Vision. Flutter is not used.
- Sign-in: Sign in with Apple only, checked against a list of approved tester accounts on the server. This needs a closer look before it is built.
- Trials are saved on the phone as the run goes, uploaded at the end or on the next launch, and abandoned runs are uploaded and marked as abandoned. The details are left to the issue.
- A Trial keeps the frame behind each Match and a few frames from Scans that produced no Readings. No video. The details are left to the issue.

### 4.2 Runs happen on the phone

- The server sends one Destination brief when a run starts, and the phone does everything after that (ADR 0005).
- Matching Readings against the brief is plain text and number comparison on the phone, with no AI model during the run. This may be revisited later, for example to use a model when building name variants for the brief.

### 4.3 Server

- A new server, rebuilt from only the parts that matter, hosted on Railway separately from the current Render API.
- TypeScript on Bun.
- The web framework is still open: Hono, Express or another option needs research.
- It signs testers in, builds the Destination brief, and stores Trials.
- **The Destination brief's sources:**
  - street layout from OpenStreetMap
  - side of street, parity and the direction numbers rise from Google Geocoding of the destination's address and a few nearby numbers on the same street
  - neighbouring businesses from Google Places nearby search
  - name variants from the Verified destination
- **Carry over:**
  - destination lookup: Places search and the checks for ambiguous nearby branches
  - Trial recording, rebuilt as relational tables, using the current step-by-step record as a model
- **Leave behind:**
  - Street View panorama search and matching
  - the walking-route check (`checkWalkingRoute`, a Google Directions call on every run)
  - the GPS-based precise-turn gate from issue #67

### 4.4 Database

- Hosted Postgres on Railway, next to the server.
- SQL fits because the data is relational: Trials, Scans, Readings, Matches and step results.
- The ORM is still open: Drizzle or Prisma needs research.
  - Drizzle: schema in TypeScript, no generate step, SQL-like queries, a driver for Bun's built-in Postgres client.
  - Prisma: its own schema language and generate step, more mature migrations, Prisma Studio, easier nested reads.
- Considered and set aside:
  - **Mongo:** a separate database would also isolate the data, but it is not relational.
  - **SQLite:** needs a persistent disk and limits the server to one instance.
  - **A self-managed VM:** adds OS patching, HTTPS, restarts and backups to maintain.
- Keeps Live Feedback Preview Trials out of the current Mongo Trials.

### 4.5 Team console

- Live Feedback Preview Trials get their own page, never mixed with the current app's Trials.
- The console's server functions call the Preview server with their own secret, the same pattern as ADR 0004, so the browser never sees a token.
- The page filters by kind of Field test and by app build.

## 5. Measuring success

The most important measure is whether the app actually got the user to the door.
Everything else is supporting data, used to see whether a change (for example to scanning) improved a step.

### 5.1 Outcomes

Every Field test ends with one Outcome:
- **Guided to the door:** the app's guidance got them there.
- **Helped part of the way:** the guidance helped, but they needed a person or their own judgement to finish.
- **Couldn't tell:** the app said honestly that it did not know.
- **Misled:** the app pointed them at the wrong door or the wrong way.

The share Guided to the door is the headline number.
Misled is the safety number, and the aim is zero.

- Live Feedback Preview asks the tester for the Outcome at the end of each run; for a Blindfolded test the chaperone confirms whether it was the right door.
- The current app is not changed. Its Outcomes are worked out from data it already stores:
  - a withheld turn counts as Couldn't tell, read from the stored safety reason
  - for a given turn, the console's existing review values, filled in by whoever was on the street: `got_there` is Guided to the door, `needed_retake` is Helped part of the way, `would_not_get_there` is Misled

### 5.2 Kinds of Field test

Each Trial records which kind of Field test it was, and the console reports each kind separately:
- **Sighted test:** a sighted tester with eyes open, checking whether the guidance is correct. Most Field tests are this kind.
- **Blindfolded test:** a blindfolded sighted tester with a chaperone, catching problems early.
- **User test:** a blind or low-vision tester, judging whether the guidance is intuitive.

Correct guidance can still need tuning before it is intuitive for blind users, which is different from it not working at all.
Only User tests answer that question; Blindfolded tests cannot stand in for them.
Blind and low-vision testers join only after the safety rules are approved.

### 5.3 Step results by app build

Each Trial records the app build and a pass, fail or skipped result for each step:
1. brief built
2. Scan produced Readings
3. Match found
4. direction established
5. destination found
6. Guided turn completed

The console shows, for each build, how many Trials got through each step.

### 5.4 Comparing with the current app

- Each test session runs both apps at the same set of destinations, alternating which app goes first.
- For now, testers are sighted.

## 6. Experiments and measurements

### 6.1 First experiment: can the camera read numbers and signs live?

- It runs in the Live Feedback Preview app itself, as its first screen: a live camera reading text, through internal TestFlight.
- A browser page was rejected: Safari gives web pages no built-in text recognition, so a browser library's results would not carry over to the app.
- It runs with sighted testers on real streets.
- It should answer:
  - at what distance numbers and signs are readable from the same sidewalk and from across the street
  - how often a number is visible at all
  - how long recognition takes
  - whether ML Kit reads angled and stylised shop signs well enough, or the Apple Vision fallback is needed
  - whether storefronts on the near sidewalk can be told apart from those across the street

### 6.2 Door detection experiment

- After the text-reading experiment has results.
- Without LiDAR, this means an on-device image model, for example a CoreML model trained on doors. Apple's Door Detection has no public API and needs a LiDAR iPhone.
- It measures how often a door is detected, false alarms on windows, and range.
- Its results decide whether "found" can also mean a door centred in the view, not only a name or number.

### 6.3 Data already available

- The stored Trials keep the users' photos.
- Checking how often the door, sign or number was visible in them would show how many cases a camera-first design covers.
- The stored Trials log every panorama attempt (`panoramaValidation`), so the panorama's real success rate can be counted.

### 6.4 GPS and map app measurements

- **Real GPS error:** stand at doors with known locations, record the phone's position and its reported accuracy, and compare. This also shows whether the phone's accuracy estimate can be trusted.
- **Map app arrival error:** record where the user's map app said "arrived" against where the door actually was, and how often the door was behind the user.
- These would test a claim of about 50 m average error, which has no known source.

## 7. Open decisions

- **Web framework:** Hono, Express or another option on Bun.
- **ORM:** Drizzle or Prisma. An ADR records the server stack once both are chosen.
- **Sign-in:** a closer look at Sign in with Apple with a tester list.
- **Safety rules:** the Bounded walk's distance cap, wording and stop rules.
- **Guided turn cues:** the exact haptic and sound design.

## 8. Issues

Filed on 2026-11-11 as sub-issues of the tracking issue #104, roughly in dependency order.
Each issue lists the issues that block it.

- #105 Set up the iOS app: Expo development build, bundle ID, EAS profile, internal TestFlight, bun (4.1).
- #106 First experiment: a live text-reading screen with VisionCamera and ML Kit, recording distance, visibility and latency (6.1).
- #107 Count how often the door, sign or number was visible in stored Trial photos (6.3).
- #108 Field-test protocol for GPS error and map app arrival error (6.4).
- #109 Research: web framework for the server on Bun (4.3, 7).
- #110 Research: Drizzle or Prisma (4.4, 7).
- #111 Set up the server and Postgres on Railway, and design the schema for Trials, Scans, Readings, Matches, Outcomes, kinds of Field test, step results and app builds (4.3, 4.4, 5).
- #112 Sign in with Apple and the tester list (4.1).
- #113 Carry over destination lookup and the nearby-branch check (4.3).
- #114 Build the Destination brief: side of street, parity, rising direction, neighbours (4.3).
- #115 Start a run and hand off to the user's map app (3.1).
- #116 Orient: Guided turn to the destination's side, parity check and the across-the-street message (3.2).
- #117 Guided turn cues: haptic by default, audio as a preference (3.5).
- #118 Live panning and matching Readings against the Destination brief, and when the destination counts as found (3.3).
- #119 Order of Matches, rescan prompts and the honest "can't tell" (3.4).
- #120 Saving Trials on the phone, uploading and recovering them, and which frames a Trial keeps (4.1).
- #121 The end-of-run Outcome question (5.1).
- #122 Live Feedback Preview page in the Team console (4.5).
- #123 Work out the current app's Outcomes from stored data, for comparison (5.1).
- #124 Write the sidewalk safety rules and get them approved (3.6).
- #125 Bounded walk behind a setting that is off by default (3.4).
- #126 Door detection experiment (6.2).

**Separate from Live Feedback Preview, for the current app:** fix the issue #67 bypass so a precise turn is never given when GPS accuracy is at least the distance, and log the computed bearing uncertainty, the threshold and whether the bypass fired.
