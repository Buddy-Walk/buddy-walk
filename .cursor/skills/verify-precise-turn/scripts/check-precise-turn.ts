/**
 * Finite-domain checker for production precise-turn decision logic (#172).
 *
 * Imports `preciseTurnReasons` / `evaluateWalkingLeg` from production modules.
 * Not a formal proof — exhaustive only over the explicit discrete domain below.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  evaluateWalkingLeg,
  preciseTurnReasons,
} from "../../../../mobile/server/utils/lastMetersPolicy.ts";

const skillRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repoRoot = path.resolve(skillRoot, "../../..");

const origin = { lat: 40.7, lng: -74 };
const target = { lat: 40.70045, lng: -74 };

const goodWalking = evaluateWalkingLeg(
  {
    start_location: origin,
    end_location: target,
    distance: { value: 50 },
    steps: [{ travel_mode: "WALKING", start_location: origin, end_location: target }],
  },
  origin,
  target,
);

const DOMAIN = {
  confidenceLevel: ["high", "medium", "low", ""] as const,
  photoMatched: [true, false] as const,
  headingAgrees: [true, false, undefined] as const,
  compassAccuracy: [3, 2, 1, undefined] as const,
  gpsAccuracy: [5, 14, 20, 20.1, -1, undefined] as const,
  distanceMeters: [1, 20, 50, 0, -1, Number.NaN] as const,
  entranceListed: [true, false] as const,
  visualTargetMatched: [true, false] as const,
  walking: [
    goodWalking,
    { verified: false, reason: "walking_route_unavailable" },
  ] as const,
  sensorReasons: [[], ["gps_uncertain"], ["capture_gps_stale", "moved_since_capture"]] as const,
};

function cartesianSize(d: typeof DOMAIN): number {
  return (
    d.confidenceLevel.length *
    d.photoMatched.length *
    d.headingAgrees.length *
    d.compassAccuracy.length *
    d.gpsAccuracy.length *
    d.distanceMeters.length *
    d.entranceListed.length *
    d.visualTargetMatched.length *
    d.walking.length *
    d.sensorReasons.length
  );
}

/**
 * Independent oracle mirroring production `preciseTurnReasons` gates.
 * Kept next to the checker so domain assumptions stay explicit; if this drifts
 * from production, domain failures surface. Not a second navigation engine.
 */
function productionMustWithhold(input: Parameters<typeof preciseTurnReasons>[0]): boolean {
  if (input.sensorReasons.length) return true;
  if (input.confidenceLevel !== "high") return true;
  if (!input.photoMatched || input.headingAgrees !== true) return true;
  if (input.compassAccuracy !== 3) return true;
  if (!input.visualTargetMatched) return true;
  if (!input.entranceListed) return true;
  if (!input.walking.verified) return true;
  if (
    !Number.isFinite(input.gpsAccuracy) ||
    input.gpsAccuracy! < 0 ||
    input.gpsAccuracy! > 20 ||
    !Number.isFinite(input.distanceMeters) ||
    input.distanceMeters <= 0 ||
    input.gpsAccuracy! / input.distanceMeters > Math.sin((22.5 * Math.PI) / 180)
  ) {
    return true;
  }
  return false;
}

type DecideFn = typeof preciseTurnReasons;

