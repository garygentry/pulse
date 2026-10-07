// apps/web/tests/browser/grayscale.test.ts — SC-03, REQ-A11Y-06, 10-testing-strategy.md §3.11.
//
// Proves the five TargetStatus states survive TOTAL colour loss: with the whole page forced to
// grayscale, each StatusChip carries its state by a redundant GLYPH + a visible text LABEL (never by
// colour alone). Asserts (a) every chip renders a non-empty glyph and label, and (b) the five whole-
// chip regions are pairwise-distinct rendered pixels once colour is flattened — so no two states
// collapse to the same read. Run in BOTH themes.
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

browserDescribe()("browser: grayscale glyph+label distinctness, both themes (SC-03, REQ-A11Y-06)", () => {
  let browser: Browser;
  let context: BrowserContext;
  const pages = new Map<FixtureTheme, Page>();
  const fixtures: FixturePage[] = [];

  beforeAll(async () => {
    const built = await Promise.all(THEMES.map((theme) => buildFixturePage(FIXTURE_ENTRY, { theme })));
    browser = await sharedBrowser(); // process-shared; never closed here (see _harness)
    context = await browser.newContext();
    for (let i = 0; i < THEMES.length; i += 1) {
      const fixture = built[i]!;
      fixtures.push(fixture);
      const page = await context.newPage();
      await page.goto(fixture.url, { waitUntil: "networkidle" });
      await page.waitForSelector("[data-fixture=status-showcase] [data-slot=status-badge]");
      // Force TOTAL colour loss over the whole page — screenshots below are of the grayscale render.
      await page.addStyleTag({ content: "html { filter: grayscale(1) !important; }" });
      pages.set(THEMES[i]!, page);
    }
  }, 180_000);

  afterAll(async () => {
    await context?.close();
    for (const f of fixtures) f.stop();
  }, 60_000);

  for (const theme of THEMES) {
    test(`every status chip carries a non-empty glyph and label (${theme})`, async () => {
      const page = pages.get(theme)!;
      const rows = await page.evaluate(() =>
        Array.from(document.querySelectorAll("[data-fixture=status-showcase] [data-slot=status-badge]")).map(
          (chip) => ({
            status: chip.getAttribute("data-status"),
            glyph: /\blucide-[a-z0-9-]+/.exec(chip.querySelector("svg")?.getAttribute("class") ?? "")?.[0] ?? "",
            label: chip.textContent?.trim() ?? "",
          }),
        ),
      );
      expect(rows).toHaveLength(5);
      for (const row of rows) {
        expect(row.status, JSON.stringify(row)).toBeTruthy();
        expect(row.glyph.length, `empty glyph for ${row.status}`).toBeGreaterThan(0);
        expect(row.label.length, `empty label for ${row.status}`).toBeGreaterThan(0);
      }
      // Labels alone are pairwise-distinct — the text read never depends on colour.
      const labels = rows.map((r) => r.label);
      expect(new Set(labels).size).toBe(5);
    }, 60_000);

    test(`the five status chip regions are pairwise-distinct in grayscale (${theme})`, async () => {
      const chips = pages.get(theme)!.locator("[data-fixture=status-showcase] [data-slot=status-badge]");
      expect(await chips.count()).toBe(5);

      const shots: Buffer[] = [];
      for (let i = 0; i < 5; i += 1) shots.push(await chips.nth(i).screenshot());

      for (let a = 0; a < shots.length; a += 1) {
        for (let b = a + 1; b < shots.length; b += 1) {
          expect(
            shots[a]!.equals(shots[b]!),
            `status chips ${a} and ${b} are pixel-identical in grayscale (indistinguishable)`,
          ).toBe(false);
        }
      }
    }, 60_000);
  }
});
