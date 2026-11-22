import { trialName, trialTime, UNVERSIONED } from "./display";
import { outcomeOf } from "./outcome";
import type { Trial } from "./schema";
import { weekOf } from "./week";

export interface SuccessGroup {
  label: string;
  scored: number;
  success: number;
  /** Whole percent of scored Trials that got there. */
  rate: number;
}

export interface WrongCount {
  wrong: number;
  /** Trials scored correct or wrong for this. */
  scored: number;
}

export interface TrialsSummary {
  trials: number;
  scored: number;
  success: number;
  /** Null until a Trial is scored. */
  rate: number | null;
  byWeek: SuccessGroup[];
  byLocation: SuccessGroup[];
  byVersion: SuccessGroup[];
  wrongTurns: WrongCount;
  wrongEntrances: WrongCount;
}

const LOCATIONS_SHOWN = 12;

const percent = (part: number, whole: number) => Math.round((part / whole) * 100);

/** Only Trials run in the app count toward the rate: never retries, replays or Questions. */
function countsTowardRate(trial: Trial): boolean {
  return !trial.retryOf && trial.runKind !== "replay" && trial.testScenario !== "question_routed";
}

function placeOf(trial: Trial): string {
  const name = trialName(trial) || "Unknown";
  return trial.destinationPlaceAddress ? `${name} - ${trial.destinationPlaceAddress}` : name;
}

function wrongCount(trials: Trial[], field: "turnCorrectness" | "entranceCorrectness"): WrongCount {
  return {
    wrong: trials.filter((trial) => trial[field] === "wrong").length,
    scored: trials.filter((trial) => trial[field] === "correct" || trial[field] === "wrong").length,
  };
}

/** Scored Trials grouped by label, in the order each label first appears. */
function groupBy(scored: Trial[], labelOf: (trial: Trial) => string): SuccessGroup[] {
  const groups = new Map<string, { scored: number; success: number }>();
  for (const trial of scored) {
    const label = labelOf(trial);
    const group = groups.get(label) ?? { scored: 0, success: 0 };
    group.scored += 1;
    if (outcomeOf(trial) === "got_there") group.success += 1;
    groups.set(label, group);
  }
  return [...groups].map(([label, group]) => ({
    label,
    ...group,
    rate: percent(group.success, group.scored),
  }));
}

export function summarizeTrials(rows: Trial[]): TrialsSummary {
  const trials = rows.filter(countsTowardRate);
  const scored = trials.filter((trial) => outcomeOf(trial) !== "unscored");
  const success = scored.filter((trial) => outcomeOf(trial) === "got_there").length;

  return {
    trials: trials.length,
    scored: scored.length,
    success,
    rate: scored.length ? percent(success, scored.length) : null,
    // Labels sort as text, so "Week of unknown" comes before every dated week.
    byWeek: groupBy(scored, (trial) => `Week of ${weekOf(trialTime(trial))}`).sort((a, b) =>
      a.label < b.label ? 1 : a.label > b.label ? -1 : 0,
    ),
    byLocation: groupBy(scored, placeOf)
      .sort((a, b) => b.scored - a.scored)
      .slice(0, LOCATIONS_SHOWN),
    byVersion: groupBy(scored, (trial) => trial.pipelineVersion || UNVERSIONED),
    wrongTurns: wrongCount(trials, "turnCorrectness"),
    wrongEntrances: wrongCount(trials, "entranceCorrectness"),
  };
}
