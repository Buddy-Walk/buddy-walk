# The app

Expo 57, React Native 0.86.3, React 19.2.3. Source: `mobile/src/`. Entry: `mobile/App.tsx`.

## Screens

Onboarding, then the main experience:

| Screen | File |
| --- | --- |
| Welcome | `mobile/src/screens/WelcomeScreen.tsx` |
| Auth (Firebase / Apple / Google) | `AuthScreen.tsx` |
| Permissions | `PermissionsScreen.tsx` |
| Waiver | `WaiverScreen.tsx` |
| Name | `NameScreen.tsx` |
| Main (camera, Question, Last Meters) | `MainScreen.tsx` |
| Saved places | `SavedPlacesScreen.tsx` |
| Companion | `CompanionScreen.tsx` |

Stack: `mobile/src/navigation/index.tsx`.

`MainScreen.tsx` is the large file. Last Meters from the phone goes through `handleLastMetersNavigation` and a client-side safety layer in `mobileLastMetersGuidance.ts` before `POST /api/last-meters` (shipped builds still call `/api/last-mile`; the server keeps that alias).

## Client config

All client env vars are `EXPO_PUBLIC_*` and are bundled into the binary. Copy `mobile/.env.example` to `mobile/.env`.

| Variable | Role |
| --- | --- |
| `EXPO_PUBLIC_API_URL` | API host. Defaults to the Render URL. On a physical phone, use the computer's LAN IP, not `localhost`. |
| `EXPO_PUBLIC_BYPASS_AUTH` | Skips sign-in. Fine for local demos. Do not ship a production TestFlight with this left on unless the team has agreed. |
| `EXPO_PUBLIC_FIREBASE_*` | Auth |
| `EXPO_PUBLIC_GOOGLE_*_CLIENT_ID` | OAuth |
| `EXPO_PUBLIC_COMPANION_API_URL` | Companion sessions; defaults to the same API host |

## Things that look live but are not wired

- `mobile/src/hooks/useTurnByTurnNavigation.ts` — haptic turn-by-turn helper; MainScreen does not mount it as the Last Meters path.
- `mobile/src/pages/` — leftover web-style pages, not the current navigation stack.

Do not delete those in a drive-by. If you touch them, that is its own issue.

## Tests and typecheck

From `mobile/`:

```
npm ci
npm test
npm run typecheck
npm run typecheck:server
```

`npm test` runs `tsx src/test/runAll.test.ts`, which imports every `*.test.ts` in `mobile/src/test/`. There is no Jest config; it is a custom runner.

The root README and `mobile/README.md` still mention Expo 54 and an old backend at `tort8678/contextual_vlm`. Ignore those version lines; this file is current.
