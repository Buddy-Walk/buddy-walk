// Runs before index.ts loads .env, so read it here for SENTRY_* values.
import "dotenv/config";
import * as Sentry from "@sentry/node";
import {
  sanitizeUrl,
  scrubSensitiveUrls,
  shouldEnableSentry,
} from "./utils/sentryPrivacy";

const FALLBACK_DSN =
  "https://fa316355a0c709031621ffd77eb53a7a@o4512409661145088.ingest.us.sentry.io/4512409761087488";

const explicitDsn = process.env.SENTRY_DSN?.trim();
const dsn = explicitDsn || FALLBACK_DSN;

Sentry.init({
  dsn,
  // Explicit SENTRY_DSN opts in (including authorized local testing).
  // Render keeps the fallback DSN for production monitoring.
  // Ordinary local runs, including NODE_ENV=production without a DSN, stay quiet.
  enabled: shouldEnableSentry(),
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
  beforeSend(event) {
    return scrubSensitiveUrls(event) as typeof event;
  },
  // Default traceLifecycle is `stream`; beforeSendTransaction is ignored there.
  beforeSendSpan(span) {
    return scrubSensitiveUrls(span) as typeof span;
  },
  beforeBreadcrumb(breadcrumb) {
    // Console lines can carry Questions, coordinates, and image payloads.
    if (breadcrumb.category === "console") return null;
    if (breadcrumb.data) {
      const data = { ...breadcrumb.data };
      delete data["http.query"];
      delete data["http.fragment"];
      if (typeof data.url === "string") data.url = sanitizeUrl(data.url);
      if (typeof data["http.url"] === "string") {
        data["http.url"] = sanitizeUrl(String(data["http.url"]));
      }
      if (typeof data["http.target"] === "string") {
        data["http.target"] = sanitizeUrl(String(data["http.target"]));
      }
      breadcrumb.data = data;
    }
    if (typeof breadcrumb.message === "string" && breadcrumb.message.includes("/companion")) {
      breadcrumb.message = sanitizeUrl(breadcrumb.message);
    }
    return scrubSensitiveUrls(breadcrumb) as typeof breadcrumb;
  },
});
