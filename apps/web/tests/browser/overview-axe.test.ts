// apps/web/tests/browser/overview-axe.test.ts — 08-testing-strategy.md §5.2 (and §5.6 readiness).
//
// Runs @axe-core/playwright over the REAL overview composition (overview-fixture.tsx, `status` mode:
// 4 hosts, all five statuses across targets, 1280×900) in BOTH themes and asserts ZERO wcag2a /
// wcag2aa violations in two states: the default grid and the open target drawer (liveness history
// rendered). It then proves the keyboard contract in a real engine: Tab from the top of the page enters
// the grid, there is exactly ONE roving tab stop, ArrowRight/ArrowDown move focus and the tab stop with
// it, Enter opens the drawer naming the focused target, and Escape closes it returning focus to that
// same trigger.
//
// SELF-SKIPS when Chromium is not provisioned (_harness.browserDescribe); THROWS at collection under
// PULSE_REQUIRE_BROWSER=1 so CI never green-skips it.

import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Browser, Page } from "playwright-core";

import { browserDescribe, type FixturePage, type FixtureTheme } from "./_harness.js";
import {
  buildOverviewFixtures,
  launchOverviewBrowser,
  openOverviewPage,
  OVERVIEW_TARGETS,
  OVERVIEW_THEMES,
  stopOverviewFixtures,
  type OverviewPageHandle,
} from "./overview-browser.js";

const VIEWPORT = { width: 1280, height: 900 } as const;
const DRAWER_HOST_TRIGGER = '[data-target-id="host:host-002"][data-overview-target][data-target-kind="host"]';
const DIALOG = '[role=dialog][aria-modal="true"]';
const LIVENESS_READY = '[data-section="liveness"] [data-history-state="ready"]';
const MAX_TAB_PRESSES = 40;

async function expectNoAxeViolations(page: Page): Promise<void> {
  const { AxeBuilder } = await import("@axe-core/playwright");
  // Keep axe's protocol traffic small. Under bun, the Playwright pipe to Chromium can wedge after a few
  // ~600 KB axe result messages (every later command, even newPage(), never gets a reply and each test
  // times out). resultTypes=["violations"] keeps full node detail only for violations. Legacy mode runs
  // axe inside `page` rather than opening an extra blank page to finish the run; the fixture has no
  // cross-origin frames, so it loses nothing. options() REPLACES the run options, so it must come
  // before withTags() or the wcag2a/wcag2aa runOnly filter is dropped.
  const results = await new AxeBuilder({ page })
    .options({ resultTypes: ["violations"] })
    .withTags(["wcag2a", "wcag2aa"])
    .setLegacyMode(true)
    .analyze();
  const summary = results.violations.map((v) => ({
    id: v.id,
    nodes: v.nodes.map((n) => ({ target: n.target, html: n.html, summary: n.failureSummary })),
  }));
  expect(results.violations, JSON.stringify(summary, null, 2)).toEqual([]);
}

/** Roving state: count of tabindex=0 targets, the tab stop's id, and the focused target's id. */
function rovingState(page: Page): Promise<{ zeroCount: number; total: number; tabStopId: string | null; focusedId: string | null }> {
  return page.evaluate((selector) => {
    const targets = Array.from(document.querySelectorAll<HTMLElement>(selector));
    const zero = targets.filter((el) => el.getAttribute("tabindex") === "0");
    const active = document.activeElement;
    return {
      zeroCount: zero.length,
      total: targets.length,
      tabStopId: zero[0]?.getAttribute("data-target-id") ?? null,
      focusedId: active instanceof HTMLElement && active.matches(selector) ? active.getAttribute("data-target-id") : null,
    };
  }, OVERVIEW_TARGETS);
}

