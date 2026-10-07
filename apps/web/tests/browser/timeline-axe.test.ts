// apps/web/tests/browser/timeline-axe.test.ts — REQ-A11Y-04 (08 §4.4), 06 §9.
//
// Runs @axe-core/playwright over every timeline fixture page — the 100-host envelope, the incident
// (selected host with four real uPlot charts, an expanded host, every swimlane severity), the history
// error states and kiosk — in BOTH themes, asserting ZERO wcag2a / wcag2aa / wcag21a / wcag21aa
// violations. Also checks the desk PlotOverlay contract (06 §9): every active overlay is a named group
// whose aria-describedby ids all resolve; kiosk renders no interactive overlay.
//
// SELF-SKIPS when Chromium is not provisioned (_harness.browserDescribe); THROWS at collection under
// PULSE_REQUIRE_BROWSER=1.

import { afterAll, beforeAll, expect, test } from "bun:test";

import { browserDescribe } from "./_harness.js";
import { TIMELINE_FIXTURES, TIMELINE_THEMES, openTimelinePages, type TimelineBrowserSession } from "./timeline-browser.js";

const ACTIVE_OVERLAY = '[data-slot="plot-overlay"][role="group"]';

interface OverlayRead {
  state: string | null;
  label: string;
  describedBy: string[];
  missing: string[];
}

browserDescribe()("browser: timeline view axe zero wcag2a/wcag2aa/wcag21a/wcag21aa violations, both themes (REQ-A11Y-04)", () => {
  let session: TimelineBrowserSession;

  beforeAll(async () => {
    session = await openTimelinePages({});
  }, 600_000);

  afterAll(async () => {
    await session?.close();
  }, 60_000);

  for (const def of TIMELINE_FIXTURES) {
    for (const theme of TIMELINE_THEMES) {
      test(`REQ-A11Y-04: timeline-${def.id}: zero wcag2a/wcag2aa/wcag21a/wcag21aa violations in ${theme} theme`, async () => {
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

  for (const id of ["envelope", "incident"]) {
    for (const theme of TIMELINE_THEMES) {
      test(`REQ-A11Y-04: timeline-${id}: every desk overlay is a named group with resolvable aria-describedby (06 §9, ${theme})`, async () => {
        const page = session.page(id, theme);
        const overlays = await page.evaluate((sel) => {
          return Array.from(document.querySelectorAll(sel)).map((el) => {
            const describedBy = (el.getAttribute("aria-describedby") ?? "").split(/\s+/).filter((s) => s.length > 0);
            return {
              state: el.getAttribute("data-state"),
              label: (el.getAttribute("aria-label") ?? "").trim(),
              describedBy,
              missing: describedBy.filter((ref) => document.getElementById(ref) === null),
            };
          });
        }, ACTIVE_OVERLAY) as OverlayRead[];
        expect(overlays.length, `no ${ACTIVE_OVERLAY} on timeline-${id}`).toBeGreaterThan(0);
        for (const o of overlays) {
          const msg = JSON.stringify(o);
          expect(o.state, msg).toBe("active");
          expect(o.label.length, `empty overlay name: ${msg}`).toBeGreaterThan(0);
          expect(o.describedBy.length, `no aria-describedby: ${msg}`).toBeGreaterThan(0);
          expect(o.missing, `unresolved aria-describedby ids: ${msg}`).toEqual([]);
        }
        // The accessible name Chromium computes matches the non-empty aria-label.
        const first = page.locator(ACTIVE_OVERLAY).first();
        const name = await first.evaluate((el) => el.getAttribute("aria-label") ?? "");
        await expect(page.getByRole("group", { name, exact: true }).count()).resolves.toBeGreaterThan(0);
      }, 60_000);
    }
  }

  test("REQ-A11Y-04: timeline-kiosk renders no interactive overlay group (REQ-KIOSK-03)", async () => {
    for (const theme of TIMELINE_THEMES) {
      const page = session.page("kiosk", theme);
      expect(await page.locator(ACTIVE_OVERLAY).count(), `kiosk ${theme}`).toBe(0);
    }
  }, 60_000);
});
