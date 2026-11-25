#!/usr/bin/env node
/**
 * Poll /api/health until ok, optionally requiring gitSha to match EXPECTED_SHA.
 *
 * Env:
 *   HEALTH_URL (default production API health)
 *   EXPECTED_SHA (required when ENFORCE_HEALTH_GIT_SHA=1)
 *   ENFORCE_HEALTH_GIT_SHA (default "0") — when "1", missing/mismatch fails closed
 *   SETTLE_SECONDS (default 90), ATTEMPTS (default 20), SLEEP_SECONDS (default 30)
 */

function revisionMatchesExpected(live, expectedSha) {
  if (!live || !expectedSha) return false;
  const a = String(live).trim().toLowerCase();
  const b = String(expectedSha).trim().toLowerCase();
  return a === b || a.startsWith(b) || b.startsWith(a);
}

const url = process.env.HEALTH_URL || "https://buddy-walk-api.onrender.com/api/health";
const expected = process.env.EXPECTED_SHA || "";
const enforce =
  process.env.ENFORCE_HEALTH_GIT_SHA === "1" ||
  process.env.ENFORCE_HEALTH_GIT_SHA === "true";
const settleSec = Number(process.env.SETTLE_SECONDS || 90);
const attempts = Number(process.env.ATTEMPTS || 20);
const sleepSec = Number(process.env.SLEEP_SECONDS || 30);

console.log(
  JSON.stringify({
    msg: "verify-health-revision start",
    url,
    expected: expected || null,
    enforce,
    settleSec,
    attempts,
  }),
);

if (settleSec > 0) {
  await new Promise((r) => setTimeout(r, settleSec * 1000));
}

let sawOk = false;
let lastGitSha = null;

for (let attempt = 1; attempt <= attempts; attempt++) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(90_000) });
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    console.log(
      JSON.stringify({
        attempt,
        status: res.status,
        ok: body?.ok,
        gitSha: body?.gitSha ?? null,
      }),
    );
    if (res.ok && body?.ok) {
      sawOk = true;
      lastGitSha = body.gitSha ?? null;
      if (expected && revisionMatchesExpected(lastGitSha, expected)) {
        console.log(
          JSON.stringify({
            msg: "health revision matched expected SHA",
            expected,
            gitSha: lastGitSha,
          }),
        );
        process.exit(0);
      }
      if (expected && lastGitSha && !revisionMatchesExpected(lastGitSha, expected)) {
        // Keep polling — prior revision may still be live while the new build rolls.
        console.log("gitSha present but does not match yet; continuing");
      }
    }
  } catch (err) {
    console.error(`attempt ${attempt}: ${err}`);
  }
  if (attempt < attempts) {
    await new Promise((r) => setTimeout(r, sleepSec * 1000));
  }
}

if (enforce) {
  console.error(
    JSON.stringify({
      msg: "ENFORCE_HEALTH_GIT_SHA: failed to observe matching gitSha (fail closed)",
      expected,
      lastGitSha,
      sawOk,
    }),
  );
  process.exit(1);
}

if (sawOk) {
  console.log(
    JSON.stringify({
      msg: "health ok without enforced revision match (provenance residual)",
      expected: expected || null,
      lastGitSha,
      hint: "Set ENFORCE_HEALTH_GIT_SHA=1 after Render injects RENDER_GIT_COMMIT and gitSha is live",
    }),
  );
  process.exit(0);
}

console.error("Post-deploy health failed after retries (fail closed)");
process.exit(1);
