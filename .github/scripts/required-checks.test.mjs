import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateRequiredChecks,
  latestByName,
  tipMatches,
} from "./required-checks.mjs";

test("latestByName keeps newest started_at per name", () => {
  const map = latestByName([
    { name: "backend", started_at: "2026-01-01T00:00:00Z", conclusion: "failure" },
    { name: "backend", started_at: "2026-01-01T01:00:00Z", conclusion: "success" },
    { name: "team-console", started_at: "2026-01-01T00:30:00Z", conclusion: "success" },
  ]);
  assert.equal(map.get("backend").conclusion, "success");
  assert.equal(map.get("team-console").conclusion, "success");
});

test("evaluate waits when a required check is missing", () => {
  const map = latestByName([
    { name: "backend", status: "completed", conclusion: "success", started_at: "2026-01-01T00:00:00Z" },
  ]);
  const result = evaluateRequiredChecks(["backend", "team-console"], map);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "waiting");
});

test("evaluate waits while in progress", () => {
  const map = latestByName([
    { name: "backend", status: "in_progress", conclusion: null, started_at: "2026-01-01T00:00:00Z" },
    { name: "team-console", status: "completed", conclusion: "success", started_at: "2026-01-01T00:00:00Z" },
  ]);
  const result = evaluateRequiredChecks(["backend", "team-console"], map);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "waiting");
});

test("evaluate fails closed on failure", () => {
  const map = latestByName([
    { name: "backend", status: "completed", conclusion: "failure", started_at: "2026-01-01T00:00:00Z" },
    { name: "team-console", status: "completed", conclusion: "success", started_at: "2026-01-01T00:00:00Z" },
  ]);
  const result = evaluateRequiredChecks(["backend", "team-console"], map);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "failed");
});

test("evaluate fails closed on skipped required check", () => {
  const map = latestByName([
    { name: "backend", status: "completed", conclusion: "skipped", started_at: "2026-01-01T00:00:00Z" },
    { name: "team-console", status: "completed", conclusion: "success", started_at: "2026-01-01T00:00:00Z" },
  ]);
  const result = evaluateRequiredChecks(["backend", "team-console"], map);
  assert.equal(result.reason, "failed");
});

test("evaluate succeeds only when both required checks succeed", () => {
  const map = latestByName([
    { name: "backend", status: "completed", conclusion: "success", started_at: "2026-01-01T00:00:00Z" },
    { name: "team-console", status: "completed", conclusion: "success", started_at: "2026-01-01T00:00:00Z" },
    { name: "deploy", status: "completed", conclusion: "failure", started_at: "2026-01-01T00:00:00Z" },
  ]);
  const result = evaluateRequiredChecks(["backend", "team-console"], map);
  assert.equal(result.ok, true);
  assert.equal(result.reason, "success");
});

test("tipMatches is exact", () => {
  assert.equal(tipMatches("abc", "abc"), true);
  assert.equal(tipMatches("abc", "def"), false);
  assert.equal(tipMatches("", ""), false);
});
