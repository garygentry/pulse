// apps/web/tests/browser/estate-large-tree.test.ts — the estate inventory tree over a large estate
// (estate-fixture.tsx `?estate=large`: 50 hosts × 20 services) in a real Chromium. With every host
// expanded (`*` on a host) the TreeView virtualizes: only a window of treeitems is in the DOM, the
// keyboard reaches the last service row, axe finds no wcag2a/wcag2aa violation, and at 375px the host
// and service rows stack (label line, then meta line) without horizontal scroll.
//
// SELF-SKIPS when Chromium is not provisioned (_harness.browserDescribe); THROWS at collection under
// PULSE_REQUIRE_BROWSER=1.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { BrowserContext, Page } from "playwright-core";

import { browserDescribe, buildFixturePage, type FixturePage, sharedBrowser } from "./_harness.js";

const ESTATE_FIXTURE_ENTRY = resolve(import.meta.dir, "estate-fixture.tsx");
const HOSTS = 50;
const SERVICES = 20;
const LAST_SERVICE = '[data-tree-id="svc:rack-49/svc-19"]';

browserDescribe()("browser: estate inventory tree over a large estate (virtualized)", () => {
  let fixture: FixturePage;
  let desktop: BrowserContext;
  let mobile: BrowserContext;

  beforeAll(async () => {
    // Build BEFORE launching Chromium (see _harness.buildFixturePage).
    fixture = await buildFixturePage(ESTATE_FIXTURE_ENTRY, { theme: "dark" });
    const browser = await sharedBrowser();
    desktop = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    mobile = await browser.newContext({ viewport: { width: 375, height: 812 } });
    desktop.setDefaultTimeout(30_000);
    mobile.setDefaultTimeout(30_000);
  }, 180_000);

  afterAll(async () => {
    await desktop?.close();
    await mobile?.close();
    fixture?.stop();
  }, 60_000);

  /** Open the inventory over the large estate and expand every host with `*` on the first one. */
  async function openExpanded(context: BrowserContext): Promise<Page> {
    const page = await context.newPage();
    await page.goto(`${fixture.url}?estate=large&route=${encodeURIComponent("/estate")}`, { waitUntil: "networkidle" });
    const first = page.locator('[role="treeitem"][data-tree-id="host:rack-00"]');
    await first.waitFor();
    await first.focus();
    await page.keyboard.press("*");
    await page.waitForSelector('[data-slot="tree-view"][data-virtualized]');
    return page;
  }

  /** Treeitems in the DOM, and the focused one's id and position. */
  const treeState = (page: Page) =>
    page.evaluate(() => {
      const active = document.activeElement;
      const viewport = document.querySelector<HTMLElement>('[data-slot="tree-view-viewport"]')!;
      const rect = active?.getBoundingClientRect();
      const box = viewport.getBoundingClientRect();
      return {
        rendered: document.querySelectorAll('[role="tree"] [role="treeitem"]').length,
        focused: active?.getAttribute("data-tree-id") ?? null,
        posinset: active?.getAttribute("aria-posinset") ?? null,
        level: active?.getAttribute("aria-level") ?? null,
        visible: rect !== undefined && rect.top >= box.top - 0.5 && rect.bottom <= box.bottom - viewport.clientTop + 0.5,
        scrollHeight: viewport.scrollHeight,
      };
    });

  test("renders a bounded window of the expanded tree; End reaches the last service row", async () => {
    const page = await openExpanded(desktop);
    try {
      const before = await treeState(page);
      // Every host is expanded: well over a thousand visible rows, a few dozen in the DOM.
      expect(await page.locator('[data-tree-id="host:rack-00"]').getAttribute("aria-expanded")).toBe("true");
      expect(before.rendered).toBeLessThan(80);
      expect(before.scrollHeight).toBeGreaterThan(HOSTS * SERVICES * 20);
      expect(before.focused).toBe("host:rack-00");
      expect(await page.$(LAST_SERVICE)).toBeNull();

      await page.keyboard.press("End");
      await page.waitForFunction((sel) => document.activeElement?.matches(sel) === true, LAST_SERVICE);
      // Let the re-aim settle once the rows the scroll rendered are measured.
      await page.waitForTimeout(300);
      const end = await treeState(page);
      expect(end.focused).toBe("svc:rack-49/svc-19");
      expect(end.level).toBe("3"); // group → host → service
      expect(end.posinset).toBe(String(SERVICES));
      expect(end.visible).toBe(true);
      expect(end.rendered).toBeLessThan(80);

      // ↑ walks back across rows, Home returns to the top.
      for (let i = 0; i < SERVICES; i += 1) await page.keyboard.press("ArrowUp");
      expect((await treeState(page)).focused).toBe("host:rack-49");
      await page.keyboard.press("Home");
      await page.waitForFunction(() => document.activeElement?.getAttribute("aria-level") === "1");
      expect((await treeState(page)).posinset).toBe("1");
    } finally {
      await page.close();
    }
  }, 90_000);

  test("↓ held across the window keeps the focused row rendered and in view", async () => {
    const page = await openExpanded(desktop);
    try {
      for (let i = 0; i < 60; i += 1) await page.keyboard.press("ArrowDown");
      const state = await treeState(page);
      // Row 60 below rack-00 in its group: rack-02's svc-17 (each host is 21 rows).
      expect(state.focused).toBe("svc:rack-02/svc-17");
      expect(state.visible).toBe(true);
      expect(state.rendered).toBeLessThan(80);
    } finally {
      await page.close();
    }
  }, 90_000);

  test("axe: zero wcag2a/wcag2aa violations on the virtualized tree", async () => {
    const { AxeBuilder } = await import("@axe-core/playwright");
    const page = await openExpanded(desktop);
    try {
      const results = await new AxeBuilder({ page })
        .include('[data-region="estate-tree"]')
        .options({ resultTypes: ["violations"] })
        .withTags(["wcag2a", "wcag2aa"])
        .analyze();
      const summary = results.violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target) }));
      expect(results.violations, JSON.stringify(summary, null, 2)).toEqual([]);
    } finally {
      await page.close();
    }
  }, 90_000);

  test("375px: host and service rows stack the meta under the label, with no horizontal scroll", async () => {
    const page = await openExpanded(mobile);
    try {
      const layout = await page.evaluate(() => {
        const rows = Array.from(
          document.querySelectorAll<HTMLElement>('[data-testid="estate-host-row"], [data-testid="estate-service-row"]'),
        ).slice(0, 10);
        return {
          rows: rows.map((meta) => {
            const label = meta.closest("[data-tree-row]")!.querySelector<HTMLElement>(':scope > span[id]:not([id$="-meta"])')!;
            return { labelBottom: label.getBoundingClientRect().bottom, metaTop: meta.getBoundingClientRect().top };
          }),
          overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        };
      });
      expect(layout.rows.length).toBeGreaterThan(0);
      for (const row of layout.rows) expect(row.metaTop).toBeGreaterThanOrEqual(row.labelBottom - 0.5);
      expect(layout.overflow).toBe(false);
    } finally {
      await page.close();
    }
  }, 90_000);
});
