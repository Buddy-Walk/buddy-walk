/// <reference types="node" />
// Runs the Team console against a throwaway mobile/server with seeded Trials:
// mongod (data in .stack/) -> scripts/seed-trials.ts -> mobile/server -> vp dev.
//
//   bun scripts/local-stack.ts                 runs until Ctrl-C
//   bun scripts/local-stack.ts -- <command>    runs the command against it, then stops
//
// The command gets API_BASE_URL, ADMIN_TOKEN and CONSOLE_URL; .stack/env holds the
// first two for tools started separately. Logs stay in .stack/ after it stops.
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { fileURLToPath } from "node:url";

import { seededTrials } from "./seed-trials.ts";

const consoleDir = fileURLToPath(new URL("..", import.meta.url));
const mobileDir = fileURLToPath(new URL("../../mobile/", import.meta.url));
const stackDir = `${consoleDir}.stack`;
const dataDir = `${stackDir}/db`;
const pidFile = `${stackDir}/pid`;

// bun passes a leading `--` through or drops it, depending on how it was called.
const command = process.argv.slice(2);
if (command[0] === "--") command.shift();

const children: { name: string; process: ChildProcess }[] = [];
let stopping = false;

/** Stops every process this started, newest first, then removes the database. */
async function stop(code: number): Promise<never> {
  stopping = true;
  for (const { process: child } of [...children].reverse()) {
    if (child.exitCode !== null || child.signalCode !== null || !child.pid) continue;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    process.kill(-child.pid, "SIGTERM");
    const timeout = setTimeout(() => child.pid && process.kill(-child.pid, "SIGKILL"), 10_000);
    await exited;
    clearTimeout(timeout);
  }
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(pidFile, { force: true });
  process.exit(code);
}

for (const [signal, code] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
  ["SIGHUP", 129],
] as const) {
  process.on(signal, () => void stop(code));
}

async function fail(message: string): Promise<never> {
  console.error(`\n${message}`);
  return stop(1);
}

/** Starts a process in its own group, so stopping it also stops what it spawns. */
function start(
  name: string,
  file: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
) {
  const log = openSync(`${stackDir}/${name}.log`, "w");
  const child = spawn(file, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["ignore", log, log],
    detached: true,
  });
  children.push({ name, process: child });
  child.on("exit", (code) => {
    if (!stopping) void fail(`${name} exited with code ${code}; see .stack/${name}.log`);
  });
  child.on("error", (error) => void fail(`${name} could not start: ${error.message}`));
}

/** Runs a short command to completion, failing the stack if it fails. */
function run(name: string, file: string, args: string[]): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn(file, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("error", (error) => void fail(`${name} could not start: ${error.message}`));
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else void fail(`${name} failed with code ${code}:\n${output}`);
    });
  });
}

const accepts = (port: number, host: string) =>
  new Promise<boolean>((resolve) => {
    const socket = connect({ port, host });
    const settle = (open: boolean) => {
      socket.destroy();
      resolve(open);
    };
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
    socket.setTimeout(500, () => settle(false));
  });

const inUse = async (port: number) =>
  (await accepts(port, "127.0.0.1")) || (await accepts(port, "::1"));

/** A port the OS says is free, for the processes only this script talks to. */
const anyFreePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(typeof address === "object" && address ? address.port : 0));
    });
  });

/** The first free port from `from`, so the console's URL stays predictable. */
async function consolePort(from: number) {
  for (let port = from; port < from + 20; port++) {
    if (!(await inUse(port))) return port;
    console.log(`Port ${port} is in use; trying ${port + 1}.`);
  }
  return fail(`No free port from ${from} to ${from + 19} for the console.`);
}

async function waitFor(name: string, ready: () => Promise<boolean>, seconds = 120) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    if (await ready().catch(() => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  await fail(`${name} did not start within ${seconds}s; see .stack/${name}.log`);
}

const responds =
  (url: string, headers: Record<string, string> = {}) =>
  async () =>
    (await fetch(url, { headers })).ok;

// --- Start -------------------------------------------------------------------

if (existsSync(pidFile)) {
  const pid = Number(readFileSync(pidFile, "utf8"));
  const alive = (() => {
    try {
      return process.kill(pid, 0);
    } catch {
      return false;
    }
  })();
  if (alive) await fail(`A local stack is already running (pid ${pid}). Stop it first.`);
}
rmSync(stackDir, { recursive: true, force: true });
mkdirSync(dataDir, { recursive: true });
writeFileSync(pidFile, String(process.pid));

if (!existsSync(`${mobileDir}node_modules/.bin/tsx`)) {
  await fail("mobile/server's dependencies are missing: run `npm ci` in mobile/.");
}

const mongoPort = await anyFreePort();
const apiPort = await anyFreePort();
const port = await consolePort(Number(process.env.PORT) || 3000);
const mongoUri = `mongodb://127.0.0.1:${mongoPort}/team_console_stack`;
const apiBase = `http://127.0.0.1:${apiPort}`;
const consoleUrl = `http://localhost:${port}`;
// A token for this stack only; it never leaves the machine.
const token = randomBytes(16).toString("hex");

start(
  "mongod",
  "mongod",
  ["--dbpath", dataDir, "--port", String(mongoPort), "--bind_ip", "127.0.0.1"],
  stackDir,
  {},
);
await waitFor("mongod", () => accepts(mongoPort, "127.0.0.1"));

const seedFile = `${stackDir}/trials.json`;
writeFileSync(seedFile, JSON.stringify(seededTrials()));
await run("mongoimport", "mongoimport", [
  "--quiet",
  `--uri=${mongoUri}`,
  "--collection=last_mile_test_log",
  "--jsonArray",
  `--file=${seedFile}`,
]);

start("mobile-server", `${mobileDir}node_modules/.bin/tsx`, ["server/index.ts"], mobileDir, {
  NODE_ENV: "development",
  MONGODB_URI: mongoUri,
  ADMIN_TOKEN: token,
  PORT: String(apiPort),
});
await waitFor(
  "mobile-server",
  responds(`${apiBase}/api/last-meters-tests?limit=1`, { "x-admin-token": token }),
);

start("console", "bunx", ["vp", "dev", "--port", String(port), "--strictPort"], consoleDir, {
  API_BASE_URL: apiBase,
  ADMIN_TOKEN: token,
});
await waitFor("console", responds(consoleUrl));

writeFileSync(`${stackDir}/env`, `API_BASE_URL=${apiBase}\nADMIN_TOKEN=${token}\n`);
console.log(`Team console: ${consoleUrl}/trials`);
console.log(`mobile/server: ${apiBase} (API_BASE_URL and ADMIN_TOKEN in .stack/env)`);
console.log(`Logs: .stack/*.log`);

if (command.length) {
  const [file, ...args] = command;
  const child = spawn(file, args, {
    stdio: "inherit",
    env: { ...process.env, API_BASE_URL: apiBase, ADMIN_TOKEN: token, CONSOLE_URL: consoleUrl },
  });
  child.on("exit", (code) => void stop(code ?? 1));
} else {
  console.log("Running until Ctrl-C.");
}
