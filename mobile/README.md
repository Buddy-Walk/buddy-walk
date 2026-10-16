# Buddy Walk Mobile

Expo / React Native app for blind and low-vision travelers: camera + voice Q&A, haptic turn-by-turn navigation, saved places, and companion location sharing.

For code entry points, capture and sensor data flow, service ownership, and validation commands, see the [mobile contributor guide](docs/mobile-code-guide.md).

**Screenshots & overview:** see the [repository README](../README.md) and [GitHub Pages site](../docs/index.html) (`docs/assets/`).

---

## Prerequisites

| Tool | Version | Notes |
|------|---------|-------|
| **Node.js** | 18+ | LTS recommended |
| **npm** | 9+ | Ships with Node |
| **Expo CLI** | - | Installed automatically via `npx expo` |
| **Expo Go** | Latest | Install on your phone from the App Store / Google Play |

> The **Buddy Walk backend** (Express + MongoDB) must be running for the app to function. See the [main repo](https://github.com/tort8678/contextual_vlm) for backend setup instructions.

---

## Quick Start

Clone the repository and install dependencies:

```bash
git clone <repo-url>
cd buddy-walk-mobile
npm install
```

Create your local environment file:

```bash
cp .env.example .env
```

Open `.env` and point the app at your backend:

```env
EXPO_PUBLIC_API_URL=http://<YOUR_LOCAL_IP>:8000
```

For local demos or TestFlight builds that should skip sign-in (permissions/onboarding still run):

```env
EXPO_PUBLIC_BYPASS_AUTH=true
```

> Use your machine's **local network IP** (e.g. `192.168.x.x`), not `localhost`, so the phone can reach the backend over Wi-Fi. Find it with `ipconfig` (Windows) or `ifconfig` (macOS/Linux).

Start the Expo dev server:

```bash
npx expo start
```

Scan the QR code in your terminal with **Expo Go** (Android) or the **Camera app** (iOS).

---

## Project Structure

```text
mobile/
|-- App.tsx
|-- src/
|   |-- navigation/       Auth gate + onboarding stack
|   |-- screens/          Welcome, Auth, Permissions, Waiver, Name, Main,
|   |                     Navigation, SavedPlaces, Companion
|   |-- hooks/            useTurnByTurnNavigation
|   |-- utils/            parseSteps, hapticPatterns, savedPlaces
|   |-- api/              Axios -> Express backend
|   `-- test/             Unit tests (npm test)
|-- .env.example
`-- package.json
```

---

## Key Features

- **Camera** - tap photo, hold for video; spoken capture feedback
- **Voice** - Azure STT; tap mic or **shake** to listen
- **Haptic navigation** - parsed walking steps with GPS, speech, and vibration patterns
- **Saved places** - local bookmarks for voice-friendly nicknames
- **Companion mode** - shareable link for live location in the browser
- **Accessibility** - labels, hints, announcements; offline detection; Access-A-Ride dial

---

## Running on a Physical Device

1. Make sure your phone and dev machine are on the **same Wi-Fi network**.
2. Start the backend: run `npm run dev` in the main Buddy Walk repo root.
3. Start Expo: run `npx expo start` in this directory.
4. Scan the QR code with Expo Go.

> Camera and sensors require a **physical device**. The emulator will not provide real camera or accelerometer data.

---

## Building for Production

Generate native projects and build locally:

```bash
npx expo prebuild
npx expo run:ios --configuration Release
npx expo run:android --variant release
```

Or use [EAS Build](https://docs.expo.dev/build/introduction/) for cloud builds:

```bash
eas build --platform ios --profile production
eas submit --platform ios --profile production --latest
```

TestFlight uses **`https://buddy-walk-api.onrender.com`** (not your local `.env` or legacy buddywalk.app). `EXPO_PUBLIC_BYPASS_AUTH=true` is set in `eas.json`. Build number auto-increments on EAS.

Production EAS builds set `SHARP_IGNORE_GLOBAL_LIBVIPS=1` so the server's Sharp dependency uses its prebuilt binaries instead of compiling against the Mac builder's global libvips. The TestFlight workflow supports building without submission, submitting an existing build ID, and inspecting a failed build; this allows a completed binary to be submitted after Apple account agreements are resolved.

---

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `EXPO_PUBLIC_API_URL` | Base URL of the Express backend | `http://localhost:8000` |
| `EXPO_PUBLIC_BYPASS_AUTH` | Set to `true`/`1`/`yes` to skip sign-in only; permissions, waiver, and name screens still run | unset |

---

## Tech Stack

| Package | Purpose |
|---------|---------|
| **Expo SDK 54** / React Native 0.81 | Core framework |
| **React Navigation** | Native stack navigation |
| **React Native Paper** | Material Design components |
| **expo-camera** | Photo and video capture |
| **expo-av** | Audio recording for Azure STT |
| **expo-speech** | Text-to-speech |
| **expo-sensors** | Magnetometer (compass) and accelerometer (shake detection) |
| **expo-location** | GPS tracking |
| **expo-network** | Connectivity monitoring |
| **axios** | HTTP client |
| **Azure Cognitive Services** | Speech-to-Text (token fetched from backend) |
