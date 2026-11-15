import type { TrialDetail } from "./schema";

const NOT_RECORDED = "Not recorded";
const ACCURACY_LABELS: Record<number, string> = { 0: "None", 1: "Low", 2: "Medium", 3: "High" };

function accuracy(value: number | undefined): string {
  return value === undefined ? NOT_RECORDED : `${value} (${ACCURACY_LABELS[value] ?? "Unknown"})`;
}

/** Presentation only: derived panorama or capture headings never replace a live reading. */
export function headingDiagnostics(trial: Pick<TrialDetail, "replayInput">): [string, string][] {
  const input = trial.replayInput;
  const sensors = input?.sensors;
  const latest = sensors?.latestHeading;
  const reference = sensors?.latestHeadingReference;
  const receivedAt = input?.receivedAt;
  const timestamp = sensors?.latestHeadingTimestamp;
  const age =
    receivedAt !== undefined && timestamp !== undefined
      ? `${Math.round(receivedAt - timestamp)} ms`
      : NOT_RECORDED;

  return [
    ["Capture Heading", input?.heading === undefined ? NOT_RECORDED : `${input.heading}°`],
    ["Capture Expo Accuracy", accuracy(input?.compassAccuracyLevel)],
    ["Latest Heading", latest === undefined ? NOT_RECORDED : `${latest}°`],
    ["Latest Expo Accuracy", accuracy(sensors?.latestHeadingAccuracyLevel)],
    [
      "Heading Reference",
      reference === "true" ? "True north" : reference === "magnetic" ? "Magnetic north" : "Unknown",
    ],
    ["Heading Age (at backend receipt)", age],
    [
      "Heading Validity",
      latest === undefined
        ? NOT_RECORDED
        : Number.isFinite(latest) && latest >= 0 && latest < 360
          ? "Valid"
          : "Invalid",
    ],
  ];
}
