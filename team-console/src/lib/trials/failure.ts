import type { Trial } from "./schema";

export interface FailureExplanation {
  heading: string;
  summary: string;
  /** Unknown errors and the steps that failed, in plain lines. */
  details: string[];
}

const EXPLANATIONS: Record<string, string> = {
  destination_not_verified:
    "Google Places could not confirm the requested destination within the local search area. The name may be ambiguous, the phone location may be inaccurate, or Google may not have returned the business.",
  compass_heading_unavailable:
    "The phone did not provide a usable compass reading. Buddy Walk did not calculate a turn because compass heading is required for guidance.",
  heading_sources_disagree:
    "The phone compass and the panorama match disagreed by 90 degrees or more about which way the user was facing. Buddy Walk deliberately withheld the turn and asked the user to recalibrate the compass and retake the photo, instead of guessing.",
  destination_not_visible:
    "The destination could not be visually confirmed in the Street View panorama or the nearby reference image. Buddy Walk intentionally withheld turn guidance.",
  current_view_not_visible:
    "The user photo could not be matched confidently to the Street View panorama.",
  entrance_not_visually_confirmed:
    "Google Maps verified the destination nearby, but the storefront could not be visually confirmed in the Street View panorama, the reference image, or the sign close-ups (imagery may be outdated or the sign obscured). The user still received the distance and a compass-based turn; visual entrance verification was deliberately withheld.",
  no_outdoor_panorama:
    "No suitable outdoor panorama was available in this Trial. Check the recorded guidance for whether a map-based turn was provided by the older pipeline.",
  no_validated_outdoor_panorama:
    "No nearby panorama passed outdoor visual validation. Indoor, uncertain, duplicate, distant, and failed candidates are logged below. Precise turn and entrance guidance was withheld.",
};

const UNEXPLAINED =
  "This Trial stopped before Buddy Walk could provide a fully verified localization result.";

/** Why a Trial failed or withheld guidance, or null when it succeeded cleanly. */
export function failureExplanation(trial: Trial): FailureExplanation | null {
  if (trial.success && !trial.error) return null;

  const known =
    trial.error && Object.hasOwn(EXPLANATIONS, trial.error) ? EXPLANATIONS[trial.error] : undefined;
  const failedSteps = trial.steps
    .filter((step) => !step.success && (step.error || step.response))
    .map((step) => `${step.name || "Unknown stage"}: ${step.error || step.response}`);

  return {
    heading: trial.success
      ? "Why precise entrance guidance was withheld"
      : "Why this run did not complete",
    summary: known ?? UNEXPLAINED,
    details:
      trial.error && !known ? [`Backend error: ${trial.error}`, ...failedSteps] : failedSteps,
  };
}
