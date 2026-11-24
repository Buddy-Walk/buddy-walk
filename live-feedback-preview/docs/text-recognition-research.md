# Live on-device text recognition for Live Feedback Preview

Checked 2026-11-10 against npm, GitHub, VisionCamera docs, Apple developer docs and Apple Support.
Nothing here has been run on a device yet.

## Camera library

- `react-native-vision-camera` is at 5.2.4 (2026-10-29), and v4 is no longer maintained.
- v5 is built on Nitro Modules and reads live frames through `useFrameOutput`, which needs `react-native-vision-camera-worklets` and `react-native-worklets`.
- It runs in an Expo development build or EAS build, not in Expo Go.
- `expo-camera` has no live text recognition, and its `launchScanner` reads barcodes only.
- No Expo module reads text from live camera frames; the Expo OCR packages all work on still images.

## Text recognition plugins for VisionCamera v5

| Package | iOS engine | Last release | Verdict |
|---|---|---|---|
| `react-native-vision-camera-ocr-plus` | Google ML Kit | 2.1.2, 2026-11-04 | Most used (~30k downloads a week), actively maintained, no open issues |
| `react-native-vision-camera-mlkit` | Google ML Kit | 2.0.1, 2026-08-20 | Healthy, has its own Expo config plugin |
| `@bear-block/vision-camera-ocr` | Apple Vision | 5.0.0-beta.5, 2026-09-07 | Best Apple Vision option, but v5 support is still beta |
| `@chuksdengr/vision-camera-ocr` | Apple Vision | 1.1.2, 2026-07-14 | Supports v5, but a tiny one-person project |

No widely used v5 plugin uses Apple Vision yet.
VisionCamera documents writing your own plugin as a small Nitro Module, so a custom Apple Vision plugin is possible.

## Apple Vision notes

- The fast mode is meant for real-time reading; the accurate mode handles rotated, angled and stylized text much better.
- Apple's live sample uses the fast mode, turns off language correction, limits the region of interest, and accepts a result only after it repeats across 10 frames.
- Language correction can misread codes, so it should be off for door numbers.
- `minimumTextHeight` should stay low so distant door numbers are not dropped.
- Apple publishes no latency figures, so speed has to be measured on a device.

## Door detection

- Magnifier's Door Detection only runs on iPhone Pro models with LiDAR (12 Pro to 18 Pro).
- Apple says it should not be relied on for navigation.
- No public API for it was found.
- The nearest public APIs (ARKit mesh door classification, RoomPlan) also need LiDAR, and RoomPlan is built for indoor rooms.

## Sources

- https://www.npmjs.com/package/react-native-vision-camera
- https://visioncamera.margelo.com/docs/frame-output.md
- https://visioncamera.margelo.com/docs/visioncamera-vs-expo-camera.md
- https://visioncamera.margelo.com/docs/native-frame-processor-plugins.md
- https://docs.expo.dev/versions/latest/sdk/camera/
- https://developer.apple.com/documentation/vision/recognizing-text-in-images
- https://developer.apple.com/videos/play/wwdc2019/234/
- https://developer.apple.com/documentation/vision/extracting-phone-numbers-from-text-in-images
- https://developer.apple.com/documentation/vision/vnrecognizetextrequest/minimumtextheight
- https://support.apple.com/guide/iphone/detect-doors-people-and-furniture-around-you-iph35c335575/ios
- https://developer.apple.com/documentation/arkit/armeshclassification/door
