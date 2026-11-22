import { describe, expect, it } from "vite-plus/test";

import { failureExplanation } from "./failure";
import { trialFrom as trial } from "./fixtures";

// Expected text comes from the old dashboard's failureExplanation on the same Trials.
describe("failureExplanation", () => {
  it("has nothing to explain for a Trial that succeeded cleanly", () => {
    expect(failureExplanation(trial({ success: true }))).toBeNull();
  });

  it("explains why guidance was withheld from a Trial that answered, listing its failed steps", () => {
    expect(
      failureExplanation(
        trial({
          success: true,
          error: "entrance_not_visually_confirmed",
          steps: [
            { name: "target_store_match", success: false, response: "no storefront" },
            { name: "sign_text_match", success: false, error: "timeout", response: "ignored" },
            { name: "confidence_fusion", success: true, response: "ok" },
            { name: "destination_reference_match", success: false },
          ],
        }),
      ),
    ).toEqual({
      heading: "Why precise entrance guidance was withheld",
      summary:
        "Google Maps verified the destination nearby, but the storefront could not be visually confirmed in the Street View panorama, the reference image, or the sign close-ups (imagery may be outdated or the sign obscured). The user still received the distance and a compass-based turn; visual entrance verification was deliberately withheld.",
      details: ["target_store_match: no storefront", "sign_text_match: timeout"],
    });
  });

  it("explains a known error", () => {
    expect(
      failureExplanation(trial({ success: false, error: "heading_sources_disagree" })),
    ).toEqual({
      heading: "Why this run did not complete",
      summary:
        "The phone compass and the panorama match disagreed by 90 degrees or more about which way the user was facing. Buddy Walk deliberately withheld the turn and asked the user to recalibrate the compass and retake the photo, instead of guessing.",
      details: [],
    });
  });

  it("shows an unknown error first, before steps that failed without a name", () => {
    expect(
      failureExplanation(
        trial({ success: false, error: "boom", steps: [{ success: false, error: "no name" }] }),
      ),
    ).toEqual({
      heading: "Why this run did not complete",
      summary:
        "This Trial stopped before Buddy Walk could provide a fully verified localization result.",
      details: ["Backend error: boom", "Unknown stage: no name"],
    });
  });

  it("explains a failed Trial that recorded no error", () => {
    expect(failureExplanation(trial({ success: false }))).toEqual({
      heading: "Why this run did not complete",
      summary:
        "This Trial stopped before Buddy Walk could provide a fully verified localization result.",
      details: [],
    });
  });
});
