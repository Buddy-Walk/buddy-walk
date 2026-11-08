import { z } from "zod";

import { formatMeters } from "./display";
import { outcomeOf } from "./outcome";
import { REVIEW_OUTCOMES, type Trial } from "./schema";
import { summarizeTrials, type TrialsSummary } from "./summary";

export const NAVIGATION_MODES = ["exact", "approach", "aligned", "none"] as const;
export type NavigationMode = (typeof NAVIGATION_MODES)[number];

export const NAVIGATION_MODE_LABELS: Record<NavigationMode, string> = {
  exact: "Exact",
  approach: "Approach",
  aligned: "Aligned",
  none: "None (unverified / failed)",
};

export const SCENARIOS = [
  "test_a_visible",
  "test_a_reference",
  "test_a_sign_text",
  "test_b_approach",
  "heading_aligned",
  "heading_conflict",
  "destination_unverified",
  "no_panorama",
  "question_routed",
] as const;

export const PANORAMA_LABELS = { yes: "Has panorama", no: "No panorama" } as const;

export const DEFAULT_LIMIT = 200;
/** The most Trials mobile/server returns in one list. */
export const MAX_LIMIT = 500;

/**
 * The /trials search params. limit and includeRetries change what mobile/server
 * returns; the rest filter the loaded Trials. A value the console doesn't know
 * falls back to its default, so an old or edited link still opens.
 */
export const trialsSearchSchema = z.object({
  limit: z
    .number()
    .int()
    .positive()
    .transform((limit) => Math.min(limit, MAX_LIMIT))
    .default(DEFAULT_LIMIT)
    .catch(DEFAULT_LIMIT),
  mode: z.enum(NAVIGATION_MODES).optional().catch(undefined),
  scenario: z.enum(SCENARIOS).optional().catch(undefined),
  panorama: z.enum(["yes", "no"]).optional().catch(undefined),
  outcome: z
    .enum(["unscored", ...REVIEW_OUTCOMES])
    .optional()
    .catch(undefined),
  q: z.string().optional().catch(undefined),
  includeRetries: z.boolean().default(false).catch(false),
});
export type TrialsSearch = z.output<typeof trialsSearchSchema>;

export const FILTER_KEYS = ["mode", "scenario", "panorama", "outcome", "q"] as const;
export type TrialFilters = Partial<Pick<TrialsSearch, (typeof FILTER_KEYS)[number]>>;

/** Every filter unset, to spread over the search params. */
export const NO_FILTERS = {
  mode: undefined,
  scenario: undefined,
  panorama: undefined,
  outcome: undefined,
  q: undefined,
} satisfies Required<Record<keyof TrialFilters, undefined>>;

export const PRESETS = {
  approachNoPanorama: {
    label: "Approach · no panorama",
    filters: { mode: "approach", panorama: "no" },
  },
  noPanorama: { label: "No panorama", filters: { panorama: "no" } },
  needsReview: { label: "Needs review", filters: { outcome: "unscored" } },
  failed: { label: "Outcome: would not get there", filters: { outcome: "would_not_get_there" } },
} as const satisfies Record<string, { label: string; filters: TrialFilters }>;
export type PresetName = keyof typeof PRESETS;

export interface DistanceGate {
  mode: NavigationMode;
  label: string;
  /** Rounded distance to the destination, or empty when unknown. */
  meters: string;
}

/** Which distance gate the Trial went through; anything unrecognised counts as none. */
export function distanceGate(trial: Trial): DistanceGate {
  const mode = NAVIGATION_MODES.find((m) => m !== "none" && m === trial.navigationMode) ?? "none";
  const label =
    mode !== "none"
      ? mode.toUpperCase()
      : trial.testScenario === "destination_unverified"
        ? "UNVERIFIED"
        : trial.testScenario === "question_routed"
          ? "QUESTION"
          : "NONE";
  return { mode, label, meters: formatMeters(trial.destinationDistanceMeters, "") };
}

/** Filters as they apply: text trimmed, blanks unset. */
function normalize(filters: TrialFilters): TrialFilters {
  return { ...filters, q: filters.q?.trim() || undefined };
}

export function sameFilters(a: TrialFilters, b: TrialFilters): boolean {
  const [left, right] = [normalize(a), normalize(b)];
  return FILTER_KEYS.every((key) => left[key] === right[key]);
}

export function hasFilters(filters: TrialFilters): boolean {
  return !sameFilters(filters, {});
}

export function activePreset(filters: TrialFilters): PresetName | undefined {
  return (Object.keys(PRESETS) as PresetName[]).find((name) =>
    sameFilters(filters, PRESETS[name].filters),
  );
}

/** A preset replaces every filter; choosing the active one again clears them. */
export function togglePreset(filters: TrialFilters, name: PresetName): TrialFilters {
  return activePreset(filters) === name ? {} : { ...PRESETS[name].filters };
}

function matches(trial: Trial, filters: TrialFilters): boolean {
  if (filters.mode && distanceGate(trial).mode !== filters.mode) return false;
  if (filters.scenario && trial.testScenario !== filters.scenario) return false;
  if (filters.panorama && trial.hasPanorama !== (filters.panorama === "yes")) return false;
  if (filters.outcome && outcomeOf(trial) !== filters.outcome) return false;
  if (filters.q) {
    const haystack = [trial.destination, trial.destinationPlaceName, trial.destinationPlaceAddress]
      .join(" ")
      .toLowerCase();
    if (!haystack.includes(filters.q.toLowerCase())) return false;
  }
  return true;
}

export function filterTrials(trials: Trial[], filters: TrialFilters): Trial[] {
  const applied = normalize(filters);
  return trials.filter((trial) => matches(trial, applied));
}

/**
 * The Trials the table shows, and the summary of those matching every filter
 * but the outcome, since filtering by outcome would make the rate 0% or 100%.
 */
export function viewTrials(
  trials: Trial[],
  filters: TrialFilters,
): { shown: Trial[]; summary: TrialsSummary } {
  return {
    shown: filterTrials(trials, filters),
    summary: summarizeTrials(filterTrials(trials, { ...filters, outcome: undefined })),
  };
}
