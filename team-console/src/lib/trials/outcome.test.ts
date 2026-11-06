import { describe, expect, it } from "vite-plus/test";

import { outcomeOf } from "./outcome";

describe("outcomeOf", () => {
  it("reads the reviewer's outcome", () => {
    expect(outcomeOf({ reviewOutcome: "needed_retake" })).toBe("needed_retake");
  });

  // Trials reviewed before outcomes only have a pass/partial/fail status, which the schema drops.
  it("counts a Trial without an outcome as unscored", () => {
    expect(outcomeOf({})).toBe("unscored");
  });
});
