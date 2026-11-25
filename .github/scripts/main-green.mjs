#!/usr/bin/env node
/**
 * Main-green / exact-SHA required-check diagnostics (issue #190).
 *
 * Usage:
 *   node .github/scripts/main-green.mjs --sha <full_or_short_sha>
 *
 * Env (optional overrides):
 *   GITHUB_TOKEN, GITHUB_REPOSITORY (owner/repo)
 *   REQUIRED_CHECKS (default: "backend team-console")
 *   TIMEOUT_SECONDS (default 120), POLL_SECONDS (default 10)
 *   GITHUB_API_URL
 *
 * Exit codes:
 *   0 success — all required checks succeeded on SHA
 *   1 failed / ambiguous required check
 *   2 missing args, API error, or timeout while still waiting
 *
 * Pages and other checks are ignored.
 */

import {
  evaluateRequiredChecks,
  latestByName,
} from "./required-checks.mjs";

function parseArgs(argv) {
  let sha = process.env.GITHUB_SHA || "";
  let sawShaFlag = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--sha") {
      sawShaFlag = true;
      const next = argv[i + 1];
      if (!next || next.startsWith("-")) {
        console.error("--sha requires a SHA operand");
        process.exit(2);
      }
      sha = next;
      i += 1;
    } else if (argv[i] === "--help" || argv[i] === "-h") {
      console.log(`Usage: node .github/scripts/main-green.mjs --sha <sha>
Requires GITHUB_TOKEN and GITHUB_REPOSITORY (or run inside Actions/gh auth context via env).
Ignores GitHub Pages. Fail closed on missing/failed/ambiguous/timeout.`);
      process.exit(0);
    }
  }
  return { sha, sawShaFlag };
}

const { sha: shaInput } = parseArgs(process.argv.slice(2));
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
const repo = process.env.GITHUB_REPOSITORY;
const apiBase = (process.env.GITHUB_API_URL || "https://api.github.com").replace(
  /\/$/,
  "",
);
const requiredRaw = process.env.REQUIRED_CHECKS ?? "backend team-console";
const required = requiredRaw.split(/\s+/).filter(Boolean);
const timeoutSec = Number(process.env.TIMEOUT_SECONDS || 120);
const pollSec = Number(process.env.POLL_SECONDS || 10);

if (!token) {
  console.error("GITHUB_TOKEN (or GH_TOKEN) is required");
  process.exit(2);
}
if (!repo) {
  console.error("GITHUB_REPOSITORY=owner/repo is required");
  process.exit(2);
}
if (!shaInput) {
  console.error("--sha <sha> is required");
  process.exit(2);
}
if (!required.length) {
  console.error("REQUIRED_CHECKS resolved empty (fail closed)");
  process.exit(2);
}
if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) {
  console.error("TIMEOUT_SECONDS must be a finite number > 0");
  process.exit(2);
}
if (!Number.isFinite(pollSec) || pollSec <= 0) {
  console.error("POLL_SECONDS must be a finite number > 0");
  process.exit(2);
}

function remainingMs(started) {
  return Math.max(0, timeoutSec * 1000 - (Date.now() - started));
}

async function gh(path, started) {
  const left = remainingMs(started);
  if (left <= 0) {
    throw new Error("deadline exceeded before request");
  }
  const res = await fetch(`${apiBase}${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "buddy-walk-main-green",
    },
    signal: AbortSignal.timeout(Math.min(left, 60_000)),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub API ${res.status} ${path}: ${body.slice(0, 400)}`);
  }
  return res.json();
}

async function resolveSha(input, started) {
  const data = await gh(
    `/repos/${repo}/commits/${encodeURIComponent(input)}`,
    started,
  );
  return data.sha;
}

async function fetchCheckRuns(sha, started) {
  const all = [];
  let page = 1;
  for (;;) {
    const batch = await gh(
      `/repos/${repo}/commits/${sha}/check-runs?per_page=100&page=${page}`,
      started,
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
const sha = await resolveSha(shaInput, started);
console.log(
  JSON.stringify({
    msg: "main-green start",
    repo,
    shaInput,
    sha,
    required,
    ignored: ["Deploy GitHub Pages", "Pages", "other non-required checks"],
    timeoutSec,
  }),
);

for (;;) {
  const elapsed = (Date.now() - started) / 1000;
  if (elapsed > timeoutSec) {
    console.error(
      JSON.stringify({
        msg: "main-green timeout",
        sha,
        elapsedSec: Math.round(elapsed),
      }),
    );
    process.exit(2);
  }

  let runs;
  try {
    runs = await fetchCheckRuns(sha, started);
  } catch (err) {
    console.error(String(err));
    const left = remainingMs(started);
    if (left <= 0) {
      console.error("main-green timeout during API wait");
      process.exit(2);
    }
    await new Promise((r) => setTimeout(r, Math.min(pollSec * 1000, left)));
    continue;
  }

  const { runs: byName, ambiguous } = latestByName(runs);
  const result = evaluateRequiredChecks(required, byName, ambiguous);
  const diagnostics = required.map((name) => {
    const row = result.snapshot.find((s) => s.name === name);
    return row || { name, status: "missing", conclusion: null };
  });
  console.log(
    JSON.stringify({
      elapsedSec: Math.round(elapsed),
      sha,
      ambiguous,
      reason: result.reason,
      ok: result.ok,
      diagnostics,
    }),
  );

  if (result.reason === "failed") {
    console.error("main-green: required check failed or ambiguous (fail closed)");
    process.exit(1);
  }
  if (result.ok) {
    console.log(JSON.stringify({ msg: "main-green PASS", sha, diagnostics }));
    process.exit(0);
  }

  const left = remainingMs(started);
  if (left <= 0) {
    console.error("main-green timeout");
    process.exit(2);
  }
  await new Promise((r) => setTimeout(r, Math.min(pollSec * 1000, left)));
}
