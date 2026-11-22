# Live Feedback Preview agent instructions

Live Feedback Preview is a testing-ground app for Last Meters, built beside the current app (`mobile/` and `mobile/server`) without changing it.
It gives Last Meters guidance from live camera feedback instead of a single photo.
It is an iOS Expo app in `app/` with a Bun server in `server/`.

Before designing or changing how the Preview behaves, read `docs/plan.md`: the design, the safety rules, how success is measured, and the reasons behind each choice.
When deciding whether work is in scope, what a Trial should record, or how to judge a result, read `docs/research-question.md`: what the Preview is trying to find out and what counts as an answer.

## Research data

The Preview is research: what it records is as important as what it does.
When designing anything that records data, such as Marks, Trials, sessions or replays:
- Record ground truth and raw measurements rather than anyone's judgement: what the target actually says, distances from a laser measure, the frame itself.
  Values that follow from them, such as the viewing angle, are worked out in analysis.
- Record why something failed as well as that it failed, and keep what a later analysis could re-run on: full-size frames, earlier replay runs, the app build.
- When a simpler design would record less, record more.

Every change meant to improve something gets a change report: why it was made, what it should improve, and whether it did (#161).

## Boundaries

- Keep Preview code inside this directory.
  When something from `mobile/` is useful, copy it here, so the current app's build and server stay untouched.
- Preview Trials live in the Preview's Postgres, separate from the current app's Mongo Trials.
- `app/` and `server/` each use bun with their own lockfile.
