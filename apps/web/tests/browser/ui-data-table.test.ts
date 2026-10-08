// apps/web/tests/browser/ui-data-table.test.ts — the `@/ui` DataTable virtualized over 5,000 rows in
// a real Chromium: only a window of rows is in the DOM, axe finds no wcag2a/wcag2aa violation in
// either theme, and Tab / arrow keys move focus across the rendered window's boundary, scrolling the
// focused row into view below the sticky header. Every 4th row is taller (a second line): rows are
// measured, so the spacers follow real heights and `scrollToIndex` lands on the row.
//
// SELF-SKIPS when Chromium is not provisioned (_harness.browserDescribe); THROWS at collection under
// PULSE_REQUIRE_BROWSER=1.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { BrowserContext, Page } from "playwright-core";

import { browserDescribe, buildFixturePage, type FixturePage, type FixtureTheme, sharedBrowser } from "./_harness.js";

const ENTRY = resolve(import.meta.dir, "fixtures", "ui-data-table.tsx");
const THEMES: readonly FixtureTheme[] = ["dark", "light"];
const ROW_COUNT = 5000;

/** Where focus is, and whether its row sits fully inside the viewport below the sticky header. */
async function focusState(page: Page): Promise<{ link: string | null; visible: boolean; scrollTop: number; rendered: number }> {
  return page.evaluate(() => {
    const viewport = document.querySelector<HTMLElement>('[data-slot="data-table-viewport"]')!;
    const active = document.activeElement;
    const row = active?.closest("tr") ?? null;
    // The header cells are sticky (the thead element itself scrolls away).
    const head = viewport.querySelector("thead th")!.getBoundingClientRect();
    const box = viewport.getBoundingClientRect();
    const rect = row?.getBoundingClientRect();
    return {
      link: active?.getAttribute("data-row-link") ?? null,
      visible: rect !== undefined && rect.top >= head.bottom - 1 && rect.bottom <= box.bottom + 1,
      scrollTop: viewport.scrollTop,
      rendered: viewport.querySelectorAll("tbody tr[aria-rowindex]").length,
    };
  });
}

