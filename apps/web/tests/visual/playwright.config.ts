// apps/web/tests/visual/playwright.config.ts — the visual-regression suite (GitHub #4).
//
// `@playwright/test` runs ONLY the `visual-*.pw.ts` specs here; the `.pw.ts` suffix keeps them out
// of `bun test` (which collects `*.test.*` and `*.spec.*`), and the playwright-core browser suites
// under tests/browser keep running under `bun test` unchanged. Run from the repo root:
//   bunx playwright test -c apps/web/tests/visual          # verify (CI, or UPDATE_VISUALS=1)
//   bunx playwright test -c apps/web/tests/visual --update-snapshots   # CI-only regeneration
// Baselines land beside each spec in `visual-<view>.pw.ts-snapshots/` (chromium-linux suffix).

import { defineConfig, devices } from "@playwright/test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { FROZEN_NOW_ISO, SCENARIO, SCENARIO_CLOCK_ISO } from "./scenario.js";

const here = dirname(fileURLToPath(import.meta.url));
const webDir = resolve(here, "../..");
// Set PULSE_VISUAL_PORT to run beside another server (or another worktree's suite).
const port = Number(process.env["PULSE_VISUAL_PORT"] ?? 4319);
const CI = Boolean(process.env["CI"]);

export default defineConfig({
  testDir: here,
  testMatch: /visual-.*\.pw\.ts$/,
  outputDir: resolve(webDir, ".visual-results"),
  fullyParallel: true,
  workers: CI ? 3 : 2,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  // A mass failure (e.g. missing baselines) must not run every test to its expect timeout.
  maxFailures: CI ? 15 : 0,
  timeout: 150_000,
  expect: { timeout: 20_000, toHaveScreenshot: { maxDiffPixels: 0 } },
  reporter: CI ? [["github"], ["list"]] : "list",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: `http://127.0.0.1:${port}`,
    timezoneId: "UTC",
    locale: "en-US",
    deviceScaleFactor: 1,
    // The app sends a nonce-based CSP; the suite injects one style tag (hiding the shell).
    bypassCSP: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium" }],
  webServer: {
    // `exec` hands Playwright's teardown signal straight to Bun.
    command: `exec bun tests/visual/serve.ts --mock ${SCENARIO} --clock ${SCENARIO_CLOCK_ISO} --port ${port}`,
    cwd: webDir,
    env: { ...process.env, PULSE_VISUAL_NOW: FROZEN_NOW_ISO } as Record<string, string>,
    url: `http://127.0.0.1:${port}/healthz`,
    reuseExistingServer: !CI,
    timeout: 120_000,
    stdout: "ignore",
    stderr: "pipe",
    gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
  },
});
