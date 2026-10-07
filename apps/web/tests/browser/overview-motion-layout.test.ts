// apps/web/tests/browser/overview-motion-layout.test.ts — 08-testing-strategy.md §5.5 (and §5.6
// readiness), 06-kiosk-paging-and-density.md §10.2, 03-grid-navigation-and-motion.md §6.
//
// Proves, against the REAL overview composition (overview-fixture.tsx) in a real engine:
//   Motion — a true status transition (cycle 2 turns svc:host-003/cache `warning`) marks exactly that
//     chip; under `prefers-reduced-motion: no-preference` the marker animates (computed
//     animation-name is not `none`), under `reduce` it is the static marker with animation-name
//     `none`. A pure group-by reorder marks nothing. The single-target commit re-renders a bounded
//     number of host cells / service chips, never the whole grid (fixture render counters).
//   Layout — the 4-host fixture scales its host cells up under wallboard density at the same
//     viewport; the 100-host/300-service envelope keeps grouped, headed cards with no table; kiosk
//     paging under a 4 s rotation dwell shows every host exactly once across one page cycle, repeats a
//     split group's heading, starts every page before the dwell elapses, and starts at page 1.
// Computed styles, layout boxes and real timers are engine properties happy-dom cannot provide.
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
  OVERVIEW_MARKED,
  OVERVIEW_SERVICE_CHIPS,
  stopOverviewFixtures,
  type OpenOverviewOptions,
  type OverviewPageHandle,
} from "./overview-browser.js";

const THEME: FixtureTheme = "dark";
/** The one target cycle 2 changes (overview-fixture CHANGED_TARGET_ID / CHANGED_TARGET_STATUS). */
const CHANGED_TARGET_ID = "svc:host-003/cache";
const CHANGED_TARGET_STATUS = "warning";
const MARKER_WAIT_MS = 5_000;
const GROUP_BY = "[data-control=group-by] [role=radio]";
const MODE_LABEL = { status: "Status", name: "Name" } as const;

const KIOSK_DWELL_MS = 4_000;
const KIOSK_POLL_MS = 25;
const KIOSK_DEADLINE_MS = KIOSK_DWELL_MS + 3_000;
const KIOSK_PAGE = '[data-slot="overview-kiosk-page"]:not([aria-hidden="true"])';

interface MarkedState {
  readonly count: number;
  readonly id: string | null;
  readonly status: string | null;
  /** The marker kind from `data-changed` ("animated" | "static"), or null. */
  readonly changed: string | null;
  readonly animationName: string | null;
}

/** Snapshot of every marked target (the first one's id/status/marker kind/computed animation-name). */
function markedState(page: Page): Promise<MarkedState> {
  return page.evaluate((selector) => {
    const marked = Array.from(document.querySelectorAll(selector));
    const first = marked[0];
    return {
      count: marked.length,
      id: first?.getAttribute("data-target-id") ?? null,
      status: first?.getAttribute("data-status") ?? null,
      changed: first?.getAttribute("data-changed") ?? null,
      animationName: first === undefined ? null : getComputedStyle(first).animationName,
    };
  }, OVERVIEW_MARKED);
}

/** Commit cycle `n` and wait (bounded) until exactly one target carries a change marker. */
async function commitAndAwaitMarker(page: Page, cycle: number): Promise<MarkedState> {
  await page.evaluate((n) => window.__PULSE_COMMIT_OVERVIEW_CYCLE__!(n), cycle);
  try {
    const handle = await page.waitForFunction(
      (selector) => {
        const marked = Array.from(document.querySelectorAll(selector));
        if (marked.length === 0) return null;
        const first = marked[0]!;
        return {
          count: marked.length,
          id: first.getAttribute("data-target-id"),
          status: first.getAttribute("data-status"),
          changed: first.getAttribute("data-changed"),
          animationName: getComputedStyle(first).animationName,
        };
      },
      OVERVIEW_MARKED,
      { timeout: MARKER_WAIT_MS },
    );
    return (await handle.jsonValue()) as MarkedState;
  } catch (error) {
    const state = await markedState(page);
    const metrics = await page.evaluate(() => window.__PULSE_OVERVIEW_METRICS__ ?? null);
    throw new Error(`no change marker within ${MARKER_WAIT_MS}ms after cycle ${cycle}: ${JSON.stringify({ state, metrics })}\n${String(error)}`);
  }
}

/** Wait two animation frames plus a short settle so a late (wrong) marker would be observable. */
async function settleFrames(page: Page): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 100)))),
  );
}

interface CellBox {
  readonly id: string | null;
  readonly width: number;
  readonly height: number;
}

