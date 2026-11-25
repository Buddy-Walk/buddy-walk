/**
 * Pure helpers for required GitHub check evaluation (fail closed).
 */

const TERMINAL_FAIL = new Set([
  "failure",
  "cancelled",
  "timed_out",
  "action_required",
  "stale",
  "neutral",
  "skipped",
]);

/**
 * @param {Array<{ name: string, started_at?: string }>} checkRuns
 * @returns {Map<string, any>}
 */
export function latestByName(checkRuns) {
  const map = new Map();
  for (const run of checkRuns) {
    const prev = map.get(run.name);
    if (!prev || Date.parse(run.started_at || 0) >= Date.parse(prev.started_at || 0)) {
      map.set(run.name, run);
    }
  }
  return map;
}

/**
 * @param {string[]} required
 * @param {Map<string, { status?: string, conclusion?: string | null }>} runsByName
 */
export function evaluateRequiredChecks(required, runsByName) {
  const snapshot = required.map((name) => {
    const run = runsByName.get(name);
    return {
      name,
      status: run?.status || "missing",
      conclusion: run?.conclusion ?? null,
    };
  });

  for (const row of snapshot) {
    if (row.status === "missing") continue;
    if (row.status !== "completed") continue;
    if (row.conclusion === "success") continue;
    if (TERMINAL_FAIL.has(row.conclusion) || row.conclusion !== "success") {
      return { ok: false, reason: "failed", snapshot };
    }
  }

  const allSuccess = snapshot.every(
    (row) => row.status === "completed" && row.conclusion === "success",
  );
  if (allSuccess) return { ok: true, reason: "success", snapshot };

  return { ok: false, reason: "waiting", snapshot };
}

/**
 * @param {string} candidateSha
 * @param {string} tipSha
 */
export function tipMatches(candidateSha, tipSha) {
  return Boolean(candidateSha) && candidateSha === tipSha;
}
