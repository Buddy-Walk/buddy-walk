# Live Feedback Preview agent instructions

Live Feedback Preview is a testing-ground app for Last Meters, built beside the current app (`mobile/` and `mobile/server`) without changing it.
It gives Last Meters guidance from live camera feedback instead of a single photo.
It is an iOS Expo app in `app/` with a Bun server in `server/`.

## Boundaries

- Keep Preview code inside this directory.
  When something from `mobile/` is useful, copy it here, so the current app's build and server stay untouched.
- Preview Trials live in the Preview's Postgres, separate from the current app's Mongo Trials.
- `app/` and `server/` each use bun with their own lockfile.