function hostBoxes(page: Page): Promise<{ density: string | null; boxes: CellBox[] }> {
  return page.evaluate(() => ({
    density: document.documentElement.dataset["density"] ?? null,
    boxes: Array.from(document.querySelectorAll('[data-slot="overview-page"] [data-slot="overview-host"]')).map((el) => {
      const r = el.getBoundingClientRect();
      return { id: el.getAttribute("data-target-id"), width: r.width, height: r.height };
    }),
  }));
}

interface KioskObservation {
  readonly index: number | null;
  readonly total: number | null;
  readonly label: string | null;
  readonly text: string;
  readonly hosts: string[];
  readonly headings: string[];
}

/** The visible kiosk page only (the aria-hidden measurement probe is never counted). */
function observeKioskPage(page: Page): Promise<KioskObservation> {
  return page.evaluate((pageSelector) => {
    const current = document.querySelector(pageSelector);
    const indicator = current?.querySelector('[data-slot="overview-kiosk-indicator"][role=note]') ?? null;
    const text = indicator?.textContent?.trim() ?? "";
    const match = /^(\d+)\s*\/\s*(\d+)$/.exec(text);
    return {
      index: match ? Number(match[1]) : null,
      total: match ? Number(match[2]) : null,
      label: indicator?.getAttribute("aria-label") ?? null,
      text,
      hosts: Array.from(current?.querySelectorAll('[data-slot="overview-host"][data-target-id]') ?? []).map(
        (el) => el.getAttribute("data-target-id") ?? "",
      ),
      headings: Array.from(current?.querySelectorAll('[role="rowgroup"] [role="columnheader"] h2') ?? []).map(
        (el) => el.textContent?.trim() ?? "",
      ),
    };
  }, KIOSK_PAGE);
}

