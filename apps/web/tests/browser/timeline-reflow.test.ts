// apps/web/tests/browser/timeline-reflow.test.ts — REQ-A11Y-04 (08 §5, 07 §10).
//
// At a 375px viewport the timeline view (desk and kiosk) MUST reflow, never side-scroll: the document's
// scrollWidth (and document.scrollingElement's) stays within its clientWidth. The plot column keeps a
// MIN_PLOT_WIDTH_PX (320) plot and scrolls INSIDE its own container (`[data-slot="timeline-plot-col"]`,
// overflow-x: auto) — so at least one plot column genuinely overflows while the page does not.
// Run in BOTH themes.
//
// Reduced motion: a SECOND session emulates `prefers-reduced-motion: reduce`; under it every
// `[data-slot="plot-cursor"]` and `[data-slot="plot-brush"]` computes every comma-separated
// `transition-duration` to ≤ 0.01 ms (the reduced-motion rule in styles/app.css forces `0.01ms !important`, which computes as
// "1e-05s"). The brush is made visible by a primary-pointer drag dispatched on a lane overlay before
// measuring (on the element itself, so viewport hit-testing cannot swallow the gesture).
//
// SELF-SKIPS when Chromium is not provisioned (_harness.browserDescribe).

import { afterAll, beforeAll, expect, test } from "bun:test";

import { browserDescribe } from "./_harness.js";
import { openTimelinePages, TIMELINE_THEMES, type TimelineBrowserSession } from "./timeline-browser.js";

const VIEWPORT = { width: 375, height: 812 } as const;
const DESK_VIEWPORT = { width: 1280, height: 900 } as const;

/** Pages checked for 375px reflow: the desk envelope and the same scenario in kiosk. */
const REFLOW_PAGES = ["envelope", "kiosk"] as const;

browserDescribe()("browser: timeline view 375px reflow without side-scroll, both themes (REQ-A11Y-04)", () => {
  let session: TimelineBrowserSession;

  beforeAll(async () => {
    session = await openTimelinePages({ viewport: VIEWPORT });
  }, 600_000);

  afterAll(async () => {
    await session?.close();
  }, 60_000);

  for (const id of REFLOW_PAGES) {
    for (const theme of TIMELINE_THEMES) {
      test(`REQ-A11Y-04: timeline-${id}: no horizontal page scroll at 375px, plot column scrolls internally (${theme})`, async () => {
        const result = await session.page(id, theme).evaluate(() => {
          const el = document.documentElement;
          const se = document.scrollingElement ?? el;
          const cols = Array.from(document.querySelectorAll<HTMLElement>('[data-slot="timeline-plot-col"]')).map(
            (col) => {
              const cs = getComputedStyle(col);
              return {
                scrollWidth: col.scrollWidth,
                clientWidth: col.clientWidth,
                overflowX: cs.overflowX,
              };
            },
          );
          return {
            scrollWidth: el.scrollWidth,
            clientWidth: el.clientWidth,
            seScrollWidth: se.scrollWidth,
            seClientWidth: se.clientWidth,
            cols,
          };
        });
        expect(
          result.scrollWidth,
          `documentElement overflows: scrollWidth=${result.scrollWidth} clientWidth=${result.clientWidth}`,
        ).toBeLessThanOrEqual(result.clientWidth + 1);
        expect(
          result.seScrollWidth,
          `scrollingElement overflows: scrollWidth=${result.seScrollWidth} clientWidth=${result.seClientWidth}`,
        ).toBeLessThanOrEqual(result.seClientWidth + 1);

        expect(result.cols.length, "no timeline plot column rendered").toBeGreaterThan(0);
        const uncontained = result.cols.filter((c) => c.overflowX !== "auto" && c.overflowX !== "scroll");
        expect(
          uncontained,
          `plot columns whose horizontal overflow is not contained in their own scroller:\n${JSON.stringify(uncontained)}`,
        ).toEqual([]);
        const overflowing = result.cols.filter((c) => c.scrollWidth > c.clientWidth);
        expect(
          overflowing.length,
          `no plot column scrolls internally at 375px: ${JSON.stringify(result.cols)}`,
        ).toBeGreaterThan(0);
      }, 60_000);
    }
  }
});

