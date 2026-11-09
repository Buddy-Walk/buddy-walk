# Local setup

## What you need

- Node 18+
- npm 9+
- This clone: `https://github.com/Buddy-Walk/buddy-walk`
- Optional: MongoDB on `127.0.0.1` (without it, the API starts with an in-memory store)
- A physical phone on the same Wi-Fi as the computer for Expo Go

## API

```
cd mobile
npm ci
copy .env.example .env
```

Fill at least `OPENAI_API_KEY` and `GOOGLE_MAPS_API_KEY` (or `GOOGLE_API_KEY`) to run Last Meters locally.
`ADMIN_TOKEN` if you want the admin endpoints, such as `/api/last-meters-tests`.

```
npm run serve
```

Default port 8000. `GET http://localhost:8000/api/health` should report routing.

`npm run serve:dev` watches `server/` and restarts.

## App

In `mobile/.env`:

```
EXPO_PUBLIC_BYPASS_AUTH=true
EXPO_PUBLIC_API_URL=http://<YOUR_LAN_IP>:8000
```

`localhost` on a phone is the phone. Use `ipconfig` (Windows) or `ifconfig` (macOS/Linux).

```
npx expo start
```

Scan the QR code with Expo Go (Android) or the Camera app (iOS).

## Tests

```
cd mobile
npm test
npm run typecheck
npm run typecheck:server
```

First `npm ci` can take a while (sharp, expo). That is expected.

## What not to point at from a laptop

- Do not run dashboard retries that write into production Mongo.
- Do not print the production `ADMIN_TOKEN`.
- Do not use the commented Atlas URI in root `server/database/index.ts`.

## Stale files

`README.md` and `mobile/README.md` still say Expo 54 and point at `tort8678/contextual_vlm`.
The live stack is Expo 57 and `mobile/server` on Render. Prefer this handbook.
