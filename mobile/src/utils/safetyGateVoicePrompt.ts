const PROMPTS: ReadonlyMap<string, string> = new Map([
  ['bearing_uncertainty_too_large', 'I cannot reliably determine the direction to the destination. Stay in a safe place and wait for a more accurate location reading before trying again.'],
  ['destination_branch_ambiguous', 'I found more than one possible destination. Please enter a more specific store name or street address.'],
  ['capture_metadata_missing', 'I could not link this photo to its location and direction readings. Stay in a safe place and take a new photo.'],
  ['moved_since_capture', 'Your reported position changed after the photo. Stay in a safe place and take a new photo before following a turn.'],
  ['turned_since_capture', "Your phone's direction changed after the photo. Stay in a safe place, hold the phone steady, and take a new photo."],
  ['gps_uncertain', 'Your location is not accurate enough for a precise turn. Stay in a safe place and wait for a more accurate reading before trying again.'],
  ['current_heading_unavailable', 'I do not have a usable phone direction. Stay in a safe place and wait for the compass to update before trying again.'],
  ['heading_sources_disagree', "Your phone compass and the photo-based direction disagree. Stay in a safe place, recheck the phone's direction, and take a new photo."],
  ['orientation_not_corroborated', "I could not confirm the phone's direction from this view. Stay in a safe place and take a clear, current photo."],
  ['entrance_not_visually_confirmed', 'I found the destination on the map, but could not confirm its entrance. Use your primary navigation or ask for assistance.'],
  ['capture_gps_stale', 'The location reading linked to this photo is out of date. Stay in a safe place, wait for a fresh location reading, and take a new photo.'],
  ['confidence_not_high', 'I do not have enough reliable information for a precise turn. Stay in a safe place and take a clear, current photo.'],
  ['current_gps_unavailable', 'Your current location is unavailable. Stay in a safe place, wait for a fresh location reading, and try again.'],
]);

const MULTIPLE_REASONS_PROMPT =
  'I could not confirm your current direction. Stay in a safe place and take a new photo before following a turn.';

/** Speech only: unknown reasons leave the backend's original response unchanged. */
export function getSafetyGateVoicePrompt(
  safetyReasons?: readonly string[] | null,
  warning?: string,
): string | undefined {
  const known = new Set(safetyReasons?.filter(reason => PROMPTS.has(reason)));
  if (warning && PROMPTS.has(warning)) known.add(warning);
  if (!known.size) return undefined;

  // Fixed recovery order, independent of the server's reason-array ordering.
  for (const reason of ['destination_branch_ambiguous', 'current_gps_unavailable', 'gps_uncertain']) {
    if (known.has(reason)) return PROMPTS.get(reason);
  }
  if (known.size > 1) return MULTIPLE_REASONS_PROMPT;
  return PROMPTS.get(known.values().next().value!);
}
