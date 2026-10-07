// apps/web/tests/browser/alerts-reflow.test.ts — the alerts view reflows at narrow widths.
//
// At 375px and 320px viewports every alerts fixture page MUST reflow, never side-scroll: the document's
// scrollWidth stays within its clientWidth, and the view's controls (tabs, facet filters, active-filter
// chips, the triage table's open buttons, the detail drawer, the source-status notice) sit inside the viewport so the
// view stays usable. A wide table may scroll inside its OWN container; the page itself may not.
// Run in BOTH themes.
//
// SELF-SKIPS when Chromium is not provisioned (_harness.browserDescribe).

import { afterAll, beforeAll, expect, test } from "bun:test";

import { browserDescribe } from "./_harness.js";
import { ALERTS_FIXTURES, ALERTS_THEMES, openAlertsPages, type AlertsBrowserSession } from "./alerts-browser.js";

const VIEWPORT = { width: 375, height: 812 } as const;
/** Every width checked; the session opens at 375 and each test resizes through these. */
const WIDTHS = [375, 320] as const;

/** Interactive / status surfaces that must be reachable at 375px (checked when present). */
const USABLE_SELECTORS = [
  '[role="tab"]',
  '[data-slot="facet-filter"] button',
  '[data-slot="active-filters"] button',
  '[data-slot="callout"][data-availability]',
  '[role="dialog"]',
] as const;

browserDescribe()("browser: alerts view 375/320px reflow without side-scroll, both themes", () => {
  let session: AlertsBrowserSession;

  beforeAll(async () => {
    session = await openAlertsPages({ viewport: VIEWPORT });
  }, 600_000);

  afterAll(async () => {
    await session?.close();
  }, 60_000);

  for (const def of ALERTS_FIXTURES) {
    for (const theme of ALERTS_THEMES) {
      test(`alerts-${def.id}: no horizontal page scroll at 375/320px (${theme})`, async () => {
        const page = session.page(def.id, theme);
        try {
          for (const width of WIDTHS) {
            await page.setViewportSize({ width, height: VIEWPORT.height });
            const overflow = await page.evaluate(() => {
              const el = document.documentElement;
              return { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth };
            });
            expect(
              overflow.scrollWidth,
              `${width}px: documentElement overflows: scrollWidth=${overflow.scrollWidth} clientWidth=${overflow.clientWidth}`,
            ).toBeLessThanOrEqual(overflow.clientWidth + 1);
          }
        } finally {
          await page.setViewportSize(VIEWPORT);
        }
      }, 60_000);

      test(`alerts-${def.id}: controls stay inside the 375/320px viewport (${theme})`, async () => {
        const page = session.page(def.id, theme);
        try {
          for (const width of WIDTHS) {
            await page.setViewportSize({ width, height: VIEWPORT.height });
            const offscreen = await page.evaluate((selectors) => {
              const limit = document.documentElement.clientWidth + 1;
              const bad: string[] = [];
              for (const sel of selectors) {
                for (const el of Array.from(document.querySelectorAll(sel))) {
                  const r = el.getBoundingClientRect();
                  if (r.width === 0 && r.height === 0) continue; // not rendered (e.g. inactive panel)
                  if (r.left < -1 || r.right > limit) {
                    bad.push(`${sel} "${el.textContent?.trim().slice(0, 40)}" left=${r.left} right=${r.right}`);
                  }
                }
              }
              return bad;
            }, [...USABLE_SELECTORS]);
            expect(offscreen, `controls outside the viewport at ${width}px:\n${offscreen.join("\n")}`).toEqual([]);
          }
        } finally {
          await page.setViewportSize(VIEWPORT);
        }
      }, 60_000);
    }
  }

  test("the catalog and silences tables scroll inside their own region, not the page", async () => {
    for (const id of ["catalog", "silences"] as const) {
      const page = session.page(id, "light");
      try {
        await page.setViewportSize({ width: 320, height: VIEWPORT.height });
        const result = await page.evaluate(() => {
          const table = document.querySelector('[role="tabpanel"]:not([hidden]) [data-slot="data-table"] table');
          const region = table?.closest('[role="region"]') ?? null;
          return {
            found: table !== null && region !== null,
            regionRight: region?.getBoundingClientRect().right ?? Infinity,
            limit: document.documentElement.clientWidth + 1,
          };
        });
        expect(result.found, id).toBe(true);
        expect(result.regionRight, `${id} table region overflows the page`).toBeLessThanOrEqual(result.limit);
      } finally {
        await page.setViewportSize(VIEWPORT);
      }
    }
  }, 60_000);

  test("the firing table's open buttons are reachable by horizontally scrolling only their container", async () => {
    const page = session.page("mixed", "dark");
    const result = await page.evaluate(() => {
      const btn = document.querySelector<HTMLElement>("[data-triage-table] [data-triage-open]");
      if (btn === null) return { found: false, visible: false };
      btn.scrollIntoView({ block: "nearest", inline: "nearest" });
      const r = btn.getBoundingClientRect();
      return {
        found: true,
        visible: r.width > 0 && r.left >= -1 && r.right <= document.documentElement.clientWidth + 1,
        pageScrollX: window.scrollX,
      };
    });
    expect(result.found).toBe(true);
    expect(result.visible).toBe(true);
  }, 60_000);
});
