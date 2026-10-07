// apps/web/tests/browser/reflow.test.ts — SC-03, REQ-A11Y-06, 10-testing-strategy.md §3.11.
//
// At a 375px viewport the design-system Shell MUST reflow, never side-scroll: the document's
// scrollWidth stays within its clientWidth, and no status chip glyph/label is clipped below its own
// width. Proven under a real engine because reflow + text-fit are layout properties happy-dom cannot
// compute. Run in BOTH themes.
//
// SELF-SKIPS when Chromium is not provisioned (see _harness.browserDescribe).

import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Browser, BrowserContext, Page } from "playwright-core";

import {
  browserDescribe,
  buildFixturePage,
  FIXTURE_ENTRY,
  type FixturePage,
  type FixtureTheme,
  sharedBrowser,
} from "./_harness.js";

const THEMES: readonly FixtureTheme[] = ["dark", "light"];

browserDescribe()("browser: 375px reflow without side-scroll, both themes (SC-03, REQ-A11Y-06)", () => {
  let browser: Browser;
  let context: BrowserContext;
  const pages = new Map<FixtureTheme, Page>();
  const fixtures: FixturePage[] = [];

  beforeAll(async () => {
    const built = await Promise.all(THEMES.map((theme) => buildFixturePage(FIXTURE_ENTRY, { theme })));
    browser = await sharedBrowser(); // process-shared; never closed here (see _harness)
    context = await browser.newContext({ viewport: { width: 375, height: 812 } });
    for (let i = 0; i < THEMES.length; i += 1) {
      const fixture = built[i]!;
      fixtures.push(fixture);
      const page = await context.newPage();
      await page.goto(fixture.url, { waitUntil: "networkidle" });
      await page.waitForSelector("[data-fixture=status-showcase] [data-slot=status-badge]");
      pages.set(THEMES[i]!, page);
    }
  }, 180_000);

  afterAll(async () => {
    await context?.close();
    for (const f of fixtures) f.stop();
  }, 60_000);

  for (const theme of THEMES) {
    test(`document does not overflow horizontally at 375px (${theme})`, async () => {
      const overflow = await pages.get(theme)!.evaluate(() => {
        const el = document.documentElement;
        return { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth };
      });
      // Allow a 1px sub-pixel rounding slack; the shell must not open a real horizontal scroll region.
      expect(
        overflow.scrollWidth,
        `documentElement overflows: scrollWidth=${overflow.scrollWidth} clientWidth=${overflow.clientWidth}`,
      ).toBeLessThanOrEqual(overflow.clientWidth + 1);
    }, 60_000);

    test(`no status chip glyph/label is truncated below its own width (${theme})`, async () => {
      const clipped = await pages.get(theme)!.evaluate(() => {
        const selectors = ["[data-fixture=status-showcase] [data-slot=status-badge]", "[data-fixture=status-showcase] [data-slot=status-badge] > span"];
        const bad: string[] = [];
        for (const sel of selectors) {
          for (const el of Array.from(document.querySelectorAll(sel))) {
            const e = el as HTMLElement;
            if (e.scrollWidth > e.clientWidth + 1) {
              bad.push(`${sel}("${e.textContent?.trim()}") scrollWidth=${e.scrollWidth} clientWidth=${e.clientWidth}`);
            }
          }
        }
        return bad;
      });
      expect(clipped, `truncated status content at 375px:\n${clipped.join("\n")}`).toEqual([]);
    }, 60_000);
  }
});
