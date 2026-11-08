import { describe, expect, it } from "vite-plus/test";

import { trialDetailFrom, trialFrom } from "./fixtures";
import {
  detailWithReview,
  quickReview,
  reviewFieldsOf,
  reviewFromFields,
  reviewRequest,
  trialsWithReview,
} from "./review";
import { savedReviewResponseSchema } from "./schema";
import { summarizeTrials } from "./summary";

const saved = {
  reviewOutcome: "got_there",
  reviewerStatus: "pass",
  turnCorrectness: "correct",
  reviewerNotes: "Found it",
} as const;

describe("trialsWithReview", () => {
  const rows = [
    trialFrom({ _id: "a", destination: "CVS", reviewOutcome: "would_not_get_there" }),
    trialFrom({ _id: "b", destination: "Target" }),
  ];

  it("updates only the reviewed row", () => {
    const [first, second] = trialsWithReview(rows, "b", saved);
    expect(first).toBe(rows[0]);
    expect(second).toMatchObject({ _id: "b", destination: "Target", ...saved });
  });

  it("moves the summary numbers", () => {
    expect(summarizeTrials(rows)).toMatchObject({ scored: 1, success: 0, rate: 0 });
    expect(summarizeTrials(trialsWithReview(rows, "b", saved))).toMatchObject({
      scored: 2,
      success: 1,
      rate: 50,
      wrongTurns: { wrong: 0, scored: 1 },
    });
  });
});

describe("detailWithReview", () => {
  const entry = (id: string, isRetry: boolean) => ({
    id,
    isRetry,
    defaultsApplied: [],
    safetyReasons: [],
  });
  const detail = trialDetailFrom({
    _id: "original",
    userPhoto: "data:image/jpeg;base64,AAAA",
    history: {
      originalId: "original",
      original: entry("original", false),
      retries: [entry("retry-1", true), entry("retry-2", true)],
    },
  });

  it("updates the open Trial and its own line in the retry history", () => {
    const updated = detailWithReview(detail, "original", saved);
    expect(updated).toMatchObject({ ...saved, userPhoto: "data:image/jpeg;base64,AAAA" });
    expect(updated.history?.original).toMatchObject({
      reviewOutcome: "got_there",
      reviewerStatus: "pass",
    });
    expect(updated.history?.retries[0].reviewOutcome).toBeUndefined();
  });

  it("updates a retry's line when another run of the history is open", () => {
    const updated = detailWithReview(detail, "retry-2", saved);
    expect(updated.reviewOutcome).toBeUndefined();
    expect(updated.history?.retries[1].reviewOutcome).toBe("got_there");
    expect(updated.history?.retries[0].reviewOutcome).toBeUndefined();
  });

  it("handles a retry whose original no longer exists", () => {
    const orphan = trialDetailFrom({
      _id: "retry-1",
      history: { originalId: "gone", original: null, retries: [entry("retry-1", true)] },
    });
    const updated = detailWithReview(orphan, "retry-1", saved);
    expect(updated.history?.original).toBeNull();
    expect(updated.history?.retries[0].reviewOutcome).toBe("got_there");
  });
});

describe("savedReviewResponseSchema", () => {
  // findByIdAndUpdate's document: every saved field, images included, none computed.
  const savedDocument = {
    _id: "6720f1c2a1b2c3d4e5f60718",
    destination: "CVS",
    userPhoto: "data:image/jpeg;base64,AAAA",
    panoramaPhoto: "data:image/jpeg;base64,BBBB",
    reviewOutcome: "needed_retake",
    reviewerStatus: "partial",
    turnCorrectness: "wrong",
    entranceCorrectness: "correct",
    reviewerNotes: "Side door",
    reviewedAt: "2026-11-08T12:00:00.000Z",
  };

  it("keeps only the review from the saved document", () => {
    expect(savedReviewResponseSchema.parse({ source: "mongo", data: savedDocument }).data).toEqual({
      reviewOutcome: "needed_retake",
      reviewerStatus: "partial",
      turnCorrectness: "wrong",
      entranceCorrectness: "correct",
      reviewerNotes: "Side door",
    });
  });

  it("reads a saved field in an older shape as missing", () => {
    const { data } = savedReviewResponseSchema.parse({
      data: { ...savedDocument, turnCorrectness: "sideways", reviewerNotes: 7 },
    });
    expect(data.turnCorrectness).toBeUndefined();
    expect(data.reviewerNotes).toBeUndefined();
    expect(data.reviewOutcome).toBe("needed_retake");
  });
});

describe("reviewRequest", () => {
  it.each([
    ["got_there", "pass"],
    ["needed_retake", "partial"],
    ["would_not_get_there", "fail"],
  ] as const)("writes %s with the older status %s", (reviewOutcome, reviewerStatus) => {
    expect(reviewRequest({ reviewOutcome, reviewerNotes: "" })).toEqual({
      reviewOutcome,
      reviewerStatus,
      reviewerNotes: "",
    });
  });
});

describe("quickReview", () => {
  it("keeps the saved notes and leaves turn and entrance alone", () => {
    const trial = trialFrom({
      reviewerNotes: "Door was on the side",
      turnCorrectness: "wrong",
      entranceCorrectness: "correct",
    });
    expect(quickReview(trial, "needed_retake")).toEqual({
      reviewOutcome: "needed_retake",
      reviewerNotes: "Door was on the side",
    });
  });

  it("sends empty notes for a Trial without any", () => {
    expect(quickReview(trialFrom(), "got_there").reviewerNotes).toBe("");
  });
});

describe("reviewFieldsOf", () => {
  it("fills the form from a saved review", () => {
    const trial = trialFrom({
      reviewOutcome: "got_there",
      turnCorrectness: "no_turn_given",
      entranceCorrectness: "not_identified",
      reviewerNotes: "Fine",
    });
    expect(reviewFieldsOf(trial)).toEqual({
      outcome: "got_there",
      turn: "no_turn_given",
      entrance: "not_identified",
      notes: "Fine",
    });
  });

  it("starts empty on an unreviewed Trial", () => {
    expect(reviewFieldsOf(trialFrom())).toEqual({ outcome: "", turn: "", entrance: "", notes: "" });
  });

  it("reads a review from before outcome scoring by its status", () => {
    expect(reviewFieldsOf(trialFrom({ reviewerStatus: "partial" })).outcome).toBe("needed_retake");
  });
});

describe("reviewFromFields", () => {
  it("is undefined without an outcome, which a review requires", () => {
    expect(
      reviewFromFields({ outcome: "", turn: "correct", entrance: "", notes: "Hm" }),
    ).toBeUndefined();
  });

  it("leaves out a turn and entrance that are not scored", () => {
    expect(
      reviewFromFields({ outcome: "got_there", turn: "", entrance: "", notes: "" }),
    ).toStrictEqual({ reviewOutcome: "got_there", reviewerNotes: "" });
  });

  it("includes a scored turn and entrance", () => {
    expect(
      reviewFromFields({ outcome: "got_there", turn: "wrong", entrance: "correct", notes: "n" }),
    ).toStrictEqual({
      reviewOutcome: "got_there",
      turnCorrectness: "wrong",
      entranceCorrectness: "correct",
      reviewerNotes: "n",
    });
  });
});
