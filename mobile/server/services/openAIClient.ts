import OpenAI from "openai";

/**
 * Every call here asks for a short answer, so none should wait the library's
 * default of 10 minutes per attempt. A stalled call would otherwise hold a
 * field test, or a dashboard retry's slot, for half an hour. The library's two
 * retries stay, since a third attempt often gets through a burst of 429s.
 */
const OPENAI_TIMEOUT_MS = 90_000;
const OPENAI_MAX_RETRIES = 2;

let client: OpenAI | null = null;

/** The server's one OpenAI client, created on first use so the server starts without the key. */
export function getOpenAIClient(): OpenAI {
  if (!client) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY is not configured on the server");
    }
    client = new OpenAI({ apiKey, timeout: OPENAI_TIMEOUT_MS, maxRetries: OPENAI_MAX_RETRIES });
  }
  return client;
}
