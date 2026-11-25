import assert from "node:assert/strict";
import test from "node:test";
import {
  compareCheckRuns,
  evaluateRequiredChecks,
  latestByName,
  tipMatches,
} from "./required-checks.mjs";

test("latestByName keeps newest started_at per name", () => {
  const { runs, ambiguous } = latestByName([
    { name: "backend", started_at: "2026-01-01T00:00:00Z", conclusion: "failure", status: "completed", id: 1 },
    { name: "backend", started_at: "2026-01-01T01:00:00Z", conclusion: "success", status: "completed", id: 2 },
    { name: "team-console", started_at: "2026-01-01T00:30:00Z", conclusion: "success", status: "completed", id: 3 },
  ]);
  assert.equal(ambiguous.length, 0);
  assert.equal(runs.get("backend").conclusion, "success");
  assert.equal(runs.get("team-console").conclusion, "success");
});

test("latestByName fails closed on tied started_at with conflicting conclusions", () => {
  const { runs, ambiguous } = latestByName([
    {
      name: "backend",
      started_at: "2026-01-01T00:00:00Z",
      completed_at: "2026-01-01T00:01:00Z",
      conclusion: "failure",
      status: "completed",
      id: 10,
    },
    {
      name: "backend",
      started_at: "2026-01-01T00:00:00Z",
      completed_at: "2026-01-01T00:01:00Z",
      conclusion: "success",
      status: "completed",
      id: 10,
    },
  ]);
  assert.deepEqual(ambiguous, ["backend"]);
  assert.equal(runs.has("backend"), false);
});

test("compareCheckRuns prefers higher id when timestamps tie", () => {
  const older = {
    started_at: "2026-01-01T00:00:00Z",
    completed_at: "2026-01-01T00:01:00Z",
    id: 1,
  };
  const newer = {
    started_at: "2026-01-01T00:00:00Z",
    completed_at: "2026-01-01T00:01:00Z",
    id: 99,
  };
  assert.ok(compareCheckRuns(older, newer) > 0);
});

test("evaluate waits when a required check is missing", () => {
  const { runs } = latestByName([
    { name: "backend", status: "completed", conclusion: "success", started_at: "2026-01-01T00:00:00Z", id: 1 },
  ]);
  const result = evaluateRequiredChecks(["backend", "team-console"], runs);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "waiting");
});

test("evaluate waits while in progress", () => {
  const { runs } = latestByName([
    { name: "backend", status: "in_progress", conclusion: null, started_at: "2026-01-01T00:00:00Z", id: 1 },
    { name: "team-console", status: "completed", conclusion: "success", started_at: "2026-01-01T00:00:00Z", id: 2 },
  ]);
  const result = evaluateRequiredChecks(["backend", "team-console"], runs);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "waiting");
});

test("evaluate fails closed on failure", () => {
  const { runs } = latestByName([
    { name: "backend", status: "completed", conclusion: "failure", started_at: "2026-01-01T00:00:00Z", id: 1 },
    { name: "team-console", status: "completed", conclusion: "success", started_at: "2026-01-01T00:00:00Z", id: 2 },
  ]);
  const result = evaluateRequiredChecks(["backend", "team-console"], runs);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "failed");
});

test("evaluate fails closed on skipped required check", () => {
  const { runs } = latestByName([
    { name: "backend", status: "completed", conclusion: "skipped", started_at: "2026-01-01T00:00:00Z", id: 1 },
    { name: "team-console", status: "completed", conclusion: "success", started_at: "2026-01-01T00:00:00Z", id: 2 },
  ]);
  const result = evaluateRequiredChecks(["backend", "team-console"], runs);
  assert.equal(result.reason, "failed");
});

test("evaluate fails closed when latestByName marks required check ambiguous", () => {
  const result = evaluateRequiredChecks(["backend", "team-console"], new Map(), ["backend"]);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "failed");
});

test("evaluate succeeds only when both required checks succeed", () => {
  const { runs } = latestByName([
    { name: "backend", status: "completed", conclusion: "success", started_at: "2026-01-01T00:00:00Z", id: 1 },
    { name: "team-console", status: "completed", conclusion: "success", started_at: "2026-01-01T00:00:00Z", id: 2 },
    { name: "deploy", status: "completed", conclusion: "failure", started_at: "2026-01-01T00:00:00Z", id: 3 },
  ]);
  const result = evaluateRequiredChecks(["backend", "team-console"], runs);
  assert.equal(result.ok, true);
  assert.equal(result.reason, "success");
});

test("tipMatches is exact", () => {
  assert.equal(tipMatches("abc", "abc"), true);
  assert.equal(tipMatches("abc", "def"), false);
  assert.equal(tipMatches("", ""), false);
});
