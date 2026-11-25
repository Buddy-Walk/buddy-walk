#!/usr/bin/env node
/**
 * Poll GitHub check runs for a commit until required names succeed, fail, or timeout.
 * Fail closed on failure, cancellation, timeout, missing checks, ambiguity, or tip skew.
 *
 * Env:
 *   GITHUB_TOKEN (required)
 *   GITHUB_REPOSITORY (owner/repo, required)
 *   GITHUB_SHA (commit to verify, required)
 *   REQUIRED_CHECKS (space-separated names, default: "backend team-console")
 *   TIMEOUT_SECONDS (default 1500)
 *   POLL_SECONDS (default 15)
 *   REQUIRE_TIP_OF_REF (optional ref name, e.g. "main")
 *   GITHUB_API_URL (default https://api.github.com)
 */

import {
  evaluateRequiredChecks,
  latestByName,
  tipMatches,
} from "./required-checks.mjs";

const token = process.env.GITHUB_TOKEN;
const repo = process.env.GITHUB_REPOSITORY;
const sha = process.env.GITHUB_SHA;
const apiBase = (process.env.GITHUB_API_URL || "https://api.github.com").replace(
  /\/$/,
  "",
);
const required = (process.env.REQUIRED_CHECKS || "backend team-console")
  .split(/\s+/)
  .filter(Boolean);
const timeoutSec = Number(process.env.TIMEOUT_SECONDS || 1500);
const pollSec = Number(process.env.POLL_SECONDS || 15);
const tipRef = process.env.REQUIRE_TIP_OF_REF || "";

if (!token || !repo || !sha) {
  console.error("GITHUB_TOKEN, GITHUB_REPOSITORY, and GITHUB_SHA are required");
  process.exit(2);
}
if (!required.length) {
  console.error("REQUIRED_CHECKS resolved empty");
  process.exit(2);
}

async function gh(path) {
  const res = await fetch(`${apiBase}${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "buddy-walk-wait-for-required-checks",
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub API ${res.status} ${path}: ${body.slice(0, 400)}`);
  }
  return res.json();
}

async function assertTip() {
  if (!tipRef) return;
  const data = await gh(`/repos/${repo}/commits/${encodeURIComponent(tipRef)}`);
  if (!tipMatches(sha, data.sha)) {
    console.error(
      `Tip skew: ref ${tipRef} is ${data.sha}, candidate is ${sha}. Fail closed; newer revision owns deploy.`,
    );
    process.exit(3);
  }
}

async function fetchCheckRuns() {
  const all = [];
  let page = 1;
  for (;;) {
    const batch = await gh(
      `/repos/${repo}/commits/${sha}/check-runs?per_page=100&page=${page}`,
    );
    const runs = batch.check_runs || [];
    all.push(...runs);
    if (runs.length < 100) break;
    page += 1;
    if (page > 20) break;
  }
  return all;
}

const started = Date.now();
console.log(
  JSON.stringify({
    msg: "wait-for-required-checks start",
    repo,
    sha,
    required,
    timeoutSec,
    tipRef: tipRef || null,
  }),
);

await assertTip();

for (;;) {
  const elapsed = (Date.now() - started) / 1000;
  if (elapsed > timeoutSec) {
    console.error("Timed out waiting for required checks (fail closed)");
    process.exit(2);
  }

  let runs;
  try {
    runs = await fetchCheckRuns();
  } catch (err) {
    console.error(String(err));
    await new Promise((r) => setTimeout(r, pollSec * 1000));
    continue;
  }

  const { runs: byName, ambiguous } = latestByName(runs);
  const result = evaluateRequiredChecks(required, byName, ambiguous);
  console.log(JSON.stringify({ elapsedSec: Math.round(elapsed), ambiguous, ...result }));

  if (result.reason === "failed") {
    console.error("Required check failed or ambiguous (fail closed)");
    process.exit(1);
  }
  if (result.ok) {
    await assertTip();
    console.log("All required checks succeeded on candidate SHA");
    process.exit(0);
  }

  await new Promise((r) => setTimeout(r, pollSec * 1000));
}
