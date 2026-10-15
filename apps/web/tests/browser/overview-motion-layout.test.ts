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
//     paging (no rotation) shows every host exactly once across one page cycle as read-only tiles in
//     worst-first order, starts at page 1, and holds every page for its full dwell (never under 10 s,
//     the 30 s base cycle split across the pages) — timed on a paused fake clock, so the bounds
//     measure page time, not host load (GitHub #33, #6).
// Computed styles, layout boxes and real timers are engine properties happy-dom cannot provide.
//
// SELF-SKIPS when Chromium is not provisioned (_harness.browserDescribe); THROWS at collection under
// PULSE_REQUIRE_BROWSER=1 so CI never green-skips it.

import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Browser, Page } from "playwright-core";

import { browserDescribe, type FixturePage, type FixtureTheme } from "./_harness.js";
import {
  buildOverviewFixtures,
  drainTasks,
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

/** Shortest kiosk page dwell, and the base cycle split across up to three pages (kiosk/paging.ts). */
const KIOSK_MIN_PAGE_DWELL_MS = 10_000;
const KIOSK_BASE_CYCLE_MS = 30_000;
/** Fake-clock step between kiosk observations; page starts are measured to within one step. */
const KIOSK_STEP_MS = 250;
const KIOSK_PAGE = '[data-slot="overview-kiosk-page"]';
/** Worst-first rank of a tile's `data-status` (OVERVIEW_STATUS_ORDER). */
const STATUS_RANK: Readonly<Record<string, number>> = { critical: 0, warning: 1, unknown: 2, suppressed: 3, ok: 4 };

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
  readonly statuses: string[];
  readonly focusable: number;
}

