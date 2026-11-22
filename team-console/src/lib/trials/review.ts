import { z } from "zod";

import { outcomeOf, STATUS_FOR_OUTCOME } from "./outcome";
import {
  ENTRANCE_CORRECTNESS,
  REVIEW_OUTCOMES,
  TURN_CORRECTNESS,
  type EntranceCorrectness,
  type RetryHistoryEntry,
  type ReviewOutcome,
  type SavedReview,
  type Trial,
  type TrialDetail,
  type TurnCorrectness,
} from "./schema";

export const reviewInputSchema = z.object({
  reviewOutcome: z.enum(REVIEW_OUTCOMES),
  turnCorrectness: z.enum(TURN_CORRECTNESS).optional(),
  entranceCorrectness: z.enum(ENTRANCE_CORRECTNESS).optional(),
  reviewerNotes: z.string(),
});
export type ReviewInput = z.output<typeof reviewInputSchema>;

/** The detail's review form; an empty select is unset. */
export interface ReviewFields {
  outcome: ReviewOutcome | "";
  turn: TurnCorrectness | "";
  entrance: EntranceCorrectness | "";
  notes: string;
}

/** The body of mobile/server's PATCH /api/last-meters-tests/:id/review. */
export function reviewRequest(review: ReviewInput) {
  return { ...review, reviewerStatus: STATUS_FOR_OUTCOME[review.reviewOutcome] };
}

/** Scoring from the table: mobile/server keeps a turn and entrance it isn't sent. */
export function quickReview(
  trial: Pick<Trial, "reviewerNotes">,
  reviewOutcome: ReviewOutcome,
): ReviewInput {
  return { reviewOutcome, reviewerNotes: trial.reviewerNotes ?? "" };
}

export function reviewFieldsOf(trial: Trial): ReviewFields {
  const outcome = outcomeOf(trial);
  return {
    outcome: outcome === "unscored" ? "" : outcome,
    turn: trial.turnCorrectness ?? "",
    entrance: trial.entranceCorrectness ?? "",
    notes: trial.reviewerNotes ?? "",
  };
}

export function trialsWithReview(trials: Trial[], trialId: string, saved: SavedReview): Trial[] {
  return trials.map((trial) => (trial._id === trialId ? { ...trial, ...saved } : trial));
}

/** The Trial if it is the one reviewed, and that run's line in its retry history. */
export function detailWithReview(
  detail: TrialDetail,
  trialId: string,
  saved: SavedReview,
): TrialDetail {
  const { reviewOutcome, reviewerStatus } = saved;
  const entryWithReview = (entry: RetryHistoryEntry) =>
    entry.id === trialId ? { ...entry, reviewOutcome, reviewerStatus } : entry;
  return {
    ...detail,
    ...(detail._id === trialId ? saved : {}),
    history: detail.history && {
      ...detail.history,
      original: detail.history.original && entryWithReview(detail.history.original),
      retries: detail.history.retries.map(entryWithReview),
    },
  };
}

/** The review to save, or undefined until an outcome is chosen. */
export function reviewFromFields(fields: ReviewFields): ReviewInput | undefined {
  if (!fields.outcome) return undefined;
  return {
    reviewOutcome: fields.outcome,
    ...(fields.turn ? { turnCorrectness: fields.turn } : {}),
    ...(fields.entrance ? { entranceCorrectness: fields.entrance } : {}),
    reviewerNotes: fields.notes,
  };
}
