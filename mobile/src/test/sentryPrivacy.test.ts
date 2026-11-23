import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import * as Sentry from "@sentry/node";
import {
  sanitizeUrl,
  scrubSensitiveUrls,
  shouldEnableSentry,
  withoutQuery,
} from "../../server/utils/sentryPrivacy";

const SYNTHETIC_TOKEN = "bw-sentry-test-token-9f3c2a1b7e44";

describe("sentryPrivacy URL scrubbing", () => {
  it("strips query strings that can carry GPS or keys", () => {
    assert.equal(
      withoutQuery(`/api/companion/snapshot?token=${SYNTHETIC_TOKEN}&lat=40.7`),
      "/api/companion/snapshot",
    );
  });

  it("redacts companion viewer and legacy API token path segments", () => {
    assert.equal(
      sanitizeUrl(`https://api.example/companion/${SYNTHETIC_TOKEN}`),
      "https://api.example/companion/[redacted]",
    );
    assert.equal(
      sanitizeUrl(`/api/companion/${SYNTHETIC_TOKEN}/snapshot`),
      "/api/companion/[redacted]/snapshot",
    );
    assert.equal(
      sanitizeUrl(`/api/companion/${SYNTHETIC_TOKEN}/ping?lat=1`),
      "/api/companion/[redacted]/ping",
    );
  });

  it("keeps non-token companion routes useful for debugging", () => {
    for (const path of [
      "/api/companion/health",
      "/api/companion/create",
      "/api/companion/ping",
      "/api/companion/stop",
      "/api/companion/snapshot",
      "/api/last-meters",
      "/api/health",
    ]) {
      assert.equal(sanitizeUrl(path), path);
    }
  });

  it("redacts percent-encoded companion token paths", () => {
    const encoded = encodeURIComponent(`/companion/${SYNTHETIC_TOKEN}`);
    // encodeURIComponent encodes the whole path; scrub after decode of a full URL path piece.
    assert.equal(
      sanitizeUrl(`/api%2Fcompanion%2F${encodeURIComponent(SYNTHETIC_TOKEN)}%2Fsnapshot`),
      "/api/companion/[redacted]/snapshot",
    );
    assert.ok(!sanitizeUrl(encoded).includes(SYNTHETIC_TOKEN));
  });

  it("scrubs nested event, span, and breadcrumb URL fields", () => {
    const payload = {
      request: { url: `https://host/companion/${SYNTHETIC_TOKEN}` },
      breadcrumbs: [
        {
          data: {
            url: `/api/companion/${SYNTHETIC_TOKEN}/stop`,
            "http.url": `/api/companion/${SYNTHETIC_TOKEN}/ping`,
          },
        },
      ],
      contexts: {
        trace: {
          data: {
            "url.full": `https://host/api/companion/${SYNTHETIC_TOKEN}/snapshot`,
          },
        },
      },
      extra: {
        path: `/companion/${SYNTHETIC_TOKEN}`,
        note: "ordinary non-url text stays",
      },
    };
    const scrubbed = scrubSensitiveUrls(payload) as typeof payload;
    const serialized = JSON.stringify(scrubbed);
    assert.equal(serialized.includes(SYNTHETIC_TOKEN), false);
    assert.equal(scrubbed.request.url, "https://host/companion/[redacted]");
    assert.equal(scrubbed.breadcrumbs[0].data.url, "/api/companion/[redacted]/stop");
    assert.equal(scrubbed.breadcrumbs[0].data["http.url"], "/api/companion/[redacted]/ping");
    assert.equal(
      scrubbed.contexts.trace.data["url.full"],
      "https://host/api/companion/[redacted]/snapshot",
    );
    assert.equal(scrubbed.extra.path, "/companion/[redacted]");
    assert.equal(scrubbed.extra.note, "ordinary non-url text stays");
  });
});

describe("sentryPrivacy enablement", () => {
  it("stays disabled for ordinary local and local production-mode runs", () => {
    assert.equal(shouldEnableSentry({ NODE_ENV: "development" }), false);
    assert.equal(shouldEnableSentry({ NODE_ENV: "production" }), false);
    assert.equal(shouldEnableSentry({ NODE_ENV: "production", SENTRY_DSN: "  " }), false);
  });

  it("enables for explicit DSN testing and for Render", () => {
    assert.equal(
      shouldEnableSentry({ SENTRY_DSN: "https://examplePublicKey@o0.ingest.sentry.io/0" }),
      true,
    );
    assert.equal(shouldEnableSentry({ RENDER: "true" }), true);
    assert.equal(shouldEnableSentry({ RENDER_SERVICE_ID: "srv-123" }), true);
  });
});

describe("sentryPrivacy transport isolation", () => {
  const previous = { ...process.env };
  const envelopes: unknown[] = [];

  afterEach(async () => {
    await Sentry.close(2000).catch(() => undefined);
    process.env = { ...previous };
    envelopes.length = 0;
  });

  it("sanitizes companion tokens before a sampled span and captured error leave the process", async () => {
    process.env.SENTRY_DSN = "https://examplePublicKey@o0.ingest.sentry.io/0";
    process.env.NODE_ENV = "test";

    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      enabled: true,
      tracesSampleRate: 1.0,
      transport: () => ({
        send(envelope) {
          envelopes.push(envelope);
          return Promise.resolve({ statusCode: 200 });
        },
        flush() {
          return Promise.resolve(true);
        },
      }),
      beforeSend(event) {
        return scrubSensitiveUrls(event) as typeof event;
      },
      beforeSendSpan(span) {
        return scrubSensitiveUrls(span) as typeof span;
      },
      beforeBreadcrumb(breadcrumb) {
        return scrubSensitiveUrls(breadcrumb) as typeof breadcrumb;
      },
    });

    await Sentry.startSpan(
      {
        name: "companion-request",
        attributes: {
          "url.full": `https://host/api/companion/${SYNTHETIC_TOKEN}/snapshot`,
          "http.url": `/api/companion/${SYNTHETIC_TOKEN}/snapshot`,
        },
      },
      () => undefined,
    );

    Sentry.addBreadcrumb({
      category: "http",
      data: { url: `/companion/${SYNTHETIC_TOKEN}` },
    });
    Sentry.captureEvent({
      message: "companion-test-error",
      level: "error",
      request: { url: `https://host/companion/${SYNTHETIC_TOKEN}` },
      breadcrumbs: [
        {
          category: "http",
          data: {
            url: `/api/companion/${SYNTHETIC_TOKEN}/ping`,
            "http.target": `/api/companion/${SYNTHETIC_TOKEN}/ping`,
          },
        },
      ],
    });

    await Sentry.flush(2000);

    const serialized = JSON.stringify(envelopes);
    assert.ok(envelopes.length > 0, "expected the isolated transport to receive payloads");
    assert.equal(serialized.includes(SYNTHETIC_TOKEN), false);
    assert.ok(
      serialized.includes("/companion/[redacted]") ||
        serialized.includes("/api/companion/[redacted]"),
      "expected redacted companion paths in transmitted payloads",
    );
  });
});
