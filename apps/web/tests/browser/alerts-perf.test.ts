// apps/web/tests/browser/alerts-perf.test.ts — triage table 5,000-row mount cost.
//
// fixtures/alerts-perf.tsx mounts the TriageTable (@/ui DataTable, virtualized) and returns the
// in-page ms from just before the render to the second requestAnimationFrame after the commit. After
// one warm-up, seven mounts at 5,000 rows are measured, and their median must stay under ABSOLUTE_MS.
// The ceiling was an A/B against the pre-migration table (median 1,226 ms; the DataTable measured
// 78 ms on CI); with that table gone it is an absolute ceiling with room for CI jitter. Never loosen
// it without a recorded decision. The page is brought to the front first because Chromium throttles
// rAF on background pages.
//
// A perf suite (`*-perf*`): lanes do not run it locally; CI is the gate. Dark theme only — the theme
// does not change the cost.
//
// SELF-SKIPS when Chromium is not provisioned (_harness.browserDescribe).

import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { BrowserContext, Page } from "playwright-core";

import { browserDescribe, buildFixturePage, sharedBrowser, type FixturePage } from "./_harness.js";

/** The perf hook installed by fixtures/alerts-perf.tsx (typed locally; the .tsx is not imported). */
type AlertsPerfWindow = Window & {
  __alertsPerf?: { mount(n: number): Promise<number>; unmount(): void };
};

const ROWS = 5000;
const SAMPLES = 7;
const MAX_RENDERED_CONTROLS = 300;
const ABSOLUTE_MS = 250;

function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function mount(page: Page, n: number): Promise<number> {
  return page.evaluate((n) => (window as AlertsPerfWindow).__alertsPerf!.mount(n), n);
}

function unmount(page: Page): Promise<void> {
  return page.evaluate(() => (window as AlertsPerfWindow).__alertsPerf!.unmount());
}

browserDescribe()("browser: alerts triage table 5,000-row mount cost (virtualized DataTable)", () => {
  let fixture: FixturePage;
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    const [built, browser] = await Promise.all([
      buildFixturePage(resolve(import.meta.dir, "fixtures", "alerts-perf.tsx"), { theme: "dark" }),
      sharedBrowser(),
    ]);
    fixture = built;
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    context.setDefaultTimeout(30_000);
    page = await context.newPage();
    await page.goto(fixture.url, { waitUntil: "load" });
    await page.waitForSelector("html[data-fixture-ready]", { state: "attached" });
  }, 600_000);

  afterAll(async () => {
    await context?.close();
    fixture?.stop();
  }, 60_000);

  test(`median mount ≤ ${ABSOLUTE_MS} ms at ${ROWS} rows`, async () => {
    await page.bringToFront();

    // Warm-up: JIT, style recalc caches and the lazily-evaluated table modules.
    await mount(page, ROWS);
    await unmount(page);

    const samples: number[] = [];
    for (let i = 0; i < SAMPLES; i += 1) {
      samples.push(await mount(page, ROWS));
      if (i < SAMPLES - 1) await unmount(page);
    }

    // The last mount is still on the page: it must be a virtualized window over every row.
    const shape = await page.evaluate(() => ({
      controls: document.querySelectorAll("[data-triage-table] [data-triage-open]").length,
      rowcount: document.querySelector("[data-triage-table] [aria-rowcount]")?.getAttribute("aria-rowcount") ?? null,
    }));
    await unmount(page);

    const med = median(samples);
    const report = `median ${med.toFixed(1)} ms (ceiling ${ABSOLUTE_MS} ms); [${samples.map((ms) => ms.toFixed(1)).join(", ")}]`;
    console.log(`[alerts-perf] ${report}`);
    expect(med, report).toBeLessThanOrEqual(ABSOLUTE_MS);

    expect(shape.controls, `${shape.controls} row-open controls rendered`).toBeGreaterThan(0);
    expect(shape.controls, `${shape.controls} row-open controls rendered`).toBeLessThan(MAX_RENDERED_CONTROLS);
    expect(shape.rowcount).toBe(String(ROWS + 1));
  }, 300_000);
});
