import type { StepResult } from "../../server/services/lastMetersTrial";

/** Tests execute the exit only after the step (and its timer) has returned. */
export async function resolveLastMetersStep<T>(step: StepResult<T>) {
  return step.kind === "exit" ? { kind: "exit" as const, result: await step.respond() } : step;
}
