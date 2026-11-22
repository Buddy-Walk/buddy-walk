import { performance } from "node:perf_hooks";

import type { LastMetersModule } from "../../src/utils/lastMetersProgress";
export type { LastMetersModule } from "../../src/utils/lastMetersProgress";
/** Missing means skipped or unfinished, never zero. UI labels are mapped by buildModules. */
export type LastMetersModuleTimings = Partial<Record<LastMetersModule, number>>;

/** Completed stretches accumulate; different modules may overlap in wall-clock time.
 * Stretches of the same module run in sequence; parallel backups share one stretch.
 */
export function createLastMetersModuleTimer(
  now = () => performance.now(),
  onModuleStarted?: (name: LastMetersModule) => void,
) {
  const announced = onModuleStarted ? new Set<LastMetersModule>() : undefined;
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
    async time<T>(name: LastMetersModule, work: () => Promise<T>): Promise<T> {
      if (!finished && announced && !announced.has(name)) {
        announced.add(name);
        try {
          onModuleStarted?.(name);
        } catch {
          // A disconnected or faulty progress observer cannot affect the run.
        }
      }
      start(name);
      try {
        return await work();
      } finally {
        stop(name);
      }
    },
    finish(): LastMetersModuleTimings {
      // A pending request has no full timing. Earlier stretches alone would
      // also misrepresent its module's total, so omit the whole module.
      for (const name of started.keys()) delete durations[name];
      started.clear();
      finished = true;
      // Late async completions cannot modify this snapshot or restart timers.
      return Object.fromEntries(Object.entries(durations).map(([name, ms]) =>
        [name, Math.round(ms * 100) / 100],
      ));
    },
  };
}
