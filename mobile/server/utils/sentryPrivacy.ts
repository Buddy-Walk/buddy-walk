/** Privacy helpers for API Sentry payloads. Kept pure so tests can prove scrubbing. */

const COMPANION_TOKEN_PLACEHOLDER = "[redacted]";

/** Reserved `/api/companion/...` segments that are not bearer tokens. */
const COMPANION_API_LITERALS = new Set([
  "health",
  "create",
  "ping",
  "stop",
  "snapshot",
]);

/** Drop the query string and fragment, where coordinates and API keys travel. */
export function withoutQuery(url: string): string {
  const query = url.indexOf("?");
  const hash = url.indexOf("#");
  let end = url.length;
  if (query >= 0) end = Math.min(end, query);
  if (hash >= 0) end = Math.min(end, hash);
  return url.slice(0, end);
}

/**
 * Replace companion bearer tokens that sit in URL path segments.
 * Covers `/companion/:token` and `/api/companion/:token/...`, including
 * percent-encoded forms. Reserved companion API verbs stay intact.
 */
export function sanitizeUrl(url: string): string {
  const base = withoutQuery(url);
  let decoded = base;
  try {
    decoded = decodeURIComponent(base);
  } catch {
    decoded = base;
  }

  return decoded
    .replace(
      /\/api\/companion\/([^/?#]+)(\/|$)/gi,
      (match, segment: string, tail: string) => {
        if (COMPANION_API_LITERALS.has(segment.toLowerCase())) return match;
        return `/api/companion/${COMPANION_TOKEN_PLACEHOLDER}${tail}`;
      },
    )
    // Do not rematch the `/companion/` inside `/api/companion/...`.
    .replace(
      /(?<!api)\/companion\/([^/?#]+)(\/|$)/gi,
      (_match, _segment: string, tail: string) =>
        `/companion/${COMPANION_TOKEN_PLACEHOLDER}${tail}`,
    );
}

const URLISH_KEYS = new Set([
  "url",
  "http.url",
  "http.target",
  "url.full",
  "url.path",
  "uri",
  "request_url",
  "path",
]);

function scrubStringValue(key: string | undefined, value: string): string {
  if (key && URLISH_KEYS.has(key)) return sanitizeUrl(value);
  if (
    value.includes("/companion/") ||
    value.includes("/api/companion/") ||
    /%2[fF]companion%2[fF]/i.test(value) ||
    /%2[fF]api%2[fF]companion%2[fF]/i.test(value)
  ) {
    return sanitizeUrl(value);
  }
  return value;
}

/** Walk a JSON-like payload and scrub companion tokens from URL-bearing strings. */
export function scrubSensitiveUrls(value: unknown, key?: string): unknown {
  if (typeof value === "string") return scrubStringValue(key, value);
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map((item) => scrubSensitiveUrls(item, key));
  }
  const out: Record<string, unknown> = {};
  for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
    out[childKey] = scrubSensitiveUrls(child, childKey);
  }
  return out;
}

/** Local runs stay quiet unless SENTRY_DSN is set; Render keeps monitoring. */
export function shouldEnableSentry(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.SENTRY_DSN && env.SENTRY_DSN.trim()) return true;
  return Boolean(env.RENDER || env.RENDER_SERVICE_ID);
}
