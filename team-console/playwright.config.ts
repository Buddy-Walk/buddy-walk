import { defineConfig, devices } from "@playwright/test";

// Its own port, so a dev server on 3000 can keep running beside the tests.
const port = 3100;

export default defineConfig({
  testDir: "e2e",
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: `http://localhost:${port}`,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "bun scripts/local-stack.ts",
    url: `http://localhost:${port}/trials`,
    env: { PORT: String(port) },
    timeout: 180_000,
    // SIGTERM lets the stack stop mongod and mobile/server, which it runs in their own process groups.
    gracefulShutdown: { signal: "SIGTERM", timeout: 15_000 },
  },
});
