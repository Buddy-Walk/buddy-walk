// The usage data scripts/local-stack.ts loads into its throwaway Mongo, by collection.
// Dates are all different, so mobile/server's newest-first exports have one order.

type Doc = Record<string, unknown>;

const at = (iso: string) => ({ $date: iso });

const event = (name: string, installId: string, day: string, props?: Doc): Doc => ({
  installId,
  sessionId: `session-${installId}`,
  name,
  ...(props ? { props } : {}),
  platform: "ios",
  appVersion: "1.2.0",
  serverTs: at(`${day}T12:00:00.000Z`),
});

const aiRequest = (feature: string, day: string, latencyMs: number, success: boolean): Doc => ({
  requestId: `request-${day}`,
  installId: "install-a",
  feature,
  toolUsed: "none",
  inputLength: 12,
  hasImage: false,
  imageCount: 0,
  hasCoords: true,
  success,
  latencyMs,
  serverTs: at(`${day}T12:00:00.000Z`),
});

const feedback = (type: string, day: string, message: string, rating?: number): Doc => ({
  installId: "install-a",
  type,
  ...(rating === undefined ? {} : { rating }),
  message,
  platform: "ios",
  appVersion: "1.2.0",
  date: at(`${day}T12:00:00.000Z`),
});

const chat = (day: string, input: string, output: string): Doc => ({
  user: "install-a",
  date: at(`${day}T12:00:00.000Z`),
  messages: [{ input, output, imageURL: "", location: { lat: 40.7, lon: -74 }, flag: false }],
});

export function seededUsage(): Record<string, Doc[]> {
  return {
    telemetry_events: [
      event("question_asked", "install-a", "2026-10-01", { feature: "directions" }),
      event("answer_received", "install-a", "2026-10-02", {
        feature: "directions",
        latencyMs: 1000,
      }),
      event("answer_received", "install-b", "2026-10-03", { feature: "trains", latencyMs: 2000 }),
      event("app_open", "install-b", "2026-11-01"),
      // props are whatever the app sent, so a feature isn't always a string.
      event("question_asked", "install-c", "2026-11-02", { feature: 42 }),
    ],
    ai_request_log: [
      aiRequest("question", "2026-10-02", 1000, true),
      aiRequest("question", "2026-10-03", 2000, true),
      aiRequest("question", "2026-10-04", 3000, false),
      aiRequest("last_meters", "2026-11-01", 500, true),
    ],
    feedback: [
      feedback("bug", "2026-10-01", "Crash on launch"),
      feedback("general", "2026-10-02", 'Said "left, then right"', 4),
      feedback("answer_rating", "2026-10-03", "Wrong turn", -1),
      feedback("answer_rating", "2026-11-03", "Very helpful", 1),
    ],
    chat_log: [
      chat("2026-10-05", "Where is the train?", "Two blocks north."),
      chat("2026-11-04", "Is it open?", "Yes, until 9, on weekdays."),
    ],
  };
}
