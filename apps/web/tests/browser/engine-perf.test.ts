// apps/web/tests/browser/engine-perf.test.ts — REQ-PERF-01 / REQ-SCALE-02 (08 §6).
//
// Assigning the 500-target envelope payload to the engine store MUST paint the verdict banner and the
// last payload region within 1000 ms, measured in-page by window.__engineFixture.loadEnvelope()
// (performance.now() delta until painted, plus one requestAnimationFrame). The page is brought to the
// front first because Chromium throttles rAF on background pages. Afterwards every scrape job (25) and
// rule group (60) of the envelope is on the page.
//
// Runs in the DARK theme only: the theme does not change the cost (08 §6).
//
// SELF-SKIPS when Chromium is not provisioned (_harness.browserDescribe).

import { afterAll, beforeAll, expect, test } from "bun:test";

import { browserDescribe } from "./_harness.js";
import { openEnginePages, type EngineBrowserSession } from "./engine-browser.js";

/** The perf hook installed by fixtures/engine-render.tsx (typed locally; the .tsx is not imported). */
type EngineFixtureWindow = Window & { __engineFixture?: { loadEnvelope(): Promise<number> } };

const BUDGET_MS = 1000;

browserDescribe()("browser: engine envelope render budget (REQ-PERF-01, REQ-SCALE-02)", () => {
  let session: EngineBrowserSession;

  beforeAll(async () => {
    session = await openEnginePages({});
  }, 600_000);

  afterAll(async () => {
    await session?.close();
  }, 60_000);

  test(`REQ-PERF-01/REQ-SCALE-02: envelope (500 targets) assignment → painted verdict and last region ≤ ${BUDGET_MS} ms`, async () => {
    const page = session.page("all-green", "dark");
    await page.bringToFront();
    const ms = await page.evaluate(() => (window as EngineFixtureWindow).__engineFixture!.loadEnvelope());
    expect(ms, `envelope paint took ${ms.toFixed(1)} ms`).toBeLessThanOrEqual(BUDGET_MS);

    const counts = await page.evaluate(() => ({
      jobs: document.querySelectorAll('[data-region="scrape"] [data-job]').length,
      groups: document.querySelectorAll('[data-region="rules"] [data-group]').length,
      verdict: document.querySelector("[data-verdict]") !== null,
    }));
    expect(counts.jobs).toBe(25);
    expect(counts.groups).toBe(60);
    expect(counts.verdict).toBe(true);
  }, 120_000);
});
