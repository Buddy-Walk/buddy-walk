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
 * @param {any} a
 * @param {any} b
 * @returns {number} negative if a is newer, positive if b is newer, 0 if unordered tie
 */
export function compareCheckRuns(a, b) {
  const aStart = Date.parse(a.started_at || 0);
  const bStart = Date.parse(b.started_at || 0);
  if (bStart !== aStart) return bStart - aStart;
  const aDone = Date.parse(a.completed_at || 0);
  const bDone = Date.parse(b.completed_at || 0);
  if (bDone !== aDone) return bDone - aDone;
  const aId = Number(a.id) || 0;
  const bId = Number(b.id) || 0;
  if (bId !== aId) return bId - aId;
  return 0;
}

/**
 * @param {Array<{ name: string, started_at?: string, completed_at?: string, id?: number|string, status?: string, conclusion?: string|null }>} checkRuns
 * @returns {{ runs: Map<string, any>, ambiguous: string[] }}
 */
export function latestByName(checkRuns) {
  /** @type {Map<string, any[]>} */
  const grouped = new Map();
  for (const run of checkRuns) {
    const list = grouped.get(run.name) || [];
    list.push(run);
    grouped.set(run.name, list);
  }

  /** @type {Map<string, any>} */
  const runs = new Map();
  /** @type {string[]} */
  const ambiguous = [];

  for (const [name, list] of grouped) {
    let best = list[0];
    let tied = [best];
    for (let i = 1; i < list.length; i++) {
      const cand = list[i];
      const cmp = compareCheckRuns(best, cand);
      if (cmp > 0) {
        best = cand;
        tied = [cand];
      } else if (cmp === 0) {
        tied.push(cand);
      }
    }

    const completedTied = tied.filter((r) => r.status === "completed");
    if (completedTied.length > 1) {
      const conclusions = new Set(completedTied.map((r) => r.conclusion ?? "null"));
      if (conclusions.size > 1) {
        ambiguous.push(name);
        continue;
      }
    }
    runs.set(name, best);
  }

  return { runs, ambiguous };
}

/**
 * @param {string[]} required
 * @param {Map<string, { status?: string, conclusion?: string | null }>} runsByName
 * @param {string[]} [ambiguousNames]
 */
export function evaluateRequiredChecks(required, runsByName, ambiguousNames = []) {
  const ambiguousRequired = ambiguousNames.filter((n) => required.includes(n));
  if (ambiguousRequired.length) {
    return {
      ok: false,
      reason: "failed",
      snapshot: ambiguousRequired.map((name) => ({
        name,
        status: "completed",
        conclusion: "ambiguous",
      })),
    };
  }

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
