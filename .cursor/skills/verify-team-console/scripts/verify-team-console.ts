/**
 * #171 verify-team-console runner.
 * Prefers Playwright-owned local-stack startup; falls back to lib checks when mongod is absent.
 * Never deletes a `.stack/db` this invocation did not create.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

const skillDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repoRoot = path.resolve(skillDir, "../../..");
const consoleDir = path.join(repoRoot, "team-console");
const stackDb = path.join(consoleDir, ".stack", "db");
const mobileTsx = path.join(repoRoot, "mobile", "node_modules", ".bin", "tsx");

function which(cmd: string): boolean {
  const r = spawnSync(process.platform === "win32" ? "where" : "which", [cmd], {
    encoding: "utf8",
  });
  return r.status === 0;
}

function run(cmd: string, args: string[], cwd: string): { ok: boolean; out: string } {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", shell: true, env: process.env });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  return { ok: r.status === 0, out };
}

async function libIsolationChecks(): Promise<{ ok: boolean; detail: string }> {
  // Pure fixture/filter isolation without Mongo or browser.
  const { filterTrials, hasFilters } = await import(
    pathToFileURL(path.join(consoleDir, "src/lib/trials/filters.ts")).href
  );
  const { trialFrom } = await import(
    pathToFileURL(path.join(consoleDir, "src/lib/trials/fixtures.ts")).href
  );

  const a = trialFrom({ _id: "iso-a", destination: "Alpha" });
  const b = trialFrom({ _id: "iso-b", destination: "Beta" });
  const filtered = filterTrials([a, b], { q: "Alpha" } as never);
  const isolated =
    filtered.length === 1 &&
    filtered.every((t: { _id: string }) => t._id === "iso-a");
  const empty = !hasFilters({} as never);
  return {
    ok: isolated && empty,
    detail: isolated && empty
      ? "filterTrials isolates by query; empty filters reported cleanly"
      : filtered.length === 0
        ? "lib isolation check failed: empty result must not PASS"
        : "lib isolation check failed",
  };
}

async function main() {
  const libOnly = process.argv.includes("--lib-only");
  const started = performance.now();
  const lines: string[] = [
    "# verify-team-console results (#171)",
    "",
    `**Started:** ${new Date().toISOString()}`,
    "",
  ];

  const hasBun = which("bun");
  const hasMongod = which("mongod");
  const hasMongoimport = which("mongoimport");
  const hasMobileTsx = existsSync(mobileTsx) || existsSync(`${mobileTsx}.cmd`);
  lines.push("## Prerequisites", "");
  lines.push(`- bun: ${hasBun ? "yes" : "NO"}`);
  lines.push(`- mongod: ${hasMongod ? "yes" : "NO"}`);
  lines.push(`- mongoimport: ${hasMongoimport ? "yes" : "NO"}`);
  lines.push(`- mobile/node_modules/.bin/tsx: ${hasMobileTsx ? "yes" : "NO (run npm ci in mobile/)"}`);
  lines.push(`- team-console dir: ${existsSync(consoleDir) ? "yes" : "NO"}`);
  lines.push("");

  let lib: { ok: boolean; detail: string };
  try {
    lib = await libIsolationChecks();
  } catch (e) {
    lib = { ok: false, detail: `lib import failed: ${(e as Error).message}` };
  }
  lines.push("## Lib isolation", "", `- ${lib.ok ? "PASS" : "FAIL"}: ${lib.detail}`, "");

  let unit: { ok: boolean; detail: string } = { ok: false, detail: "skipped" };
  if (hasBun) {
    const unitRun = run(
      "bunx",
      ["vite-plus", "test", "src/lib/trials", "src/lib/usage", "--run"],
      consoleDir,
    );
    unit = {
      ok: unitRun.ok,
      detail: unitRun.ok
        ? unitRun.out.split("\n").filter((l) => /Test Files|Tests /.test(l)).join(" | ") || "vite-plus test exit 0"
        : unitRun.out.slice(-1500),
    };
  }
  lines.push("## Lib unit suite (vite-plus)", "", `- ${unit.ok ? "PASS" : "FAIL"}: ${unit.detail}`, "");

  let e2e: { ran: boolean; ok: boolean; detail: string } = {
    ran: false,
    ok: false,
    detail: "skipped",
  };

  // Playwright's webServer owns local-stack startup/cleanup — do not wrap another stack here.
  if (!libOnly && hasBun && hasMongod && hasMongoimport && hasMobileTsx) {
    const result = run(
      "bunx",
      ["playwright", "test", "--reporter=line"],
      consoleDir,
    );
    e2e = {
      ran: true,
      ok: result.ok,
      detail: [
        result.ok ? "playwright exit 0 (webServer-owned stack)" : "playwright failed",
        result.out.slice(-2000),
      ].join("\n"),
    };
  } else if (!libOnly) {
    const missing = [
      !hasBun ? "bun" : null,
      !hasMongod ? "mongod" : null,
      !hasMongoimport ? "mongoimport" : null,
      !hasMobileTsx ? "mobile deps (npm ci in mobile/)" : null,
    ].filter(Boolean);
    e2e = {
      ran: false,
      ok: false,
      detail:
        `Full journeys BLOCKED: missing ${missing.join(", ")}. Install prerequisites and re-run without --lib-only.`,
    };
  }

  lines.push("## Browser journeys (Playwright webServer + local-stack)", "");
  lines.push(`- ran: ${e2e.ran}`);
  lines.push(`- ${e2e.ok ? "PASS" : e2e.ran ? "FAIL" : "BLOCKED"}: ${e2e.detail}`);
  lines.push("");
  lines.push(
    "- Cleanup: this wrapper never deletes `.stack/db`. Playwright/`local-stack` remove only the DB they create.",
    "",
  );
  if (existsSync(stackDb) && !e2e.ran) {
    lines.push(
      "- Note: `.stack/db` exists but was left untouched (another developer or prior stack may own it).",
      "",
    );
  }

  const runtimeMs = Math.round(performance.now() - started);
  const status = libOnly
    ? lib.ok && unit.ok
      ? "PASS (lib-only)"
      : "FAIL"
    : e2e.ran
      ? e2e.ok && lib.ok && unit.ok
        ? "PASS"
        : "FAIL"
      : lib.ok && unit.ok
        ? "PARTIAL — lib PASS; browser journeys BLOCKED (prerequisites missing)"
        : "FAIL";

  lines.unshift(`**Status:** ${status}`, `**Runtime:** ${runtimeMs} ms`, "");
  lines.push("## Production safety", "", "- No production Mongo URI used.", "");

  const report = lines.join("\n");
  console.log(report);
  const out = path.join(repoRoot, "docs/engineering/verify-171-results.md");
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, report);
  console.error(`Wrote ${out}`);

  if (status.startsWith("FAIL")) process.exit(1);
  // PARTIAL exits 0 so local progress is recorded; AC still incomplete until e2e runs.
}

void main();
