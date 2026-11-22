import { describe, expect, it } from "vite-plus/test";

import { trialFrom as trial } from "./fixtures";
import { buildModules } from "./modules";
import type { TrialStep } from "./schema";

const step = (name: string, fields: Partial<TrialStep> = {}): TrialStep => ({
  name,
  prompt: `prompt for ${name}`,
  model: "gpt-5",
  success: true,
  response: `${name} response`,
  ...fields,
});

/** Which steps a module shows, and what each answered. */
const rawOf = (steps: TrialStep[]) => steps.map((s) => `${s.name}:${s.response ?? s.error}`);

// Expected values come from the old dashboard's buildModules on the same Trials.
describe("buildModules", () => {
  describe("a Trial that ran every step", () => {
    const modules = buildModules(
      trial({
        testScenario: "test_a_visible",
        panoramaMatchedHeading: 120,
        headingComparisonAgrees: true,
        compassHeading: 118.5,
        currentHeading: 120,
        panoramaTargetHeading: 200,
        targetHeading: 80,
        gpsAccuracyMeters: 7.6,
        confidenceScore: 0.834,
        confidenceLevel: "high",
        confidenceReasons: ["GPS is precise.", "Sign matched."],
        turnInstruction: "Turn right",
        moduleTimingsMs: {
          preCheck: 12,
          currentViewMatch: 0,
          destinationMatch: 34.5,
          turnDecision: 1,
          guidance: 25,
          moduleB: 999,
        },
        steps: [
          step("input_classification"),
          step("destination_candidates"),
          step("proximity_gate", { response: "first gate" }),
          step("proximity_gate", { response: "within 40 m" }),
          step("building_entrances"),
          step("heading_alignment"),
          step("panorama_current_view_match"),
          step("compass_current_heading"),
          step("heading_source_comparison", { response: "2 degrees apart" }),
          step("target_store_match", { success: false, response: "" }),
          step("destination_reference_match", { success: false, response: "not found" }),
          step("sign_text_match", { response: "CVS pharmacy" }),
          step("confidence_fusion"),
          step("accessible_guidance", { success: false }),
        ],
      }),
    );

    it("shows the pre-check from the last run of each step", () => {
      expect(modules.step0).toMatchObject({
        status: "pass",
        durationMs: 12,
        title: "Step 0 · Geometric Reasoning & Pre-check",
        metrics: [
          ["Input", "input_classification response"],
          ["Destination verification", "destination_candidates response"],
          ["Approach Gate", "within 40 m"],
          ["Building entrances", "building_entrances response"],
          ["Heading Alignment", "heading_alignment response"],
        ],
      });
      expect(rawOf(modules.step0.raw)).toEqual([
        "input_classification:input_classification response",
        "destination_candidates:destination_candidates response",
        "proximity_gate:within 40 m",
        "building_entrances:building_entrances response",
        "heading_alignment:heading_alignment response",
      ]);
    });

    it("passes Module B when the panorama heading and compass agree, with new timing keys winning even at zero", () => {
      expect(modules.moduleB).toMatchObject({
        status: "pass",
        durationMs: 0,
        title: "Module B · User Image Localization",
        metrics: [
          ["Panorama matched heading", "120°"],
          ["Phone compass", "118.5°"],
          ["Comparison difference", "2 degrees apart"],
          ["Authoritative heading", "120°"],
        ],
      });
      expect(rawOf(modules.moduleB.raw)).toEqual([
        "panorama_current_view_match:panorama_current_view_match response",
        "compass_current_heading:compass_current_heading response",
        "heading_source_comparison:2 degrees apart",
      ]);
    });

    it("passes Module C when any destination search matched", () => {
      expect(modules.moduleC).toMatchObject({
        status: "pass",
        durationMs: 34.5,
        title: "Module C · Destination Localization",
        metrics: [
          ["Panorama search", "-"],
          ["Fallback reference search", "not found"],
          ["Sign text close-up", "Matched: CVS pharmacy"],
          ["Camera-origin visual bearing", "200°"],
          ["Phone-origin guidance bearing", "80°"],
        ],
      });
      expect(rawOf(modules.moduleC.raw)).toEqual([
        "target_store_match:",
        "destination_reference_match:not found",
        "sign_text_match:CVS pharmacy",
      ]);
    });

    it("rounds GPS accuracy and the confidence score in Module D", () => {
      expect(modules.moduleD).toMatchObject({
        status: "pass",
        durationMs: 1,
        title: "Module D · Confidence Fusion",
        metrics: [
          ["GPS Accuracy", "8 m"],
          ["Heuristic score (not probability)", "83%"],
          ["Confidence Level", "HIGH"],
          ["Reasons", "GPS is precise. Sign matched."],
        ],
      });
    });

    it("fails Module E when the guidance step failed, even with a turn", () => {
      expect(modules.moduleE).toMatchObject({
        status: "fail",
        durationMs: 25,
        title: "Module E · Guidance Generation",
        metrics: [
          ["Calculated Turn", "Turn right"],
          ["Visual Landmarks", "accessible_guidance response"],
        ],
      });
    });
  });

  it("marks what a Trial with no steps never ran", () => {
    const modules = buildModules(trial({}));

    expect(Object.fromEntries(Object.entries(modules).map(([key, m]) => [key, m.status]))).toEqual({
      step0: "na",
      moduleB: "fail",
      moduleC: "na",
      moduleD: "na",
      moduleE: "na",
    });
    expect(modules.step0.metrics).toEqual([
      ["Input", "-"],
      ["Destination verification", "-"],
      ["Approach Gate", "-"],
      ["Building entrances", "Not used (single map pin)"],
      ["Heading Alignment", "-"],
    ]);
    expect(modules.moduleC.metrics.slice(3)).toEqual([
      ["Camera-origin visual bearing", "Not confirmed"],
      ["Phone-origin guidance bearing", "Withheld / not calculated"],
    ]);
    expect(modules.moduleD.metrics.at(-1)).toEqual(["Reasons", "None"]);
    expect(modules.moduleB.durationMs).toBeUndefined();
  });

  it("skips Module B for an unverified destination, passes Module E on the turn alone, and reads old timing keys", () => {
    const modules = buildModules(
      trial({
        testScenario: "destination_unverified",
        turnInstruction: "Walk ahead",
        moduleTimingsMs: {
          step0: 12,
          moduleB: 19.9,
          moduleC: 40,
          moduleD: 2,
          moduleE: 3,
        },
        steps: [step("destination_candidates", { success: false, response: "no match" })],
      }),
    );

    expect(modules.moduleB.status).toBe("na");
    expect(modules.moduleE.status).toBe("pass");
    expect(modules.step0.metrics[1]).toEqual(["Destination verification", "no match"]);
    expect(Object.values(modules).map((m) => m.durationMs)).toEqual([12, 19.9, 40, 2, 3]);
  });

  it("fails Modules B, C and D when the headings disagree and no search or fusion succeeded", () => {
    const modules = buildModules(
      trial({
        panoramaMatchedHeading: 90,
        headingComparisonAgrees: false,
        steps: [
          step("target_store_match", { success: false, response: "no storefront" }),
          step("sign_text_match", { success: false, response: undefined, error: "timeout" }),
          step("confidence_fusion", { success: false }),
        ],
      }),
    );

    expect(modules.moduleB.status).toBe("fail");
    expect(modules.moduleC.status).toBe("fail");
    expect(modules.moduleC.metrics.slice(0, 3)).toEqual([
      ["Panorama search", "no storefront"],
      ["Fallback reference search", "-"],
      ["Sign text close-up", "No match: timeout"],
    ]);
    expect(rawOf(modules.moduleC.raw)).toEqual([
      "target_store_match:no storefront",
      "sign_text_match:timeout",
    ]);
    expect(modules.moduleD.status).toBe("fail");
    expect(modules.moduleE.status).toBe("na");
  });
});
