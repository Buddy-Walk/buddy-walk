import { history } from "../types";

const MAX_HISTORY = 20;
const store = new Map<string, history[]>();

type AnalyticsIds = {
  installId?: string;
  sessionId?: string;
  conversationId?: string;
  resetHistory?: boolean;
};

/**
 * Scope in-memory history to an installation and conversation, with session/anonymous fallbacks
 * for older callers.
 */
function historyKey(analytics?: AnalyticsIds): string {
  const install = analytics?.installId?.trim() || "anonymous";
  const conversation =
    analytics?.conversationId?.trim() ||
    analytics?.sessionId?.trim() ||
    "default";
  return `${install}:${conversation}`;
}

/**
 * Return a copied conversation history, clearing it first when the caller explicitly starts a new
 * interaction.
 */
export function getConversationHistory(analytics?: AnalyticsIds): history[] {
  if (analytics?.resetHistory) {
    clearConversationHistory(analytics);
    return [];
  }
  return [...(store.get(historyKey(analytics)) ?? [])];
}

/** Append one exchange to the conversation's bounded history and evict the oldest exchanges. */
export function appendConversationHistory(
  analytics: AnalyticsIds | undefined,
  entry: history
): history[] {
  const key = historyKey(analytics);
  const list = [...(store.get(key) ?? [])];
  list.push(entry);
  while (list.length > MAX_HISTORY) list.shift();
  store.set(key, list);
  return list;
}

/** Remove only the requesting installation/conversation's cached history. */
export function clearConversationHistory(analytics?: AnalyticsIds): void {
  store.delete(historyKey(analytics));
}

/** Format prior exchanges for the AI prompt, explicitly marking a fresh session with no context. */
export function formatHistoryForPrompt(entries: history[]): string {
  if (entries.length === 0) return "(none — fresh test session)";
  return entries
    .map(
      /** Serialize one previous question, answer, and evidence description into a prompt line. */
      (h) =>
        `User Input: ${h.input}, AI Output: ${h.output}, Data Used: ${h.data}`
    )
    .join("\n");
}
