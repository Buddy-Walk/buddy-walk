interface EvaluationRow {
  testScenario?: string;
  runKind?: string; pipelineVersion?: string; serverTs?: Date;
  destinationPlaceAddress?: string; destination?: string;
  reviewOutcome?: string; turnCorrectness?: string; entranceCorrectness?: string;
}
export function summarizeFieldEvaluation(rows: EvaluationRow[]) {
  const groups = new Map<string, { pipelineVersion: string; week: string; location: string; trials: number;
    scored: number; gotThere: number; neededRetake: number; wouldNotGetThere: number;
    turnsScored: number; wrongTurns: number; entrancesScored: number; wrongEntrances: number }>();
  let replayCount = 0;
  for (const row of rows) {
    if (row.runKind === "replay") { replayCount++; continue; }
    if (row.testScenario === "question_routed") continue;
    const date = new Date(row.serverTs ?? NaN);
    date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
    const week = Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : "unknown";
    const pipelineVersion = row.pipelineVersion || "legacy-unversioned";
    const location = row.destinationPlaceAddress || row.destination || "unknown";
    const key = JSON.stringify([pipelineVersion, week, location]);
    const g = groups.get(key) ?? { pipelineVersion, week, location, trials: 0, scored: 0, gotThere: 0,
      neededRetake: 0, wouldNotGetThere: 0, turnsScored: 0, wrongTurns: 0, entrancesScored: 0, wrongEntrances: 0 };
    g.trials++;
    if (["got_there", "needed_retake", "would_not_get_there"].includes(row.reviewOutcome ?? "")) g.scored++;
    if (row.reviewOutcome === "got_there") g.gotThere++;
    if (row.reviewOutcome === "needed_retake") g.neededRetake++;
    if (row.reviewOutcome === "would_not_get_there") g.wouldNotGetThere++;
    if (["correct", "wrong"].includes(row.turnCorrectness ?? "")) g.turnsScored++;
    if (row.turnCorrectness === "wrong") g.wrongTurns++;
    if (["correct", "wrong"].includes(row.entranceCorrectness ?? "")) g.entrancesScored++;
    if (row.entranceCorrectness === "wrong") g.wrongEntrances++;
    groups.set(key, g);
  }
  return { replayCount, groups: [...groups.values()].map(g => ({ ...g, unscored: g.trials - g.scored,
    successRate: g.scored ? g.gotThere / g.scored : null,
    wrongTurnRate: g.turnsScored ? g.wrongTurns / g.turnsScored : null,
    wrongEntranceRate: g.entrancesScored ? g.wrongEntrances / g.entrancesScored : null,
  })) };
}
