import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { createLastMetersModuleTimer } from "../../server/utils/lastMetersTiming";
import lastMetersTestLogModel from "../../server/database/models/lastMetersTestLog";

test("module timings measure parallel work independently and accumulate retries", () => {
  let clock = 0;
  const timer = createLastMetersModuleTimer(() => clock);
  timer.start("step0");
  clock = 10;
  timer.stop("step0");
  timer.start("moduleB");
  timer.start("moduleC");
  clock = 30;
  timer.stop("moduleC");
  clock = 100;
  timer.stop("moduleB");
  // C finished its first request while B was still running. Its second
  // segment must not include the 70 ms spent waiting for B.
  timer.start("moduleC");
  clock = 140;
  timer.stop("moduleC");
  clock = 200;
  timer.start("moduleB");
  timer.start("moduleC");
  clock = 205;
  timer.stop("moduleB");
  clock = 220;
  timer.stop("moduleC");
  timer.start("moduleD");
  timer.stop("moduleD");
  assert.deepEqual(timer.finish(), { step0: 10, moduleB: 95, moduleC: 80, moduleD: 0 });
});

test("ending a failed trial freezes running timers and leaves skipped modules absent", () => {
  let clock = 0;
  const timer = createLastMetersModuleTimer(() => clock);
  timer.start("moduleB");
  clock = 10.125;
  timer.start("moduleC");
  clock = 20.555;
  const saved = timer.finish();
  assert.deepEqual(saved, { moduleB: 20.56, moduleC: 10.43 });
  clock = 500;
  timer.stop("moduleC");
  timer.start("moduleE");
  assert.deepEqual(timer.finish(), saved);
});

test("Mongo records retain module timings and allow older records without them", () => {
  const row = new lastMetersTestLogModel({ moduleTimingsMs: { step0: 12, moduleB: 0, moduleC: 34.5 } });
  const stored = row.toObject();
  assert.deepEqual(stored.moduleTimingsMs, { step0: 12, moduleB: 0, moduleC: 34.5 });
  const old = new lastMetersTestLogModel({}).toObject();
  assert.equal(old.moduleTimingsMs?.moduleB, undefined);
});

test("dashboard shows each module's own milliseconds, including zero and missing data", () => {
  const html = readFileSync(resolve(__dirname, "../../server/views/lastMetersTests.html"), "utf8");
  const source = html.slice(html.indexOf("    function esc("), html.indexOf("    function failureExplanation("));
  assert.ok(source.includes("function renderModuleBlock("));
  const page = vm.createContext({});
  vm.runInContext(source, page);
  const modules = page.buildModules({ moduleTimingsMs: { step0: 12, moduleB: 0, moduleC: 34.5, moduleD: 1, moduleE: 25 } });
  for (const [name, expected] of Object.entries({ step0: 12, moduleB: 0, moduleC: 34.5, moduleD: 1, moduleE: 25 })) {
    assert.ok(page.renderModuleBlock(modules[name]).includes(`<b>Runtime:</b> ${expected} ms`));
  }
  const old = page.buildModules({});
  assert.ok(page.renderModuleBlock(old.moduleB).includes("<b>Runtime:</b> —"));
  assert.ok(page.renderModuleBlock(page.buildModules({ moduleTimingsMs: {} }).moduleC).includes("<b>Runtime:</b> —"));
});
