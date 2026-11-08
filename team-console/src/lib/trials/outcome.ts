import type {
  EntranceCorrectness,
  ReviewerStatus,
  ReviewOutcome,
  Trial,
  TurnCorrectness,
} from "./schema";

export type Outcome = ReviewOutcome | "unscored";

export const OUTCOME_LABELS: Record<ReviewOutcome, string> = {
  got_there: "Would get me there",
  needed_retake: "Needed a retake",
  would_not_get_there: "Would not get me there",
};

export const TURN_LABELS: Record<TurnCorrectness, string> = {
  correct: "Turn was correct",
  wrong: "Turn was wrong",
  no_turn_given: "No turn given",
};

export const ENTRANCE_LABELS: Record<EntranceCorrectness, string> = {
  correct: "Right entrance",
  wrong: "Wrong entrance",
  not_identified: "Entrance not identified",
};

const OUTCOME_FOR_STATUS: Partial<Record<ReviewerStatus, ReviewOutcome>> = {
  pass: "got_there",
  partial: "needed_retake",
  fail: "would_not_get_there",
};

/** What a review writes to the older field, which pass/partial/fail exports still read. */
export const STATUS_FOR_OUTCOME: Record<ReviewOutcome, ReviewerStatus> = {
  got_there: "pass",
  needed_retake: "partial",
  would_not_get_there: "fail",
};

/** Trials reviewed before outcome scoring only have a pass/partial/fail status. */
export function outcomeOf(trial: Pick<Trial, "reviewOutcome" | "reviewerStatus">): Outcome {
  return (
    trial.reviewOutcome ??
    (trial.reviewerStatus && OUTCOME_FOR_STATUS[trial.reviewerStatus]) ??
    "unscored"
  );
}