browserDescribe()("browser: overview motion markers and grid/envelope/kiosk layout (08 §5.5, 06 §10.2)", () => {
  let browser: Browser;
  let fixtures: Map<FixtureTheme, FixturePage> | undefined;
  const handles: OverviewPageHandle[] = [];

  async function open(options: Omit<OpenOverviewOptions, "theme"> & { readonly theme?: FixtureTheme }): Promise<OverviewPageHandle> {
    const handle = await openOverviewPage(browser, fixtures!, { ...options, theme: options.theme ?? THEME });
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

  // ── Motion ────────────────────────────────────────────────────────────────────────────────────

  test("normal motion: a true transition animates exactly the changed chip", async () => {
    const handle = await open({ mode: "motion", reducedMotion: "no-preference" });
    try {
      const { page } = handle;
      expect((await markedState(page)).count, "a marker exists before any transition").toBe(0);
      const marked = await commitAndAwaitMarker(page, 2);
      const detail = JSON.stringify(marked);
      expect(marked.count, detail).toBe(1);
      expect(marked.id, detail).toBe(CHANGED_TARGET_ID);
      expect(marked.status, detail).toBe(CHANGED_TARGET_STATUS);
      expect(marked.changed, detail).toBe("animated");
      expect(marked.animationName, detail).not.toBe("none");
      // `animate-in` (tw-animate-css) runs the `enter` keyframes.
      expect(marked.animationName, detail).toBe("enter");
    } finally {
      await handle.close();
    }
  }, 60_000);

  test("reduced motion: the changed chip carries the static marker with animation-name none", async () => {
    const handle = await open({ mode: "motion", reducedMotion: "reduce" });
    try {
      const { page } = handle;
      const marked = await commitAndAwaitMarker(page, 2);
      const detail = JSON.stringify(marked);
      expect(marked.count, detail).toBe(1);
      expect(marked.id, detail).toBe(CHANGED_TARGET_ID);
      expect(marked.status, detail).toBe(CHANGED_TARGET_STATUS);
      expect(marked.changed, detail).toBe("static");
      expect(marked.animationName, detail).toBe("none");
    } finally {
      await handle.close();
    }
  }, 60_000);

  test("a pure group-by reorder marks no target", async () => {
    const handle = await open({ mode: "motion" });
    try {
      const { page } = handle;
      for (const value of ["status", "name"] as const) {
        const before = await page.evaluate(
          (sel) => Array.from(document.querySelectorAll('[data-slot="overview-page"] [role="rowgroup"][data-group-id]')).map((g) => g.getAttribute("data-group-id")).join("|") + `#${document.querySelector(`${sel}[aria-checked=true]`)?.textContent ?? "?"}`,
          GROUP_BY,
        );
        const radio = page.locator(GROUP_BY, { hasText: MODE_LABEL[value] });
        await radio.click();
        await page.waitForFunction(
          ({ sel, label }) => document.querySelector(`${sel}[aria-checked=true]`)?.textContent === label,
          { sel: GROUP_BY, label: MODE_LABEL[value] },
        );
        await settleFrames(page);
        const marked = await markedState(page);
        expect(marked.count, `group-by=${value} (was ${before}) marked: ${JSON.stringify(marked)}`).toBe(0);
      }
    } finally {
      await handle.close();
    }
  }, 60_000);

  test("single-target cycle commit re-renders a bounded set of cells, not the whole grid", async () => {
    const handle = await open({ mode: "motion" });
    try {
      const { page } = handle;
      const before = await page.evaluate(() => ({ ...window.__PULSE_OVERVIEW_METRICS__! }));
      await commitAndAwaitMarker(page, 2);
      await page.waitForFunction(() => window.__PULSE_OVERVIEW_METRICS__?.changedTargetPaintedAt != null, null, {
        timeout: MARKER_WAIT_MS,
      });
      await settleFrames(page);
      const after = await page.evaluate(() => ({ ...window.__PULSE_OVERVIEW_METRICS__! }));
      const hostDelta = after.hostRenders - before.hostRenders;
      const serviceDelta = after.serviceRenders - before.serviceRenders;
      const detail = `hostRenders ${before.hostRenders}→${after.hostRenders} (+${hostDelta}), serviceRenders ${before.serviceRenders}→${after.serviceRenders} (+${serviceDelta}), grid ${after.hostCount} hosts / ${after.serviceCount} services`;
      console.log(`[overview-motion-layout] render isolation: ${detail}`);
      // The owning host cell and the changed chip may re-render (marker set + marker state commit);
      // the other hosts and chips must not.
      expect(hostDelta, detail).toBeGreaterThanOrEqual(1);
      expect(hostDelta, detail).toBeLessThanOrEqual(2);
      expect(serviceDelta, detail).toBeGreaterThanOrEqual(1);
      expect(serviceDelta, detail).toBeLessThanOrEqual(2);
      expect(hostDelta, detail).toBeLessThan(after.hostCount);
      expect(serviceDelta, detail).toBeLessThan(after.serviceCount);
    } finally {
      await handle.close();
    }
  }, 60_000);

  // ── Layout ────────────────────────────────────────────────────────────────────────────────────

  test("4-host fixture: wallboard density scales host cells up at the same viewport", async () => {
    // Every group of the 4-host fixture holds exactly one host under every group-by mode, so each host
    // cell spans its group's full row in BOTH densities (auto-fit collapses the empty tracks): the
    // upscaling shows as a larger cell (area) carrying larger type, not as fewer columns.
    const viewport = { width: 1000, height: 800 } as const;
    const desk = await open({ mode: "status", density: "desk", viewport });
    const wall = await open({ mode: "status", density: "wallboard", viewport });
    try {
      const d = await hostBoxes(desk.page);
      const w = await hostBoxes(wall.page);
      const detail = JSON.stringify({ desk: d, wallboard: w });
      console.log(`[overview-motion-layout] 4-host cells @1000×800: ${detail}`);
      expect(d.density, detail).toBe("desk");
      expect(w.density, detail).toBe("wallboard");
      expect(d.boxes.length, detail).toBe(4);
      expect(w.boxes.length, detail).toBe(4);
      const byId = new Map(d.boxes.map((b) => [b.id, b]));
      for (const box of w.boxes) {
        const deskBox = byId.get(box.id);
        expect(deskBox, `${box.id} missing from desk: ${detail}`).toBeDefined();
        // Same host, same viewport: the wallboard cell is larger in area and never shorter.
        expect(box.width * box.height, `${box.id}: ${detail}`).toBeGreaterThan(deskBox!.width * deskBox!.height);
        expect(box.height, `${box.id}: ${detail}`).toBeGreaterThan(deskBox!.height);
        // It still fills the row (no narrowing beyond the wallboard's larger padding/gaps).
        expect(box.width, `${box.id}: ${detail}`).toBeGreaterThanOrEqual(288);
      }
      const nameFont = (page: Page): Promise<number> =>
        page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('[data-slot="overview-page"] [data-slot="overview-host-name"]')!).fontSize));
      const deskFont = await nameFont(desk.page);
      const wallFont = await nameFont(wall.page);
      console.log(`[overview-motion-layout] host name font-size desk=${deskFont}px wallboard=${wallFont}px`);
      expect(wallFont, `host name font-size desk=${deskFont}px wallboard=${wallFont}px`).toBeGreaterThan(deskFont);
    } finally {
      await desk.close();
      await wall.close();
    }
  }, 60_000);

  test("envelope: 100 host cards and 300 service chips in headed groups, no table", async () => {
    const handle = await open({ mode: "envelope", viewport: { width: 1280, height: 900 } });
    try {
      const result = await handle.page.evaluate((chipSelector) => {
        const hosts = Array.from(document.querySelectorAll('[data-slot="overview-page"] [data-slot="overview-host"]'));
        const chips = document.querySelectorAll(`[data-slot="overview-page"] ${chipSelector}`).length;
        const orphanHosts = hosts
          .filter((host) => {
            const group = host.closest('[role="rowgroup"][data-group-id]');
            return group === null || group.querySelector("h2") === null;
          })
          .map((host) => host.getAttribute("data-target-id"));
        const groups = Array.from(document.querySelectorAll('[data-slot="overview-page"] [role="rowgroup"][data-group-id]'));
        return {
          hosts: hosts.length,
          chips,
          groups: groups.length,
          headings: groups.map((g) => g.querySelector("h2")?.textContent?.trim() ?? null),
          orphanHosts,
          tables: document.querySelectorAll("table").length,
          roleTables: document.querySelectorAll('[role="table"]').length,
        };
      }, OVERVIEW_SERVICE_CHIPS);
      const detail = JSON.stringify(result);
      expect(result.hosts, detail).toBe(100);
      expect(result.chips, detail).toBe(300);
      expect(result.groups, detail).toBeGreaterThan(0);
      expect(result.headings.every((h) => h !== null && h !== ""), detail).toBe(true);
      expect(result.orphanHosts, detail).toEqual([]);
      expect(result.tables, detail).toBe(0);
      expect(result.roleTables, detail).toBe(0);
    } finally {
      await handle.close();
    }
  }, 60_000);

  test("kiosk paging: every host once per cycle, split headings repeat, all pages start within the dwell", async () => {
    const handle = await open({
      mode: "kiosk",
      dwell: KIOSK_DWELL_MS,
      viewport: { width: 1920, height: 1080 },
      reducedMotion: "reduce",
    });
    try {
      const { page } = handle;
      const first = await observeKioskPage(page);
      const total = first.total;
      expect(total, `kiosk indicator unreadable: ${JSON.stringify(first)}`).not.toBeNull();
      expect(total!, `kiosk does not page (P=${total}): ${JSON.stringify(first)}`).toBeGreaterThan(1);
      expect(first.label, JSON.stringify(first)).toBe(`Page ${first.index} of ${total}`);

      const seen = new Map<number, { hosts: string[]; headings: string[]; atMs: number }>();
      const order: number[] = [];
      const log: string[] = [];
      let start: number | null = null;
      let last = first;
      for (;;) {
        const now = performance.now();
        const obs = last;
        if (obs.index !== null && !seen.has(obs.index)) {
          if (start === null) start = now;
          seen.set(obs.index, { hosts: obs.hosts, headings: obs.headings, atMs: now - start });
          order.push(obs.index);
          log.push(`page ${obs.index}/${obs.total} at ${(now - start).toFixed(0)}ms: ${obs.hosts.length} hosts, headings ${JSON.stringify(obs.headings)}`);
        }
        if (obs.total !== total) throw new Error(`page count changed mid-cycle ${total}→${obs.total}:\n${log.join("\n")}`);
        if (seen.size === total) break;
        if (start !== null && now - start > KIOSK_DEADLINE_MS) {
          throw new Error(`kiosk saw ${seen.size}/${total} pages within ${KIOSK_DEADLINE_MS}ms:\n${log.join("\n")}`);
        }
        await page.waitForTimeout(KIOSK_POLL_MS);
        last = await observeKioskPage(page);
      }
      const detail = log.join("\n");
      console.log(`[overview-motion-layout] kiosk P=${total} dwell=${KIOSK_DWELL_MS}ms\n${detail}`);

      // Page 1 was the first page observed, and every page started before the dwell elapsed.
      expect(order[0], detail).toBe(1);
      for (const [index, entry] of seen) {
        expect(entry.atMs, `page ${index} started at ${entry.atMs}ms (dwell ${KIOSK_DWELL_MS}ms)\n${detail}`).toBeLessThan(KIOSK_DWELL_MS);
      }

      // Every one of the 100 hosts appears exactly once across the cycle.
      const all = [...seen.values()].flatMap((entry) => entry.hosts);
      const counts = new Map<string, number>();
      for (const id of all) counts.set(id, (counts.get(id) ?? 0) + 1);
      const repeated = [...counts].filter(([, n]) => n > 1);
      expect(repeated, `hosts on more than one page:\n${detail}`).toEqual([]);
      expect(counts.size, detail).toBe(100);
      expect(all.length, detail).toBe(100);
      for (const entry of seen.values()) expect(entry.hosts.length, detail).toBeGreaterThan(0);

      // A group split across pages repeats its heading on each page it spans.
      const pagesPerHeading = new Map<string, number>();
      for (const entry of seen.values()) {
        for (const heading of new Set(entry.headings)) pagesPerHeading.set(heading, (pagesPerHeading.get(heading) ?? 0) + 1);
      }
      const split = [...pagesPerHeading].filter(([, n]) => n >= 2);
      expect(split.length, `no group heading repeats across pages: ${JSON.stringify([...pagesPerHeading])}\n${detail}`).toBeGreaterThan(0);
    } finally {
      await handle.close();
    }
  }, 60_000);
});