function runDomain(
  decide: DecideFn = preciseTurnReasons,
): { size: number; clearCases: number; withholdCases: number; failures: string[] } {
  const failures: string[] = [];
  let clearCases = 0;
  let withholdCases = 0;
  let size = 0;

  for (const confidenceLevel of DOMAIN.confidenceLevel) {
    for (const photoMatched of DOMAIN.photoMatched) {
      for (const headingAgrees of DOMAIN.headingAgrees) {
        for (const compassAccuracy of DOMAIN.compassAccuracy) {
          for (const gpsAccuracy of DOMAIN.gpsAccuracy) {
            for (const distanceMeters of DOMAIN.distanceMeters) {
              for (const entranceListed of DOMAIN.entranceListed) {
                for (const visualTargetMatched of DOMAIN.visualTargetMatched) {
                  for (const walking of DOMAIN.walking) {
                    for (const sensorReasons of DOMAIN.sensorReasons) {
                      size += 1;
                      const input = {
                        confidenceLevel,
                        photoMatched,
                        headingAgrees,
                        compassAccuracy,
                        gpsAccuracy,
                        distanceMeters,
                        entranceListed,
                        visualTargetMatched,
                        walking,
                        sensorReasons: [...sensorReasons],
                      };
                      const reasons = decide(input);
                      const mustWithhold = productionMustWithhold(input);
                      if (mustWithhold) {
                        withholdCases += 1;
                        if (reasons.length === 0) {
                          failures.push(
                            `unsafe clear for ${JSON.stringify({
                              confidenceLevel,
                              photoMatched,
                              headingAgrees,
                              compassAccuracy,
                              gpsAccuracy,
                              distanceMeters,
                              entranceListed,
                              visualTargetMatched,
                              walkingVerified: walking.verified,
                              sensorReasons,
                            })}`,
                          );
                        }
                      } else {
                        clearCases += 1;
                        if (reasons.length !== 0) {
                          failures.push(`authorized case withheld: ${reasons.join(",")}`);
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  return { size, clearCases, withholdCases, failures };
}

/**
 * Unsafe mutant: always clears. Detection must go through `runDomain` so the
 * checker’s withhold oracle actually rejects it — not a hard-coded stub check.
 */
function runMutationCheck(): { detected: boolean; restored: boolean; detail: string } {
  const mutated = (() => []) as DecideFn;
  const mutantDomain = runDomain(mutated);
  const detected = mutantDomain.failures.some((f) => f.startsWith("unsafe clear"));

  const restoredDomain = runDomain(preciseTurnReasons);
  const restored = restoredDomain.failures.length === 0 && restoredDomain.withholdCases > 0;

  return {
    detected,
    restored,
    detail: detected && restored
      ? `Unsafe empty-reasons mutation detected via runDomain (${mutantDomain.failures.length} unsafe clears); production domain still clean after restore.`
      : `Mutation check failed (detected=${detected}, restored=${restored}, mutantFailures=${mutantDomain.failures.length}, restoreFailures=${restoredDomain.failures.length})`,
  };
}

function main() {
  const args = process.argv.slice(2);
  const wantMutation = args.includes("--mutation");
  const outIdx = args.indexOf("--out");
  const outPath = outIdx >= 0 ? args[outIdx + 1] : undefined;

  const started = performance.now();
  const expectedSize = cartesianSize(DOMAIN);
  const domain = runDomain();
  assert.equal(domain.size, expectedSize, "runtime domain size must match cartesian product");

  let mutation: ReturnType<typeof runMutationCheck> | undefined;
  if (wantMutation) {
    mutation = runMutationCheck();
    assert.equal(mutation.detected, true);
    assert.equal(mutation.restored, true);
  }

  const runtimeMs = Math.round(performance.now() - started);
  const ok = domain.failures.length === 0 && (!mutation || (mutation.detected && mutation.restored));

  const report = [
    "# verify-precise-turn results (#172)",
    "",
    `**Status:** ${ok ? "PASS" : "FAIL"}`,
    `**Runtime:** ${runtimeMs} ms`,
    `**Formal proof:** no — finite-domain execution of production \`preciseTurnReasons\` only.`,
    "",
    "## Domain",
    "",
    `- Enumerated size (runtime): **${domain.size}**`,
    `- Cartesian expectation: **${expectedSize}**`,
    `- Clear (should authorize) cases: ${domain.clearCases}`,
    `- Withhold cases: ${domain.withholdCases}`,
    "",
    "### Assumptions",
    "",
    "- Discrete buckets listed in `DOMAIN` inside `check-precise-turn.ts`.",
    "- Includes missing/invalid GPS accuracy, non-positive distance, and multi-reason sensor sets.",
    "- Does not claim coverage of continuous physical sensor space.",
    "",
    "## Mutation",
    "",
    mutation
      ? `- ${mutation.detail}`
      : "- Skipped (pass `--mutation` to run).",
    "",
    "## Failures",
    "",
    domain.failures.length ? domain.failures.map((f) => `- ${f}`).join("\n") : "- none",
    "",
  ].join("\n");

  console.log(report);
  if (outPath) {
    const abs = path.isAbsolute(outPath) ? outPath : path.join(repoRoot, outPath);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, report);
    console.error(`Wrote ${abs}`);
  }

  if (!ok) process.exit(1);
}

main();
