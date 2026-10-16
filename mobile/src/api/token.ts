import { aiClient, apiClient } from './client';

interface SpeechToken {
  token: string;
  region: string;
}

/**
 * Azure speech tokens live ~10 minutes. Cache one client-side so Tap to Ask
 * never waits on a token round-trip (previously it re-fetched through the
 * Render proxy, which added cold-start latency and timeouts).
 */
const TOKEN_TTL_MS = 9 * 60 * 1000;

let cached: { value: SpeechToken; fetchedAt: number } | null = null;
let inFlight: Promise<SpeechToken> | null = null;

/** Check whether the cached Azure speech token is still inside its usable lifetime. */
function isFresh(): boolean {
  return !!cached && Date.now() - cached.fetchedAt < TOKEN_TTL_MS;
}

/**
 * Fetch a valid speech token from the configured AI host, falling back to the mobile API with a
 * longer cold-start timeout.
 */
async function fetchToken(): Promise<SpeechToken> {
  // Direct upstream first (fast, no Render cold start), Render as fallback.
  try {
    const response = await aiClient.get('/token/getToken', { timeout: 15_000 });
    if (response.data?.token && response.data?.region) {
      return { token: response.data.token, region: response.data.region };
    }
  } catch (e) {
    console.warn('getToken: direct AI host failed, falling back to Render', e);
  }

  const response = await apiClient.get('/token/getToken', { timeout: 45_000 });
  if (response.data?.token && response.data?.region) {
    return { token: response.data.token, region: response.data.region };
  }

  throw new Error('Failed to fetch speech token');
}

/**
 * Reuse a fresh speech token or share a single in-flight refresh across callers to avoid duplicate
 * token requests.
 */
export async function getToken(): Promise<SpeechToken> {
  if (isFresh()) return cached!.value;

  if (!inFlight) {
    inFlight = fetchToken()
      .then((value) => {
        // Cache the newly fetched speech token together with the time used to determine
        // expiration.
        cached = { value, fetchedAt: Date.now() };
        return value;
      })
      .finally(() => {
        // Release the shared refresh promise so a later request can retry after success or
        // failure.
        inFlight = null;
      });
  }
  return inFlight;
}

/** Warm the token cache without blocking the caller (fire on app launch). */
export function prefetchToken(): void {
  void getToken().catch(() => { /* Ignore a speculative token-prefetch failure; the actual speech request can report or retry it later. */ });
}
