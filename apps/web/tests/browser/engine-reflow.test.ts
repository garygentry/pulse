// apps/web/tests/browser/engine-reflow.test.ts — REQ-A11Y-04 (08 §5).
//
// At a 375px viewport the engine all-green page MUST reflow, never side-scroll: the document's
// scrollWidth (and document.scrollingElement's) stays within its clientWidth. Run in BOTH themes.
//
// Reduced motion: a SECOND session emulates `prefers-reduced-motion: reduce`; under it every element in
// the engine view (`[data-slot="engine-page"]` and its descendants) computes every comma-separated
// `transition-duration` to ≤ 0.01 ms (the reduced-motion rule in styles/app.css forces `0.01ms !important`, which computes as
// "1e-05s").
//
// SELF-SKIPS when Chromium is not provisioned (_harness.browserDescribe).

import { afterAll, beforeAll, expect, test } from "bun:test";

import { browserDescribe } from "./_harness.js";
import { ENGINE_THEMES, openEnginePages, type EngineBrowserSession } from "./engine-browser.js";

const VIEWPORT = { width: 375, height: 812 } as const;

browserDescribe()("browser: engine view 375px reflow without side-scroll, both themes (REQ-A11Y-04)", () => {
  let session: EngineBrowserSession;

  beforeAll(async () => {
    session = await openEnginePages({ viewport: VIEWPORT });
  }, 600_000);

  afterAll(async () => {
    await session?.close();
  }, 60_000);

  for (const theme of ENGINE_THEMES) {
    test(`REQ-A11Y-04: engine-all-green: no horizontal page scroll at 375px (${theme})`, async () => {
      const overflow = await session.page("all-green", theme).evaluate(() => {
        const el = document.documentElement;
        const se = document.scrollingElement ?? el;
        return {
          scrollWidth: el.scrollWidth,
          clientWidth: el.clientWidth,
          seScrollWidth: se.scrollWidth,
          seClientWidth: se.clientWidth,
        };
      });
      expect(
        overflow.scrollWidth,
        `documentElement overflows: scrollWidth=${overflow.scrollWidth} clientWidth=${overflow.clientWidth}`,
      ).toBeLessThanOrEqual(overflow.clientWidth + 1);
      expect(
        overflow.seScrollWidth,
        `scrollingElement overflows: scrollWidth=${overflow.seScrollWidth} clientWidth=${overflow.seClientWidth}`,
      ).toBeLessThanOrEqual(overflow.seClientWidth + 1);
    }, 60_000);
  }
});

browserDescribe()("browser: engine view honours prefers-reduced-motion (REQ-A11Y-04)", () => {
  let session: EngineBrowserSession;

  beforeAll(async () => {
    session = await openEnginePages({
      viewport: VIEWPORT,
      prepare: (page) => page.emulateMedia({ reducedMotion: "reduce" }),
    });
  }, 600_000);

  afterAll(async () => {
    await session?.close();
  }, 60_000);

  for (const theme of ENGINE_THEMES) {
    test(`REQ-A11Y-04: engine-all-green: every transition-duration ≤ 0.01 ms under reduced motion (${theme})`, async () => {
      const result = await session.page("all-green", theme).evaluate(() => {
        const toMs = (raw: string): number => {
          const v = raw.trim();
          if (v.endsWith("ms")) return Number.parseFloat(v.slice(0, -2));
          if (v.endsWith("s")) return Number.parseFloat(v.slice(0, -1)) * 1000;
          return Number.NaN;
        };
        const offenders: string[] = [];
        const els = Array.from(document.querySelectorAll('[data-slot="engine-page"], [data-slot="engine-page"] *'));
        for (const el of els) {
          const durations = getComputedStyle(el).transitionDuration.split(",");
          for (const d of durations) {
            const ms = toMs(d);
            if (!(ms <= 0.01)) {
              offenders.push(`${el.tagName.toLowerCase()}.${String(el.className)} transition-duration=${d.trim()}`);
            }
          }
        }
        return {
          reduced: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
          checked: els.length,
          offenders,
        };
      });
      expect(result.reduced).toBe(true);
      expect(result.checked).toBeGreaterThan(0);
      expect(result.offenders, `transitions longer than 0.01 ms:\n${result.offenders.join("\n")}`).toEqual([]);
    }, 60_000);
  }
});
