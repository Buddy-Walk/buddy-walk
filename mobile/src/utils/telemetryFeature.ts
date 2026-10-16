/** Low-cardinality feature labels for analytics dashboards. */
export type TelemetryFeature =
  | 'photo_qa'
  | 'video_qa'
  | 'voice_qa'
  | 'directions'
  | 'mta'
  | 'saved_places'
  | 'location_qa'
  | 'general';

/**
 * Recognize short place/address inputs that imply navigation without classifying ordinary
 * questions or greetings as destinations.
 */
export function looksLikeBareDestination(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 120 || /[?!]/.test(trimmed)) return false;
  if (
    /^(?:hi|hello|thanks|thank you|what|who|why|how|when|is|are|can|could|would|should|tell|describe|explain)\b/i.test(
      trimmed
    )
  ) {
    return false;
  }

  const words = trimmed.split(/\s+/);
  if (words.length > 8) return false;

  return (
    /\d/.test(trimmed) ||
    /\b(?:street|st|avenue|ave|road|rd|boulevard|blvd|place|pl|plaza|square|park|station|terminal|store|market|pharmacy|bank|restaurant|cafe|coffee|library|hospital|hotel)\b/i.test(
      trimmed
    ) ||
    /^[A-Z][\w'&.-]*(?:\s+[A-Z0-9][\w'&.-]*){0,5}$/.test(trimmed)
  );
}

/**
 * Assign a consistent analytics feature to a request based on saved aliases, transit intent,
 * directions, and attached media.
 */
export function classifyFeature(input: {
  text: string;
  hasImage?: boolean;
  hasVideo?: boolean;
  savedAliases?: string[];
}): TelemetryFeature {
  const t = input.text.toLowerCase();

  if (input.savedAliases && input.savedAliases.length > 0) return 'saved_places';
  if (/train arriving|next .* train|subway|mta/.test(t)) return 'mta';
  if (
    /how do i get|directions|walk to|get to|go to|head to|route to|take me to|bring me to|navigate to/.test(
      t
    ) ||
    looksLikeBareDestination(input.text)
  ) {
    return 'directions';
  }
  if (input.hasVideo || /describe the video/.test(t)) return 'video_qa';
  if (input.hasImage) return 'photo_qa';
  if (/what street|intersection|near me|where am i|what direction/.test(t)) return 'location_qa';

  return 'general';
}

/**
 * Create a lightweight correlation ID used to connect events from one request across app and API
 * logs.
 */
export function createRequestId(): string {
  return `req_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}
