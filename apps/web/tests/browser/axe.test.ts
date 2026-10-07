// apps/web/tests/browser/axe.test.ts — SC-03, REQ-A11Y-04, 10-testing-strategy.md §3.11.
//
// Runs @axe-core/playwright over the design-system Shell fixture in BOTH themes and asserts ZERO
// wcag2a / wcag2aa violations — the accessibility bar only a real engine's computed-style + contrast
// math can prove. The fixture is design-system-owned chrome (shell + ui + tokens), so a violation is
// a defect this member fixes at its source.
//
// SELF-SKIPS when Chromium is not provisioned (see _harness.browserDescribe) OR when
// @axe-core/playwright is not installed — a plain `bun test` stays green either way. THROWS at
// collection under PULSE_REQUIRE_BROWSER=1 so CI never green-skips it (REQ-CI-01).

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

browserDescribe()("browser: axe zero wcag2a/wcag2aa violations, both themes (SC-03, REQ-A11Y-04)", () => {
  let browser: Browser;
  let context: BrowserContext;
  const pages = new Map<FixtureTheme, Page>();
  const fixtures: FixturePage[] = [];

  beforeAll(async () => {
    // Build BEFORE launching Chromium — see _harness.buildFixturePage (avoids the resolver/launch race).
    const built = await Promise.all(THEMES.map((theme) => buildFixturePage(FIXTURE_ENTRY, { theme })));
    browser = await sharedBrowser(); // process-shared; never closed here (see _harness)
    context = await browser.newContext();
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
    test(`zero wcag2a/wcag2aa violations in ${theme} theme`, async () => {
      const { AxeBuilder } = await import("@axe-core/playwright");
      const page = pages.get(theme)!;
      const results = await new AxeBuilder({ page }).options({ resultTypes: ["violations"] }).withTags(["wcag2a", "wcag2aa"]).analyze();
      const summary = results.violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target) }));
      expect(results.violations, JSON.stringify(summary, null, 2)).toEqual([]);
    }, 60_000);
  }
});
