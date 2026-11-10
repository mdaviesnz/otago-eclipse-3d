import { defineConfig, devices } from "@playwright/test";

// The site is static, so the "web server" is just a file server over the repo root.
export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.spec.mjs",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  // Locally Playwright would start one worker per two cores (6 on the dev machine). CI keeps
  // Playwright's default, which is already lower on its runners.
  workers: process.env.CI ? undefined : 4,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? [["github"], ["list"], ["html", { open: "never" }]]
    : [["list"]],
  use: {
    baseURL: "http://127.0.0.1:8788",
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // Not plain `python -m http.server`: it queues only 5 connections, and parallel tests were
    // refused at random. See tests/serve.py.
    command: `python tests/serve.py ${process.env.SERVE_DIR || "."}`,
    url: "http://127.0.0.1:8788/map.html",
    reuseExistingServer: !process.env.CI,
    stdout: "ignore",
    stderr: "ignore",
    timeout: 60_000,
  },
});
