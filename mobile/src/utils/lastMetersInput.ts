/**
 * Turns whatever was typed or spoken into the Last Meters field into a place
 * name, or flags it as a question that belongs in the normal answer flow.
 * Shared by the app (before sending) and the server (for older app builds).
 */
export type LastMetersInput =
  | { kind: "destination"; destination: string; strippedLeadIn: boolean }
  | { kind: "question"; reason: "transit" | "question" };

const LEAD_IN =
  /^(?:(?:can|could|would|will) you\s+)?(?:please\s+)?(?:where(?:'s|’s| is| are)|take me to|bring me to|get me to|guide me to|lead me to|walk me to|navigate(?: me)? to|directions? to|how (?:do|can|would|could|should) i (?:get|go|walk) to|i(?:'m|’m| am) looking for|i need to (?:get to|go to|find)|i want to (?:get to|go to)|go to|head to|find(?: me)?|show me|locate)\s+/i;

const QUESTION_START =
  /^(?:what|what's|whats|who|why|when|which|how|is|are|am|does|do|did|can|could|should|will|would|describe|tell|explain|read|help)\b/i;

const TRANSIT_SUBJECT = /\b(?:train|trains|subway|bus|buses|mta)\b/i;
const TRANSIT_QUESTION = /\b(?:when|next|arriv\w*|schedule|how long|coming|leave|leaves|departs?)\b/i;
const STATION_WORD = /\b(?:station|stop|entrance|platform)\b/i;
/** "2 train", "the A train", "Q": a line, not a place. */
const BARE_TRAIN_LINE = /^(?:the\s+)?[a-z0-9]{1,2}\s+(?:train|line)$/i;

/**
 * Strip conversational filler, terminal punctuation, and entrance prefixes while preserving the
 * destination name used for place lookup.
 */
function cleanDestination(value: string): string {
  return value
    .replace(/[?.!]+\s*$/g, "")
    .replace(/^(?:the\s+)?(?:entrance|door|doors)\s+(?:of|to|for)\s+/i, "")
    .replace(/^(?:the|a|an)\s+/i, "")
    .replace(/\s+(?:please|from here|near me|nearby|around here)$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Classify Last Meters input as a destination or a general/transit question so question text is
 * not searched as a place name.
 */
export function parseLastMetersInput(input: string): LastMetersInput {
  const text = input.trim().replace(/\s+/g, " ");

  if (TRANSIT_SUBJECT.test(text) && TRANSIT_QUESTION.test(text) && !STATION_WORD.test(text)) {
    return { kind: "question", reason: "transit" };
  }

  const leadIn = text.match(LEAD_IN);
  if (leadIn) {
    const destination = cleanDestination(text.slice(leadIn[0].length));
    if (!destination || BARE_TRAIN_LINE.test(destination)) {
      return { kind: "question", reason: BARE_TRAIN_LINE.test(destination) ? "transit" : "question" };
    }
    return { kind: "destination", destination, strippedLeadIn: true };
  }

  if (QUESTION_START.test(text) || /\?\s*$/.test(text)) {
    return { kind: "question", reason: "question" };
  }

  const destination = cleanDestination(text);
  if (!destination) return { kind: "question", reason: "question" };
  if (BARE_TRAIN_LINE.test(destination)) return { kind: "question", reason: "transit" };
  return { kind: "destination", destination, strippedLeadIn: false };
}
