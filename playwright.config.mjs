import { defineConfig, devices } from "@playwright/test";

// The site is static, so the "web server" is just a file server over the repo root.
export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.spec.mjs",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],
  use: {
    baseURL: "http://127.0.0.1:8788",
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npx --yes http-server . -p 8788 -c-1 --silent",
    url: "http://127.0.0.1:8788/map.html",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
