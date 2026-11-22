import { formatMeters, MISSING } from "./display";
import type { Trial, TrialStep } from "./schema";

export type ModuleStatus = "pass" | "fail" | "na";

export interface TrialModule {
  status: ModuleStatus;
  /** Missing when the module was skipped or the Trial predates timings. */
  durationMs: number | undefined;
  title: string;
  metrics: [label: string, value: string][];
  /** The AI steps behind the module, with their prompts and responses. */
  raw: TrialStep[];
}

export interface TrialModules {
  step0: TrialModule;
  moduleB: TrialModule;
  moduleC: TrialModule;
  moduleD: TrialModule;
  moduleE: TrialModule;
}

/** The last run of a step, since retried steps log once per attempt. */
function findStep(steps: TrialStep[], name: string): TrialStep | undefined {
  return [...steps].reverse().find((step) => step.name === name);
}

const degrees = (value: number | undefined, missing = MISSING) =>
  value != null ? `${value}°` : missing;

const statusOf = (step: TrialStep | undefined): ModuleStatus =>
  step ? (step.success ? "pass" : "fail") : "na";

/** The pipeline's modules as the Trial recorded them, with what each step found. */
export function buildModules(trial: Trial): TrialModules {
  const { steps } = trial;
  const timings = trial.moduleTimingsMs ?? {};

  const input = findStep(steps, "input_classification");
  const candidates = findStep(steps, "destination_candidates");
  const proximity = findStep(steps, "proximity_gate");
  const entrances = findStep(steps, "building_entrances");
  const headingAlignment = findStep(steps, "heading_alignment");

  const currentViewMatch = findStep(steps, "panorama_current_view_match");
  const compassStep = findStep(steps, "compass_current_heading");
  const headingComparison = findStep(steps, "heading_source_comparison");

  const targetMatch = findStep(steps, "target_store_match");
  const referenceMatch = findStep(steps, "destination_reference_match");
  const signMatch = findStep(steps, "sign_text_match");

  const confidence = findStep(steps, "confidence_fusion");
  const guidance = findStep(steps, "accessible_guidance");

  const moduleBStatus: ModuleStatus =
    trial.testScenario === "destination_unverified" || trial.testScenario === "question_routed"
      ? "na"
      : trial.panoramaMatchedHeading != null && trial.headingComparisonAgrees === true
        ? "pass"
        : "fail";

  const moduleCStatus: ModuleStatus = targetMatch
    ? [targetMatch, referenceMatch, signMatch].some((step) => step?.success)
      ? "pass"
      : "fail"
    : "na";

  const moduleEStatus: ModuleStatus = guidance
    ? statusOf(guidance)
    : trial.turnInstruction
      ? "pass"
      : "na";

  return {
    step0: {
      status: proximity ? "pass" : "na",
      durationMs: timings.preCheck ?? timings.step0,
      title: "Step 0 · Geometric Reasoning & Pre-check",
      metrics: [
        ["Input", input ? (input.response ?? "") : MISSING],
        ["Destination verification", candidates ? (candidates.response ?? "") : MISSING],
        ["Approach Gate", proximity ? (proximity.response ?? "") : MISSING],
        [
          "Building entrances",
          entrances ? (entrances.response ?? "") : "Not used (single map pin)",
        ],
        ["Heading Alignment", headingAlignment ? (headingAlignment.response ?? "") : MISSING],
      ],
      raw: [input, candidates, proximity, entrances, headingAlignment].filter((s) => s != null),
    },
    moduleB: {
      status: moduleBStatus,
      durationMs: timings.currentViewMatch ?? timings.moduleB,
      title: "Module B · User Image Localization",
      metrics: [
        ["Panorama matched heading", degrees(trial.panoramaMatchedHeading)],
        ["Phone compass", degrees(trial.compassHeading)],
        ["Comparison difference", headingComparison ? (headingComparison.response ?? "") : MISSING],
        ["Authoritative heading", degrees(trial.currentHeading)],
      ],
      raw: [currentViewMatch, compassStep, headingComparison].filter((s) => s != null),
    },
    moduleC: {
      status: moduleCStatus,
      durationMs: timings.destinationMatch ?? timings.moduleC,
      title: "Module C · Destination Localization",
      metrics: [
        ["Panorama search", targetMatch?.response || MISSING],
        ["Fallback reference search", referenceMatch?.response || MISSING],
        [
          "Sign text close-up",
          signMatch
            ? `${signMatch.success ? "Matched: " : "No match: "}${signMatch.response || signMatch.error || MISSING}`
            : MISSING,
        ],
        ["Camera-origin visual bearing", degrees(trial.panoramaTargetHeading, "Not confirmed")],
        [
          "Phone-origin guidance bearing",
          degrees(trial.targetHeading, "Withheld / not calculated"),
        ],
      ],
      raw: [targetMatch, referenceMatch, signMatch].filter((s) => s != null),
    },
    moduleD: {
      status: statusOf(confidence),
      durationMs: timings.turnDecision ?? timings.moduleD,
      title: "Module D · Confidence Fusion",
      metrics: [
        ["GPS Accuracy", formatMeters(trial.gpsAccuracyMeters)],
        [
          "Heuristic score (not probability)",
          trial.confidenceScore != null ? `${Math.round(trial.confidenceScore * 100)}%` : MISSING,
        ],
        ["Confidence Level", trial.confidenceLevel ? trial.confidenceLevel.toUpperCase() : MISSING],
        ["Reasons", trial.confidenceReasons.join(" ") || "None"],
      ],
      raw: [confidence].filter((s) => s != null),
    },
    moduleE: {
      status: moduleEStatus,
      durationMs: timings.guidance ?? timings.moduleE,
      title: "Module E · Guidance Generation",
      metrics: [
        ["Calculated Turn", trial.turnInstruction || MISSING],
        ["Visual Landmarks", guidance ? guidance.response || MISSING : MISSING],
      ],
      raw: [guidance].filter((s) => s != null),
    },
  };
}
