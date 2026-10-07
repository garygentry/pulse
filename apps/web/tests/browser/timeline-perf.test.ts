// apps/web/tests/browser/timeline-perf.test.ts — REQ-PERF-02 / REQ-PERF-03 / REQ-PERF-05 (08 §6).
//
// Against the envelope fixture page (TIMELINE_ENVELOPE: 100 hosts, 24h, every stubbed history reply
// delayed 50 ms, the REAL lazy uPlot chunk):
//  - REQ-PERF-02: the host lanes and the alert swimlane SVG paint ≤ 3000 ms after navigation, read
//    from <html data-lanes-painted-at> (performance.now() stamped by fixtures/timeline-render.tsx;
//    navigation start is performance time 0). Measured on a foreground reload.
//  - REQ-PERF-03: selecting a host → all four curated charts' .u-over overlays measured
//    ([data-slot="timeseries-plot"][data-overlay-state="measured"] ×4 in the detail region) ≤ 2000 ms.
//  - REQ-PERF-05: pointermove over a lane overlay → the cursor readout's time text updates; the
//    median of 20 distinct moves is ≤ 100 ms.
// Every timing is taken in-page with performance.now() and returned through page.evaluate. The page
// is brought to the front first because Chromium throttles rAF on background pages.
//
// Runs in the DARK theme only: the theme does not change the cost (08 §6).
//
// SELF-SKIPS when Chromium is not provisioned (_harness.browserDescribe).

import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Page } from "playwright-core";

import { browserDescribe } from "./_harness.js";
import { openTimelinePages, type TimelineBrowserSession } from "./timeline-browser.js";

const LANES_BUDGET_MS = 3000;
const CHARTS_BUDGET_MS = 2000;
const READOUT_BUDGET_MS = 100;
const MOVES = 20;

const LANES_SVG = '[data-slot="timeline-lanes"] [data-block] svg';
const MEASURED = '[data-slot="timeline-detail"] [data-slot="timeseries-plot"][data-overlay-state="measured"]';
const HOST_ROW = '[data-tree-row][data-lane-key^="host:"]';
const LANE_OVERLAY = '[data-slot="timeline-lanes"] [data-slot="plot-overlay"]';
const READOUT_TIME = '[data-slot="timeline-readout-slot"] [data-slot="cursor-readout-time"]';

function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Select an unselected host and resolve with the ms until four chart overlays are measured. */
function selectHostAndMeasure(page: Page): Promise<number> {
  return page.evaluate(
    ({ measured, hostRow }) =>
      new Promise<number>((resolve, reject) => {
        const row = [...document.querySelectorAll<HTMLElement>(hostRow)].find(
          (el) => el.getAttribute("aria-selected") !== "true",
        );
        if (row === undefined) return reject(new Error(`no unselected ${hostRow}`));
        let t0 = 0;
        let settled = false;
        const count = (): number => document.querySelectorAll(measured).length;
        const finish = (): void => {
          if (settled) return;
          settled = true;
          observer.disconnect();
          clearTimeout(timer);
          resolve(performance.now() - t0);
        };
        const observer = new MutationObserver(() => {
          if (count() >= 4) finish();
        });
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          observer.disconnect();
          reject(new Error(`only ${count()} of 4 chart overlays measured after 10 s`));
        }, 10_000);
        observer.observe(document.body, { subtree: true, attributes: true, childList: true });
        t0 = performance.now();
        (row.querySelector<HTMLElement>('[data-slot="timeline-lane-name"]') ?? row).click();
      }),
    { measured: MEASURED, hostRow: HOST_ROW },
  );
}

