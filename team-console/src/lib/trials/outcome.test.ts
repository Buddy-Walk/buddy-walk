import { describe, expect, it } from "vite-plus/test";

import { outcomeOf } from "./outcome";

describe("outcomeOf", () => {
  it("reads the reviewer's outcome", () => {
    expect(outcomeOf({ reviewOutcome: "needed_retake" })).toBe("needed_retake");
  });

  it("reads a review from before outcome scoring by its pass/partial/fail status", () => {
    expect(outcomeOf({ reviewerStatus: "pass" })).toBe("got_there");
    expect(outcomeOf({ reviewerStatus: "partial" })).toBe("needed_retake");
    expect(outcomeOf({ reviewerStatus: "fail" })).toBe("would_not_get_there");
  });

  it("prefers the outcome when a Trial has both", () => {
    expect(outcomeOf({ reviewOutcome: "needed_retake", reviewerStatus: "pass" })).toBe(
      "needed_retake",
    );
  });

  it("counts a Trial without a review as unscored", () => {
    expect(outcomeOf({})).toBe("unscored");
    expect(outcomeOf({ reviewerStatus: "untested" })).toBe("unscored");
  });
});