browserDescribe()("browser: timeline lane labels stay aligned with their plot lanes at 375px, both themes", () => {
  let session: TimelineBrowserSession;

  beforeAll(async () => {
    session = await openTimelinePages({ viewport: VIEWPORT });
  }, 600_000);

  afterAll(async () => {
    await session?.close();
  }, 60_000);

  for (const id of REFLOW_PAGES) {
    for (const theme of TIMELINE_THEMES) {
      test(`timeline-${id}: the axis spacer matches the axis and every label row sits on its plot lane (${theme})`, async () => {
        const read = await session.page(id, theme).evaluate(() => {
          const box = (el: Element | null): { top: number; height: number } | null => {
            if (el === null) return null;
            const r = el.getBoundingClientRect();
            return { top: r.top, height: r.height };
          };
          const lanes = document.querySelector('[data-slot="timeline-lanes"]');
          const rows = Array.from(lanes?.querySelectorAll("[data-tree-row]") ?? []).map((row) => {
            const key = row.getAttribute("data-lane-key") ?? "";
            const bar = lanes?.querySelector(`[data-block] svg g[data-lane="${CSS.escape(key)}"] rect`) ?? null;
            return { key, row: box(row), bar: box(bar) };
          });
          return {
            spacer: box(lanes?.querySelector('[data-slot="timeline-axis-spacer"]') ?? null),
            axis: box(lanes?.querySelector('svg[data-slot="timeline-axis"]') ?? null),
            rows,
          };
        });
        const msg = JSON.stringify(read);
        expect(read.spacer, msg).not.toBeNull();
        expect(read.axis, msg).not.toBeNull();
        expect(Math.abs(read.spacer!.top - read.axis!.top), msg).toBeLessThanOrEqual(1);
        expect(Math.abs(read.spacer!.height - read.axis!.height), msg).toBeLessThanOrEqual(1);
        const plotted = read.rows.filter((r) => r.row !== null && r.bar !== null);
        expect(plotted.length, msg).toBeGreaterThan(0);
        for (const r of plotted) {
          // A lane bar starts at its row's top and fills the row less the lane gap.
          expect(Math.abs(r.row!.top - r.bar!.top), `${r.key}: ${msg}`).toBeLessThanOrEqual(1);
          expect(r.bar!.height, `${r.key}: ${msg}`).toBeLessThanOrEqual(r.row!.height + 0.5);
          expect(r.bar!.height, `${r.key}: ${msg}`).toBeGreaterThanOrEqual(r.row!.height - 3);
        }
      }, 60_000);
    }
  }
});

