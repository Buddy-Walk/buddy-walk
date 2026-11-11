import * as Sentry from "@sentry/react-native";

const dsn =
  process.env.EXPO_PUBLIC_SENTRY_DSN ||
  "https://6cb8e4097bca755cefaefed772dc4aeb@o4512409661145088.ingest.us.sentry.io/4512409761021952";

// Session replay records the screen, and Last Meters shows the camera.
// Off unless an internal build sets EXPO_PUBLIC_SENTRY_REPLAY=1, and masked even then.
const replayEnabled = process.env.EXPO_PUBLIC_SENTRY_REPLAY === "1";

/** Drops the query string, where coordinates travel. */
function withoutQuery(url: string): string {
  return url.split("?")[0];
}

Sentry.init({
  dsn,
  // Release builds send; dev builds stay quiet unless EXPO_PUBLIC_SENTRY_DSN is set on purpose.
  enabled: !__DEV__ || Boolean(process.env.EXPO_PUBLIC_SENTRY_DSN),
  environment: process.env.EXPO_PUBLIC_SENTRY_ENVIRONMENT || (__DEV__ ? "development" : "production"),
  // Testers are blind and walk with the camera and GPS on. Send crashes and
  // timings, never who they are or what they asked.
  sendDefaultPii: false,
  attachScreenshot: false,
  attachViewHierarchy: false,
  integrations: replayEnabled
    ? [Sentry.mobileReplayIntegration({ maskAllText: true, maskAllImages: true, maskAllVectors: true })]
    : [],
  replaysSessionSampleRate: 0,
  replaysOnErrorSampleRate: replayEnabled ? 1.0 : 0,
  tracesSampleRate: __DEV__ ? 1.0 : 0.2,
  profilesSampleRate: __DEV__ ? 1.0 : 0.1,
  beforeBreadcrumb(breadcrumb) {
    // Console lines can carry Questions, transcripts, and coordinates.
    if (breadcrumb.category === "console") return null;
    if (breadcrumb.data && typeof breadcrumb.data.url === "string") {
      breadcrumb.data = { ...breadcrumb.data, url: withoutQuery(breadcrumb.data.url) };
    }
    return breadcrumb;
  },
});

export { Sentry };
