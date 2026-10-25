import type { TestContext } from "node:test";

/** Set environment variables for one test and restore their previous values when it ends. */
export function setTestEnv(t: TestContext, values: Record<string, string>) {
  const saved = Object.keys(values).map((name) => [name, process.env[name]] as const);
  Object.assign(process.env, values);
  t.after(() => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}