browserDescribe()("browser: timeline envelope render budgets (REQ-PERF-02, REQ-PERF-03, REQ-PERF-05)", () => {
  let session: TimelineBrowserSession;

  beforeAll(async () => {
    session = await openTimelinePages({});
  }, 600_000);

  afterAll(async () => {
    await session?.close();
  }, 60_000);

  test(`REQ-PERF-02: envelope host lanes + swimlane SVG ≤ ${LANES_BUDGET_MS} ms after navigation`, async () => {
    const page = session.page("envelope", "dark");
    await page.bringToFront();
    // The initial load ran while other pages were being opened; navigate again in the foreground to
    // time a clean load. The fixture replaceState()d the URL to /timeline, which the loopback server
    // does not serve, so go back to the server root rather than reload().
    await page.goto(new URL("/", page.url()).href, { waitUntil: "load" });
    await page.waitForSelector("html[data-fixture-ready]");
    await page.waitForSelector(LANES_SVG);
    await page.waitForSelector("html[data-lanes-painted-at]", { timeout: 10_000 });
    const ms = await page.evaluate(() => Number(document.documentElement.dataset["lanesPaintedAt"]));
    expect(Number.isFinite(ms), `data-lanes-painted-at = ${ms}`).toBe(true);
    expect(ms, `lanes + swimlane painted at ${ms.toFixed(1)} ms`).toBeLessThanOrEqual(LANES_BUDGET_MS);
  }, 120_000);

  test(`REQ-PERF-03: four measured .u-over overlays ≤ ${CHARTS_BUDGET_MS} ms after host selection`, async () => {
    const page = session.page("envelope", "dark");
    await page.bringToFront();
    const ms = await selectHostAndMeasure(page);
    expect(ms, `four chart overlays measured after ${ms.toFixed(1)} ms`).toBeLessThanOrEqual(CHARTS_BUDGET_MS);
    const counts = await page.evaluate(
      (measured) => document.querySelectorAll(measured).length,
      MEASURED,
    );
    expect(counts).toBe(4);
  }, 120_000);

  test(`REQ-PERF-05: cursor → readout median of ${MOVES} pointermoves ≤ ${READOUT_BUDGET_MS} ms`, async () => {
    const page = session.page("envelope", "dark");
    await page.bringToFront();
    // The host's four charts must be on the page (selected by REQ-PERF-03, or select one now).
    const measured = await page.evaluate((sel) => document.querySelectorAll(sel).length, MEASURED);
    if (measured < 4) await selectHostAndMeasure(page);

    const deltas = await page.evaluate(
      async ({ overlaySel, readoutSel, moves }) => {
        const overlay = document.querySelector<HTMLElement>(overlaySel);
        const readout = document.querySelector<HTMLElement>(readoutSel);
        if (overlay === null) throw new Error(`no ${overlaySel}`);
        if (readout === null) throw new Error(`no ${readoutSel}`);
        const frame = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()));
        const r = overlay.getBoundingClientRect();
        const clientY = r.top + r.height / 2;
        const init = { isPrimary: true, pointerId: 1, pointerType: "mouse", bubbles: true, clientY };
        overlay.dispatchEvent(new PointerEvent("pointerenter", { ...init, clientX: r.left + 1 }));
        const out: number[] = [];
        for (let i = 0; i < moves; i += 1) {
          const before = readout.textContent ?? "";
          const clientX = r.left + r.width * (0.1 + i * 0.04);
          const delta = await new Promise<number>((resolve, reject) => {
            let t0 = 0;
            const observer = new MutationObserver(() => {
              if ((readout.textContent ?? "") === before) return;
              observer.disconnect();
              clearTimeout(timer);
              resolve(performance.now() - t0);
            });
            const timer = setTimeout(() => {
              observer.disconnect();
              reject(new Error(`move ${i}: readout text never changed from "${before}"`));
            }, 5_000);
            observer.observe(readout, { characterData: true, childList: true, subtree: true });
            t0 = performance.now();
            overlay.dispatchEvent(new PointerEvent("pointermove", { ...init, clientX }));
          });
          out.push(delta);
          await frame();
        }
        return out;
      },
      { overlaySel: LANE_OVERLAY, readoutSel: READOUT_TIME, moves: MOVES },
    );

    expect(deltas).toHaveLength(MOVES);
    const med = median(deltas);
    expect(med, `readout deltas (ms): ${deltas.map((d) => d.toFixed(1)).join(", ")}`).toBeLessThanOrEqual(
      READOUT_BUDGET_MS,
    );
  }, 120_000);
});
