import * as Sentry from "@sentry/node";

const dsn =
  process.env.SENTRY_DSN ||
  "https://fa316355a0c709031621ffd77eb53a7a@o4512409661145088.ingest.us.sentry.io/4512409761087488";

Sentry.init({
  dsn,
  environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || "development",
  release: process.env.SENTRY_RELEASE || process.env.RENDER_GIT_COMMIT || undefined,
  // Profiling is optional; skip the native addon so local Windows boots stay reliable.
  tracesSampleRate: process.env.NODE_ENV === "production" ? 0.2 : 1.0,
  sendDefaultPii: true,
});
