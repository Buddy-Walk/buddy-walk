import { performance } from "node:perf_hooks";

export type LastMetersModule = "step0" | "moduleB" | "moduleC" | "moduleD" | "moduleE";
export type LastMetersModuleTimings = Partial<Record<LastMetersModule, number>>;

/** Independent elapsed times; a module can pause while another module runs. */
export function createLastMetersModuleTimer(now = () => performance.now()) {
  const started = new Map<LastMetersModule, number>();
  const durations: LastMetersModuleTimings = {};
  let finished = false;

  const start = (name: LastMetersModule) => {
    if (!finished && !started.has(name)) started.set(name, now());
  };
  const stop = (name: LastMetersModule) => {
    const since = started.get(name);
    if (since === undefined) return;
    durations[name] = (durations[name] ?? 0) + now() - since;
    started.delete(name);
  };

  return {
    start,
    stop,
    // Close unfinished work when a trial fails or returns early. Late promise
    // callbacks must not change the timings already saved with that trial.
    finish(): LastMetersModuleTimings {
      for (const name of started.keys()) stop(name);
      finished = true;
      return Object.fromEntries(Object.entries(durations).map(([name, ms]) =>
        [name, Math.round(ms * 100) / 100],
      ));
    },
  };
}