/** The visible kiosk page: its tiles (id + status), the "i / P" indicator and any focusable node. */
function observeKioskPage(page: Page): Promise<KioskObservation> {
  return page.evaluate((pageSelector) => {
    const current = document.querySelector(pageSelector);
    const indicator = document.querySelector('[data-slot="overview-kiosk-indicator"][role=note]');
    const text = indicator?.textContent?.trim() ?? "";
    const match = /^(\d+)\s*\/\s*(\d+)$/.exec(text);
    const tiles = Array.from(current?.querySelectorAll('[data-slot="overview-kiosk-tile"][data-target-id]') ?? []);
    return {
      index: match ? Number(match[1]) : null,
      total: match ? Number(match[2]) : null,
      label: indicator?.getAttribute("aria-label") ?? null,
      text,
      hosts: tiles.map((el) => el.getAttribute("data-target-id") ?? ""),
      statuses: tiles.map((el) => el.getAttribute("data-status") ?? ""),
      focusable: document.querySelectorAll('[data-slot="overview-kiosk"] :is(button, a[href], input, [tabindex])').length,
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

  test("kiosk paging: every host once per cycle as worst-first read-only tiles, each page held its full dwell", async () => {
    const handle = await open({
      mode: "kiosk",
      viewport: { width: 1920, height: 1080 },
      reducedMotion: "reduce",
      pausedClock: true,
    });
    try {
      const { page } = handle;
      // Page time: the clock is paused, so it advances only through runFor below.
      const pageNow = (): Promise<number> => page.evaluate(() => performance.now());
      // Let layout settle first: the chrome above the wall and the page-root offset can land a frame
      // after the first measurement (the fixture registers no web fonts, so this is not font
      // loading). Page 1 must hold exactly the columns × rows the region now fits, so a late
      // re-measure cannot restart the sequence mid-run.
      // Polled from the test side in real time: the page's own timers are on the paused clock.
      const settled = (): Promise<boolean> =>
        page.evaluate(() => {
          const region = document.querySelector<HTMLElement>('[data-slot="overview-kiosk-region"]');
          const list = document.querySelector<HTMLElement>('[data-slot="overview-kiosk-page"] ul[role="list"]');
          if (region === null || list === null) return false;
          const style = getComputedStyle(list);
          const columns = style.gridTemplateColumns.split(" ").filter((t) => t.endsWith("px")).length;
          const row = Number.parseFloat(style.gridAutoRows);
          const gap = Number.parseFloat(style.rowGap) || 0;
          const rows = Math.max(1, Math.floor((region.getBoundingClientRect().height + gap) / (row + gap)));
          return list.children.length === columns * rows;
        });
      const settleBy = Date.now() + 10_000;
      while (!(await settled())) {
        if (Date.now() > settleBy) throw new Error("kiosk layout never settled to columns × rows tiles");
        await drainTasks(page);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await drainTasks(page);
      const first = await observeKioskPage(page);
      const total = first.total;
      expect(total, `kiosk indicator unreadable: ${JSON.stringify(first)}`).not.toBeNull();
      expect(total!, `kiosk does not page (P=${total}): ${JSON.stringify(first)}`).toBeGreaterThan(1);
      expect(first.label, JSON.stringify(first)).toBe(`Page ${first.index} of ${total}`);
      expect(first.focusable, `kiosk tiles must not take focus: ${JSON.stringify(first)}`).toBe(0);
      const dwell = Math.max(KIOSK_MIN_PAGE_DWELL_MS, Math.floor(KIOSK_BASE_CYCLE_MS / total!));
      const deadline = total! * dwell + 2_000;

      const seen = new Map<number, { hosts: string[]; statuses: string[]; atMs: number }>();
      const order: number[] = [];
      const log: string[] = [];
      let start: number | null = null;
      let last = first;
      for (;;) {
        const now = await pageNow();
        const obs = last;
        if (start === null) start = now;
        if (obs.index !== null && !seen.has(obs.index)) {
          seen.set(obs.index, { hosts: obs.hosts, statuses: obs.statuses, atMs: now - start });
          order.push(obs.index);
          log.push(`page ${obs.index}/${obs.total} at ${(now - start).toFixed(0)}ms: ${obs.hosts.length} tiles`);
        }
        if (obs.total !== total) throw new Error(`page count changed mid-cycle ${total}→${obs.total}:\n${log.join("\n")}`);
        if (seen.size === total) break;
        if (obs.index === null) throw new Error(`kiosk shows no page index: ${JSON.stringify(obs)}`);
        if (now - start > deadline) {
          throw new Error(`kiosk saw ${seen.size}/${total} pages within ${deadline}ms:\n${log.join("\n")}`);
        }
        await page.clock.runFor(KIOSK_STEP_MS);
        await drainTasks(page);
        last = await observeKioskPage(page);
      }
      const detail = log.join("\n");
      console.log(`[overview-motion-layout] kiosk P=${total} page dwell=${dwell}ms\n${detail}`);

      // Page 1 came first and page k appeared after (k-1) whole dwells (within one observation step).
      expect(order, detail).toEqual(Array.from({ length: total! }, (_, i) => i + 1));
      for (const [index, entry] of seen) {
        expect(Math.abs(entry.atMs - (index - 1) * dwell), `page ${index} started at ${entry.atMs}ms (dwell ${dwell}ms)\n${detail}`).toBeLessThanOrEqual(KIOSK_STEP_MS);
      }

      // Every one of the 100 hosts appears exactly once across the cycle, worst status first.
      const all = order.flatMap((index) => seen.get(index)!.hosts);
      const statuses = order.flatMap((index) => seen.get(index)!.statuses);
      expect(new Set(all).size, detail).toBe(100);
      expect(all.length, detail).toBe(100);
      for (let i = 1; i < statuses.length; i++) {
        expect(STATUS_RANK[statuses[i - 1]!]! <= STATUS_RANK[statuses[i]!]!, `tile ${i} breaks worst-first order: ${statuses.join(",")}`).toBe(true);
      }
      expect(statuses[0], detail).toBe("critical");
    } finally {
      await handle.close();
    }
  }, 60_000);
});