browserDescribe()("browser: overview axe zero wcag2a/wcag2aa violations + keyboard traversal, both themes (08 §5.2)", () => {
  let browser: Browser;
  let fixtures: Map<FixtureTheme, FixturePage> | undefined;
  const handles: OverviewPageHandle[] = [];

  async function open(theme: FixtureTheme): Promise<OverviewPageHandle> {
    const handle = await openOverviewPage(browser, fixtures!, { theme, mode: "status", viewport: VIEWPORT });
    handles.push(handle);
    return handle;
  }

  beforeAll(async () => {
    // Build BEFORE launching Chromium (see _harness.buildFixturePage).
    fixtures = await buildOverviewFixtures();
    browser = await launchOverviewBrowser();
  }, 180_000);

  afterAll(async () => {
    for (const handle of handles) await handle.close();
    stopOverviewFixtures(fixtures);
  }, 60_000);

  for (const theme of OVERVIEW_THEMES) {
    test(`default state: zero wcag2a/wcag2aa violations in ${theme} theme`, async () => {
      const handle = await open(theme);
      try {
        await expectNoAxeViolations(handle.page);
      } finally {
        await handle.close();
      }
    }, 60_000);

    test(`open-drawer state: zero wcag2a/wcag2aa violations in ${theme} theme`, async () => {
      const handle = await open(theme);
      try {
        const { page } = handle;
        await page.click(DRAWER_HOST_TRIGGER);
        await page.waitForSelector(DIALOG);
        await page.waitForSelector(`${DIALOG} ${LIVENESS_READY}`);
        await expectNoAxeViolations(page);
      } finally {
        await handle.close();
      }
    }, 60_000);

    test(`keyboard-only traversal, one roving tab stop, Enter opens and Escape restores focus in ${theme} theme`, async () => {
      const handle = await open(theme);
      try {
        const { page } = handle;

        // Tab from the top of the page until focus lands on a roving target.
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        let entered = false;
        for (let i = 0; i < MAX_TAB_PRESSES && !entered; i += 1) {
          await page.keyboard.press("Tab");
          entered = await page.evaluate((s) => document.activeElement?.matches(s) === true, OVERVIEW_TARGETS);
        }
        expect(entered, `focus never entered the grid within ${MAX_TAB_PRESSES} Tab presses`).toBe(true);

        const initial = await rovingState(page);
        expect(initial.total).toBeGreaterThan(1);
        expect(initial.zeroCount).toBe(1);
        expect(initial.focusedId).not.toBeNull();
        expect(initial.tabStopId).toBe(initial.focusedId);

        // Arrow keys move focus to a different target and carry the single tab stop with it.
        let previous = initial.focusedId;
        for (const key of ["ArrowRight", "ArrowDown"] as const) {
          await page.keyboard.press(key);
          const moved = await rovingState(page);
          expect(moved.focusedId, `${key} did not keep focus on a roving target`).not.toBeNull();
          expect(moved.focusedId, `${key} did not move focus`).not.toBe(previous);
          expect(moved.zeroCount).toBe(1);
          expect(moved.tabStopId).toBe(moved.focusedId);
          previous = moved.focusedId;
        }

        // Enter opens the drawer for the focused target; its title names that target.
        const focusedId = previous!;
        const targetName = await page.evaluate(() => {
          const el = document.activeElement;
          return el?.querySelector('[data-slot="overview-host-name"], [data-slot="overview-chip-name"]')?.textContent?.trim() ?? "";
        });
        expect(targetName).not.toBe("");
        await page.keyboard.press("Enter");
        await page.waitForSelector(DIALOG);
        const dialogName = await page.evaluate((dialogSelector) => {
          const dialog = document.querySelector(dialogSelector);
          const labelId = dialog?.getAttribute("aria-labelledby");
          const label = labelId ? document.getElementById(labelId)?.textContent : dialog?.getAttribute("aria-label");
          return label?.trim() ?? "";
        }, DIALOG);
        expect(dialogName).toContain(targetName);

        // Escape closes the dialog and focus returns to the invoking trigger.
        await page.keyboard.press("Escape");
        await page.waitForSelector(DIALOG, { state: "detached" });
        const returned = await page.evaluate(() => document.activeElement?.getAttribute("data-target-id") ?? null);
        expect(returned).toBe(focusedId);
      } finally {
        await handle.close();
      }
    }, 60_000);
  }
});
