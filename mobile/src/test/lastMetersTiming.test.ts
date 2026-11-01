import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { createLastMetersModuleTimer } from "../../server/utils/lastMetersTiming";
import lastMetersTestLogModel from "../../server/database/models/lastMetersTestLog";

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test("time starts before work, waits for its result and accumulates separated stretches", async () => {
  let clock = 0;
  const timer = createLastMetersModuleTimer(() => clock);
  const answer = await timer.time("preCheck", async () => { clock = 10; return 42; });
  assert.equal(answer, 42);
  clock = 100;
  await timer.time("preCheck", async () => { clock = 115; });
  await timer.time("turnDecision", async () => undefined);
  assert.deepEqual(timer.finish(), { preCheck: 25, turnDecision: 0 });
});

test("parallel modules finish independently without charging C for waiting on B", async () => {
  let clock = 0;
  const timer = createLastMetersModuleTimer(() => clock);
  const endB = signal();
  const endC = signal();
  const b = timer.time("currentViewMatch", () => endB.promise);
  const c = timer.time("destinationMatch", () => endC.promise);
  clock = 20; endC.resolve(); await c;
  clock = 100; endB.resolve(); await b;
  clock = 200;
  await timer.time("destinationMatch", async () => { clock = 240; });
  assert.deepEqual(timer.finish(), { currentViewMatch: 100, destinationMatch: 60 });
});

test("synchronous throws and async rejections retain runtime and the original error", async () => {
  let clock = 0;
  const timer = createLastMetersModuleTimer(() => clock);
  const error = new Error("provider failed");
  await assert.rejects(timer.time("turnDecision", () => { clock = 15; throw error; }), e => e === error);
  await assert.rejects(timer.time("guidance", async () => {
    await Promise.resolve(); clock = 35; throw error;
  }), e => e === error);
  assert.deepEqual(timer.finish(), { turnDecision: 15, guidance: 20 });
});

test("finish drops pending timings, including an incomplete cumulative module, and freezes the row", async () => {
  let clock = 0;
  const timer = createLastMetersModuleTimer(() => clock);
  await timer.time("destinationMatch", async () => { clock = 10; });
  const endC = signal();
  const c = timer.time("destinationMatch", () => endC.promise);
  await timer.time("currentViewMatch", async () => { clock = 50; });
  const saved = timer.finish();
  assert.deepEqual(saved, { currentViewMatch: 40 });
  clock = 250; endC.resolve(); await c;
  await timer.time("guidance", async () => { clock = 500; });
  assert.deepEqual(timer.finish(), saved);
  assert.deepEqual(saved, { currentViewMatch: 40 });
});

test("Mongo writes business names, never dashboard labels, and allows rows without timings", () => {
  const timings = { preCheck: 12, currentViewMatch: 0, destinationMatch: 34.5, turnDecision: 3, guidance: 20 };
  const row = new lastMetersTestLogModel({ moduleTimingsMs: { ...timings, moduleB: 999 } });
  assert.deepEqual(row.toObject().moduleTimingsMs, timings);
  assert.equal(new lastMetersTestLogModel({}).toObject().moduleTimingsMs?.currentViewMatch, undefined);
});

function dashboard() {
  const html = readFileSync(resolve(__dirname, "../../server/views/lastMetersTests.html"), "utf8");
  const source = html.slice(html.indexOf("    function esc("), html.indexOf("    function failureExplanation("));
  const page = vm.createContext({});
  vm.runInContext(source, page);
  return page;
}

test("dashboard maps business names to labels and shows whole ms in the heading, including zero", () => {
  const page = dashboard();
  const modules = page.buildModules({ moduleTimingsMs: {
    preCheck: 12, currentViewMatch: 0, destinationMatch: 34.5, turnDecision: 1, guidance: 25,
  } });
  for (const [name, expected] of Object.entries({ step0: 12, moduleB: 0, moduleC: 35, moduleD: 1, moduleE: 25 })) {
    assert.match(page.renderModuleBlock(modules[name]), new RegExp('class="module-head"><span>[^<]* — Runtime: ' + expected + ' ms</span>'));
  }
  for (const value of [undefined, null, NaN, Infinity]) {
    const empty = page.buildModules({ moduleTimingsMs: { currentViewMatch: value } });
    assert.ok(page.renderModuleBlock(empty.moduleB).includes(" — Runtime: —</span>"));
  }
  assert.ok(page.renderModuleBlock(page.buildModules({}).moduleC).includes(" — Runtime: —</span>"));
});

test("dashboard still reads historical timings and gives new keys precedence even at zero", () => {
  const page = dashboard();
  const old = page.buildModules({ moduleTimingsMs: { step0: 12, moduleB: 19.9, moduleC: 40, moduleD: 2, moduleE: 3 } });
  for (const [name, expected] of Object.entries({ step0: 12, moduleB: 20, moduleC: 40, moduleD: 2, moduleE: 3 })) {
    assert.ok(page.renderModuleBlock(old[name]).includes(' — Runtime: ' + expected + ' ms'));
  }
  const mixed = page.buildModules({ moduleTimingsMs: { currentViewMatch: 0, moduleB: 999 } });
  assert.equal(mixed.moduleB.durationMs, 0);
});

test("Step 0 displays the destination verification included in its runtime", () => {
  const page = dashboard();
  const candidates = { name: "destination_candidates", response: "Verified Target at 255 Greenwich St", success: true };
  const preCheck = page.buildModules({ steps: [candidates] }).step0;
  assert.ok(preCheck.raw.includes(candidates));
  assert.ok(page.renderModuleBlock(preCheck).includes("Verified Target at 255 Greenwich St"));
});
