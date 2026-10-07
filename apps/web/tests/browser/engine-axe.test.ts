// apps/web/tests/browser/engine-axe.test.ts — REQ-A11Y-04 (08 §4.4).
//
// Runs @axe-core/playwright over every engine fixture page — all-green, degraded (every component
// state + failing trends), loading (skeleton, aria-busy) and a source outage (verdict unknown) — in
// BOTH themes, asserting ZERO wcag2a / wcag2aa / wcag21a / wcag21aa violations.
//
// SELF-SKIPS when Chromium is not provisioned (_harness.browserDescribe); THROWS at collection under
// PULSE_REQUIRE_BROWSER=1.

import { afterAll, beforeAll, expect, test } from "bun:test";

import { browserDescribe } from "./_harness.js";
import { ENGINE_FIXTURES, ENGINE_THEMES, openEnginePages, type EngineBrowserSession } from "./engine-browser.js";

browserDescribe()("browser: engine view axe zero wcag2a/wcag2aa/wcag21a/wcag21aa violations, both themes (REQ-A11Y-04)", () => {
  let session: EngineBrowserSession;

  beforeAll(async () => {
    session = await openEnginePages({});
  }, 600_000);

  afterAll(async () => {
    await session?.close();
  }, 60_000);

  for (const def of ENGINE_FIXTURES) {
    for (const theme of ENGINE_THEMES) {
      test(`REQ-A11Y-04: engine-${def.id}: zero wcag2a/wcag2aa/wcag21a/wcag21aa violations in ${theme} theme`, async () => {
        const { AxeBuilder } = await import("@axe-core/playwright");
        const page = session.page(def.id, theme);
        // Violations only, legacy (single axe.run) mode: full axe results (~600 KB per page) over the
        // Chromium pipe wedge Bun + Playwright when several browser files share one process (the next
        // newPage/analyze never resolves). options() replaces runOnly, so it must precede withTags().
        const results = await new AxeBuilder({ page })
          .options({ resultTypes: ["violations"] })
          .setLegacyMode(true)
          .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
          .analyze();
        const summary = results.violations.map((v) => ({
          id: v.id,
          nodes: v.nodes.map((n) => ({ target: n.target, summary: n.failureSummary })),
        }));
        expect(results.violations, JSON.stringify(summary, null, 2)).toEqual([]);
      }, 60_000);
    }
  }

  test("the loading page really is the busy skeleton", async () => {
    const busy = await session.page("loading", "dark").locator('[data-slot="engine-page"] [aria-busy="true"]').count();
    expect(busy).toBeGreaterThan(0);
  }, 60_000);

  test("the source-outage page really carries the unknown verdict", async () => {
    const unknown = await session.page("source-outage", "dark").locator('[data-verdict="unknown"]').count();
    expect(unknown).toBeGreaterThan(0);
  }, 60_000);
});
