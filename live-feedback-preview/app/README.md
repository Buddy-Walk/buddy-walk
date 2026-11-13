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
