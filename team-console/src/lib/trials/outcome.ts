import type { ReviewOutcome, Trial } from "./schema";

export type Outcome = ReviewOutcome | "unscored";

export const OUTCOME_LABELS: Record<ReviewOutcome, string> = {
  got_there: "Would get me there",
  needed_retake: "Needed a retake",
  would_not_get_there: "Would not get me there",
};

/** Trials reviewed before outcome scoring only have a pass/partial/fail status. */
export function outcomeOf(trial: Pick<Trial, "reviewOutcome">): Outcome {
  return trial.reviewOutcome ?? "unscored";
}