browserDescribe()("browser: @/ui DataTable virtualized (5,000 rows)", () => {
  let context: BrowserContext;
  const pages = new Map<FixtureTheme, Page>();
  const fixtures: FixturePage[] = [];

  beforeAll(async () => {
    // Build BEFORE launching Chromium (see _harness.buildFixturePage).
    const built = await Promise.all(THEMES.map((theme) => buildFixturePage(ENTRY, { theme })));
    const browser = await sharedBrowser();
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    context.setDefaultTimeout(30_000);
    for (let i = 0; i < THEMES.length; i += 1) {
      fixtures.push(built[i]!);
      const page = await context.newPage();
      await page.goto(built[i]!.url, { waitUntil: "load" });
      await page.waitForSelector("html[data-fixture-ready]");
      await page.waitForSelector("[data-row-link]");
      pages.set(THEMES[i]!, page);
    }
  }, 180_000);

  afterAll(async () => {
    await context?.close();
    for (const f of fixtures) f.stop();
  }, 60_000);

  const page = (): Page => pages.get("dark")!;

  /** Scroll back to the top and focus the first row link. */
  async function focusFirst(p: Page): Promise<void> {
    await p.evaluate(() => {
      document.querySelector<HTMLElement>('[data-slot="data-table-viewport"]')!.scrollTop = 0;
    });
    await p.waitForSelector('[data-row-link="host-0"]');
    await p.focus('[data-row-link="host-0"]');
  }

  test("renders a window of the 5,000 rows with aria-rowcount and aria-rowindex", async () => {
    const info = await page().evaluate(() => {
      const table = document.querySelector("table")!;
      const rows = Array.from(table.querySelectorAll("tbody tr[aria-rowindex]"));
      return {
        rowcount: table.getAttribute("aria-rowcount"),
        rendered: rows.length,
        first: rows[0]?.getAttribute("aria-rowindex"),
        scrollHeight: document.querySelector<HTMLElement>('[data-slot="data-table-viewport"]')!.scrollHeight,
      };
    });
    expect(info.rowcount).toBe(String(ROW_COUNT + 1));
    expect(info.first).toBe("2");
    expect(info.rendered).toBeGreaterThan(5);
    expect(info.rendered).toBeLessThan(60);
    // The spacers give the scrollbar the height of every row.
    expect(info.scrollHeight).toBeGreaterThan(ROW_COUNT * 30);
  }, 60_000);

  test("measures taller rows: each rendered row starts where the real rows above it end", async () => {
    const p = page();
    const result = await p.evaluate(async () => {
      const viewport = document.querySelector<HTMLElement>('[data-slot="data-table-viewport"]')!;
      const frame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const heights = new Map<string, number>();
      // Walk the first 400 rows in steps shorter than the viewport, recording each row's height.
      for (let top = 0; top < 400 * 40; top += viewport.clientHeight / 2) {
        viewport.scrollTop = top;
        await frame();
        for (const row of viewport.querySelectorAll<HTMLElement>("tbody tr[aria-rowindex]")) {
          heights.set(row.dataset["rowId"]!, row.getBoundingClientRect().height);
        }
      }
      // Each rendered row starts where the rows above it end: the spacer above the window equals
      // the real height of the rows it replaces.
      const rows = Array.from(viewport.querySelectorAll<HTMLElement>("tbody tr[aria-rowindex]"));
      const first = rows[0]!;
      const firstIndex = Number(first.getAttribute("aria-rowindex")) - 2;
      let above = 0;
      for (let i = 0; i < firstIndex; i += 1) above += heights.get(`host-${i}`) ?? Number.NaN;
      const bodyTop = viewport.querySelector("tbody")!.getBoundingClientRect().top;
      return {
        tall: [...heights.values()].filter((h) => h > 40).length,
        expected: above,
        actual: first.getBoundingClientRect().top - bodyTop,
      };
    });
    expect(result.tall).toBeGreaterThan(50);
    expect(Math.abs(result.actual - result.expected)).toBeLessThanOrEqual(1);
  }, 60_000);

  for (const align of ["start", "end"] as const) {
    test(`scrollToIndex(align: "${align}") lands on a far row past taller rows`, async () => {
      const p = page();
      await p.evaluate(() => {
        document.querySelector<HTMLElement>('[data-slot="data-table-viewport"]')!.scrollTop = 0;
      });
      await p.waitForSelector('[data-row-link="host-0"]');
      await p.evaluate((a) => {
        (window as unknown as { __dataTable: { scrollToIndex: (i: number, o: { align: string }) => void } }).__dataTable.scrollToIndex(
          3001,
          { align: a },
        );
      }, align);
      await p.waitForSelector('[data-row-link="host-3001"]');
      // Let the rows the scroll rendered be measured and the table re-aim.
      await p.evaluate(() => new Promise((resolve) => setTimeout(resolve, 300)));
      const edges = await p.evaluate(() => {
        const viewport = document.querySelector<HTMLElement>('[data-slot="data-table-viewport"]')!;
        const row = document.querySelector('[data-row-link="host-3001"]')!.closest("tr")!.getBoundingClientRect();
        return {
          // The header cells are sticky (the thead element itself scrolls away).
          top: row.top - viewport.querySelector("thead th")!.getBoundingClientRect().bottom,
          bottom: viewport.getBoundingClientRect().bottom - viewport.clientTop - row.bottom,
        };
      });
      // Before rows were measured this was ~67px off for "end". The end edge keeps ~2px of slack:
      // the virtualizer sizes the viewport by its border box (offsetHeight), 1px border each side.
      if (align === "start") expect(Math.abs(edges.top)).toBeLessThanOrEqual(1);
      else expect(Math.abs(edges.bottom)).toBeLessThanOrEqual(3);
    }, 60_000);
  }

  for (const theme of THEMES) {
    test(`zero wcag2a/wcag2aa violations in ${theme} theme`, async () => {
      const { AxeBuilder } = await import("@axe-core/playwright");
      const results = await new AxeBuilder({ page: pages.get(theme)! })
        .options({ resultTypes: ["violations"] })
        .withTags(["wcag2a", "wcag2aa"])
        .analyze();
      const summary = results.violations.map((v) => ({
        id: v.id,
        nodes: v.nodes.map((n) => ({ target: n.target, summary: n.failureSummary })),
      }));
      expect(results.violations, JSON.stringify(summary, null, 2)).toEqual([]);
    }, 60_000);
  }

  test("Tab moves across the window boundary and keeps the focused row in view", async () => {
    const p = page();
    await focusFirst(p);
    const { rendered } = await focusState(p);
    const steps = rendered + 20;
    for (let i = 1; i <= steps; i += 1) await p.keyboard.press("Tab");

    const state = await focusState(p);
    expect(state.link).toBe(`host-${steps}`);
    expect(state.visible).toBe(true);
    expect(state.scrollTop).toBeGreaterThan(0);
    expect(state.rendered).toBeLessThan(60);
    expect(await p.$('[data-row-link="host-0"]')).toBeNull();

    // Shift+Tab walks back.
    for (let i = 0; i < 5; i += 1) await p.keyboard.press("Shift+Tab");
    expect((await focusState(p)).link).toBe(`host-${steps - 5}`);
  }, 120_000);

  test("ArrowDown / ArrowUp move across the window boundary and keep the focused row in view", async () => {
    const p = page();
    await focusFirst(p);
    const { rendered } = await focusState(p);
    const steps = rendered + 20;
    for (let i = 0; i < steps; i += 1) await p.keyboard.press("ArrowDown");

    let state = await focusState(p);
    expect(state.link).toBe(`host-${steps}`);
    expect(state.visible).toBe(true);
    expect(state.rendered).toBeLessThan(60);

    for (let i = 0; i < steps - 2; i += 1) await p.keyboard.press("ArrowUp");
    state = await focusState(p);
    expect(state.link).toBe("host-2");
    expect(state.visible).toBe(true);
  }, 120_000);

  test("arrow keys pressed faster than frames still move across the window boundary", async () => {
    const p = page();
    await focusFirst(p);
    const { rendered } = await focusState(p);
    const steps = rendered + 20;
    // Every keydown in one task: no frame (and no scroll event) runs between them.
    await p.evaluate((count) => {
      for (let i = 0; i < count; i += 1) {
        document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
      }
    }, steps);
    expect((await focusState(p)).link).toBe(`host-${steps}`);
    await p.waitForFunction(() => {
      const row = document.activeElement?.closest("tr")?.getBoundingClientRect();
      const box = document.querySelector('[data-slot="data-table-viewport"]')!.getBoundingClientRect();
      return row !== undefined && row.bottom <= box.bottom + 1;
    });
    expect((await focusState(p)).visible).toBe(true);
  }, 120_000);
});
