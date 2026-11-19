// Runs before index.ts loads .env, so read it here for SENTRY_* values.
import "dotenv/config";
import * as Sentry from "@sentry/node";

const dsn =
  process.env.SENTRY_DSN ||
  "https://fa316355a0c709031621ffd77eb53a7a@o4512409661145088.ingest.us.sentry.io/4512409761087488";

/** Drops the query string, where coordinates and API keys travel. */
function withoutQuery(url: string): string {
  return url.split("?")[0];
}

Sentry.init({
  dsn,
  // Render sends; local runs (including the Team console stack) stay quiet
  // unless SENTRY_DSN is set on purpose.
  enabled: process.env.NODE_ENV === "production" || Boolean(process.env.SENTRY_DSN),
  environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || "development",
  release: process.env.SENTRY_RELEASE || process.env.RENDER_GIT_COMMIT || undefined,
  tracesSampleRate: process.env.NODE_ENV === "production" ? 0.2 : 1.0,
  // SDK v11 collects everything unless told otherwise. Testers' Questions,
  // camera frames, and GPS travel in request bodies, OpenAI prompts, and Mongo
  // writes, so the API sends errors and timings only.
  dataCollection: {
    userInfo: false,
    cookies: false,
    httpHeaders: { allow: ["content-type", "content-length"] },
    httpBodies: [],
    urlQueryParams: false,
    genAI: { inputs: false, outputs: false },
    databaseQueryData: false,
    stackFrameVariables: false,
  },
  beforeBreadcrumb(breadcrumb) {
    // Console lines can carry Questions, coordinates, and image payloads.
    if (breadcrumb.category === "console") return null;
    if (breadcrumb.data) {
      const data = { ...breadcrumb.data };
      delete data["http.query"];
      delete data["http.fragment"];
      if (typeof data.url === "string") data.url = withoutQuery(data.url);
      breadcrumb.data = data;
    }
    return breadcrumb;
  },
});
