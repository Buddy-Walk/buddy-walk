import * as Sentry from "@sentry/react-native";

const dsn =
  process.env.EXPO_PUBLIC_SENTRY_DSN ||
  "https://6cb8e4097bca755cefaefed772dc4aeb@o4512409661145088.ingest.us.sentry.io/4512409761021952";

Sentry.init({
  dsn,
  environment: process.env.EXPO_PUBLIC_SENTRY_ENVIRONMENT || (__DEV__ ? "development" : "production"),
  sendDefaultPii: true,
  integrations: [
    Sentry.mobileReplayIntegration(),
    Sentry.feedbackIntegration(),
  ],
  tracesSampleRate: __DEV__ ? 1.0 : 0.2,
  profilesSampleRate: __DEV__ ? 1.0 : 0.1,
  enableLogs: true,
  replaysSessionSampleRate: 0.1,
  replaysOnErrorSampleRate: 1.0,
});

export { Sentry };