browserDescribe()("browser: timeline overlay cursor and brush honour prefers-reduced-motion (REQ-A11Y-04)", () => {
  let session: TimelineBrowserSession;

  beforeAll(async () => {
    session = await openTimelinePages({
      viewport: DESK_VIEWPORT,
      prepare: (page) => page.emulateMedia({ reducedMotion: "reduce" }),
    });
  }, 600_000);

  afterAll(async () => {
    await session?.close();
  }, 60_000);

  for (const theme of TIMELINE_THEMES) {
    test(`REQ-A11Y-04: timeline-envelope: cursor and brush transition-duration ≤ 0.01 ms under reduced motion (${theme})`, async () => {
      const page = session.page("envelope", theme);
      // Chromium throttles rAF/timers on background pages; the other suites in the same process leave
      // their pages frontmost (timeline-perf.test.ts precedent).
      await page.bringToFront();

      // Wait for an active lane overlay whose layout has settled (same rect across two frames), so a
      // late stub reply or live refresh cannot move it mid-gesture.
      const LANE_OVERLAY = '[data-slot="timeline-lanes"] [data-slot="plot-overlay"][data-state="active"]';
      await page.waitForFunction(
        (sel) =>
          new Promise<boolean>((resolve) => {
            const rectOf = (): string | null => {
              const el = document.querySelector(sel);
              if (el === null) return null;
              const r = el.getBoundingClientRect();
              return r.width > 0 && r.height > 0 ? `${r.left},${r.top},${r.width},${r.height}` : null;
            };
            const a = rectOf();
            requestAnimationFrame(() => requestAnimationFrame(() => resolve(a !== null && a === rectOf())));
          }),
        LANE_OVERLAY,
        { timeout: 20_000 },
      );

      // Drive a primary-mouse brush drag directly on that overlay (pointerdown, then pointermoves well
      // past BRUSH_MIN_PX). Dispatching on the element skips viewport hit-testing, so the sticky readout
      // and scroll position cannot swallow the gesture, and PlotOverlay shows the brush synchronously.
      // The computed styles are then read in the same task, while the brush is still visible.
      try {
        const result = await page.evaluate((sel) => {
          const ov = document.querySelector<HTMLElement>(sel);
          if (ov === null) return null;
          const r = ov.getBoundingClientRect();
          const clientY = r.top + Math.min(r.height / 2, 10);
          const init = { isPrimary: true, pointerId: 1, pointerType: "mouse", button: 0, bubbles: true, clientY };
          const x0 = r.left + r.width * 0.25;
          const x1 = r.left + r.width * 0.6;
          ov.dispatchEvent(new PointerEvent("pointerenter", { ...init, clientX: x0, bubbles: false }));
          ov.dispatchEvent(new PointerEvent("pointerdown", { ...init, clientX: x0, buttons: 1 }));
          for (let i = 1; i <= 8; i += 1) {
            const clientX = x0 + ((x1 - x0) * i) / 8;
            ov.dispatchEvent(new PointerEvent("pointermove", { ...init, clientX, button: -1, buttons: 1 }));
          }

          const toMs = (raw: string): number => {
            const v = raw.trim();
            if (v.endsWith("ms")) return Number.parseFloat(v.slice(0, -2));
            if (v.endsWith("s")) return Number.parseFloat(v.slice(0, -1)) * 1000;
            return Number.NaN;
          };
          const cursors = Array.from(document.querySelectorAll('[data-slot="plot-cursor"]'));
          const brushes = Array.from(document.querySelectorAll('[data-slot="plot-brush"]'));
          const visibleBrushes = brushes.filter(
            (el) => !(el as HTMLElement).hidden && el.getBoundingClientRect().width > 0,
          );
          const offenders: string[] = [];
          for (const el of [...cursors, ...brushes]) {
            const durations = getComputedStyle(el).transitionDuration.split(",");
            for (const d of durations) {
              const ms = toMs(d);
              if (!(ms <= 0.01)) offenders.push(`${String(el.getAttribute("data-slot"))} transition-duration=${d.trim()}`);
            }
          }
          return {
            reduced: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
            cursors: cursors.length,
            visibleBrushes: visibleBrushes.length,
            offenders,
          };
        }, LANE_OVERLAY);
        expect(result, "no active lane overlay to brush over").not.toBeNull();
        expect(result!.reduced).toBe(true);
        expect(result!.cursors).toBeGreaterThanOrEqual(1);
        expect(result!.visibleBrushes, "brush not visible after a primary-pointer drag").toBeGreaterThanOrEqual(1);
        expect(result!.offenders, `transitions longer than 0.01 ms:\n${result!.offenders.join("\n")}`).toEqual([]);
      } finally {
        // Cancel (not release) the gesture, so the brush hides without zooming the page.
        await page.evaluate((sel) => {
          const init = { isPrimary: true, pointerId: 1, pointerType: "mouse", bubbles: true };
          document.querySelector(sel)?.dispatchEvent(new PointerEvent("pointercancel", init));
        }, LANE_OVERLAY);
      }
    }, 60_000);
  }
});
