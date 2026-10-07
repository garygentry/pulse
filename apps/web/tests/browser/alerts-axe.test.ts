// apps/web/tests/browser/alerts-axe.test.ts — axe over every alerts fixture page.
//
// Runs @axe-core/playwright over every alerts fixture page — the real view over a firing / silenced /
// inhibited mix, a degraded Alertmanager, the open detail pane (history strip included) and both
// read-only tabs — in BOTH themes, asserting ZERO wcag2a / wcag2aa violations.
//
// SELF-SKIPS when Chromium is not provisioned (_harness.browserDescribe); THROWS at collection under
// PULSE_REQUIRE_BROWSER=1.

import { afterAll, beforeAll, expect, test } from "bun:test";

import { browserDescribe } from "./_harness.js";
import { ALERTS_FIXTURES, ALERTS_THEMES, openAlertsPages, type AlertsBrowserSession } from "./alerts-browser.js";

browserDescribe()("browser: alerts view axe zero wcag2a/wcag2aa violations, both themes", () => {
  let session: AlertsBrowserSession;

  beforeAll(async () => {
    session = await openAlertsPages({});
  }, 600_000);

  afterAll(async () => {
    await session?.close();
  }, 60_000);

  for (const def of ALERTS_FIXTURES) {
    for (const theme of ALERTS_THEMES) {
      test(`alerts-${def.id}: zero wcag2a/wcag2aa violations in ${theme} theme`, async () => {
        const { AxeBuilder } = await import("@axe-core/playwright");
        const page = session.page(def.id, theme);
        const results = await new AxeBuilder({ page }).options({ resultTypes: ["violations"] }).withTags(["wcag2a", "wcag2aa"]).analyze();
        const summary = results.violations.map((v) => ({
          id: v.id,
          nodes: v.nodes.map((n) => ({ target: n.target, summary: n.failureSummary })),
        }));
        expect(results.violations, JSON.stringify(summary, null, 2)).toEqual([]);
      }, 60_000);
    }
  }

  test("every page has exactly one h1 'Alerts' inside data-slot=alerts-page and a URL-selected tab", async () => {
    for (const def of ALERTS_FIXTURES) {
      const read = await session.page(def.id, "light").evaluate(() => ({
        h1s: Array.from(document.querySelectorAll("h1")).map((h) => h.textContent?.trim() ?? ""),
        inPage: document.querySelector('[data-slot="alerts-page"] h1') !== null,
        selected: document.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.trim() ?? null,
      }));
      expect(read.h1s, def.id).toEqual(["Alerts"]);
      expect(read.inPage, def.id).toBe(true);
      const expected = def.id === "catalog" ? "Catalog" : def.id === "silences" ? "Silences" : "Firing";
      expect(read.selected, def.id).toBe(expected);
    }
  }, 60_000);

  test("the mixed page really carries firing, silenced and inhibited rows", async () => {
    const states = await session.page("mixed", "dark").evaluate(() =>
      Array.from(document.querySelectorAll('[data-triage-table] [data-slot="status-badge"][data-status]')).map(
        (el) => el.textContent?.trim() ?? "",
      ),
    );
    for (const state of ["firing", "silenced", "inhibited"]) expect(states).toContain(state);
  }, 60_000);
});
