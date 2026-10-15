// apps/web/tests/overview-kiosk.test.ts — kiosk capacity/partition/dwell helpers and the
// useKioskPaging hook (GitHub #6; REQ-DEN-03..04). Timing runs on an injected fake KioskPagingClock
// and frames on a manual queue — no wall-clock waits. The tile wall's DOM is covered in
// overview-kiosk-tiles.test.ts.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createElement, type JSX, type RefObject } from "react";
import { act } from "./react-render.js";

import type { HostStatus } from "@pulse/web-data/wire";
import type { ViewRotationContext } from "../src/shared/registry.js";
import {
  KIOSK_MIN_PAGE_DWELL_MS,
  MIN_KIOSK_CAPACITY,
  NON_ROTATING_KIOSK_CYCLE_MS,
  buildKioskPages,
  kioskCapacity,
  kioskPageDwell,
  kioskPagesPerVisit,
  kioskRows,
  type KioskGridMetrics,
} from "../src/client/views/overview/kiosk/paging.js";
import {
  kioskIndicatorLabel,
  overviewRotationDwell,
  readKioskGridMetrics,
  resetKioskRotationCursor,
  useKioskPaging,
  type KioskPagingClock,
  type KioskPagingState,
} from "../src/client/views/overview/kiosk/useKioskPaging.js";
import { createEstateClock } from "../src/client/format.js";
import type { PathRouter } from "../src/client/router.js";
import { FiringRibbon } from "../src/client/views/overview/ribbon/FiringRibbon.js";
import { FIXTURE_ESTATE, makeOverviewSnapshot, withTargetStatus } from "./fixtures/overview/factory.js";
import { describeDom, renderWithStore } from "./dom.js";

const HOSTS: readonly HostStatus[] = makeOverviewSnapshot({ hostCount: 12 }).hosts;

function ids(pages: readonly { readonly hosts: readonly HostStatus[] }[]): string[] {
  return pages.flatMap((p) => p.hosts.map((host) => host.drilldownId));
}

describe("kiosk constants", () => {
  test("30 s base cycle, 10 s minimum page dwell and a minimum capacity of one", () => {
    expect(NON_ROTATING_KIOSK_CYCLE_MS).toBe(30_000);
    expect(KIOSK_MIN_PAGE_DWELL_MS).toBe(10_000);
    expect(MIN_KIOSK_CAPACITY).toBe(1);
  });
});

describe("buildKioskPages", () => {
  const hosts = HOSTS.slice(0, 9);

  test.each([
    ["zero", 0],
    ["negative", -3],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
  ])("capacity %s clamps to one host per page", (_label, capacity) => {
    const pages = buildKioskPages(hosts, capacity);
    expect(pages).toHaveLength(9);
    expect(pages.every((p) => p.hosts.length === 1)).toBe(true);
  });

  test.each([
    ["one", 1, [1, 1, 1, 1, 1, 1, 1, 1, 1]],
    ["exact fit", 9, [9]],
    ["one over", 8, [8, 1]],
    ["larger than estate", 50, [9]],
    ["fractional", 4.9, [4, 4, 1]],
  ])("capacity %s → page sizes", (_label, capacity, sizes) => {
    const pages = buildKioskPages(hosts, capacity);
    expect(pages.map((p) => p.hosts.length)).toEqual(sizes);
    expect(pages.map((p) => p.index)).toEqual(sizes.map((_, i) => i));
  });

  test("pages hold every host exactly once, in order, by identity; the input is not mutated", () => {
    const before = hosts.map((h) => h.drilldownId);
    for (let capacity = 0; capacity <= 11; capacity++) {
      const out = buildKioskPages(hosts, capacity).flatMap((p) => p.hosts);
      expect(out).toHaveLength(hosts.length);
      out.forEach((host, i) => expect(host).toBe(hosts[i]!));
    }
    expect(hosts.map((h) => h.drilldownId)).toEqual(before);
  });

  test("an empty estate produces no phantom page", () => {
    expect(buildKioskPages([], 4)).toEqual([]);
  });
});

describe("capacity arithmetic", () => {
  const base: KioskGridMetrics = { height: 200, columns: 4, rowHeight: 100, rowGap: 0 };

  test("capacity is columns × rows of the fixed tile height", () => {
    expect(kioskCapacity(base)).toBe(8);
    expect(kioskCapacity({ ...base, columns: 7, height: 1000 })).toBe(70);
  });

  test("rows count gaps and never lose a row at an exact fit", () => {
    expect(kioskRows({ ...base, height: 210, rowGap: 10 })).toBe(2); // 100 + 10 + 100 = 210
    expect(kioskRows({ ...base, height: 209, rowGap: 10 })).toBe(1);
    expect(kioskRows({ ...base, height: 320, rowGap: 10 })).toBe(3);
  });

  test("a region shorter than one tile still shows one row", () => {
    expect(kioskRows({ ...base, height: 40 })).toBe(1);
    expect(kioskCapacity({ ...base, height: 40 })).toBe(4);
  });

  test("invalid or unavailable metrics fall back to one", () => {
    expect(kioskCapacity(null)).toBe(1);
    expect(kioskCapacity({ ...base, columns: 0 })).toBe(1);
    expect(kioskCapacity({ ...base, columns: 2.5 })).toBe(1);
    expect(kioskCapacity({ ...base, height: Number.NaN })).toBe(4);
    expect(kioskCapacity({ ...base, rowHeight: 0 })).toBe(4);
    expect(kioskRows({ ...base, rowGap: -1 })).toBe(2);
  });
});

describe("page dwell", () => {
  test.each([
    // [pages, rotation dwell or null, page dwell]
    [1, null, 30_000],
    [2, null, 15_000],
    [3, null, 10_000],
    [4, null, 10_000],
    [10, null, 10_000],
    [3, 45_000, 15_000],
    [6, 20_000, 10_000],
    [2, 8_000, 10_000],
  ])("P=%d rotation=%p → %d ms per page (never below 10 s)", (pages, rotation, dwell) => {
    expect(kioskPageDwell(pages, rotation)).toBe(dwell);
    expect(kioskPageDwell(pages, rotation)).toBeGreaterThanOrEqual(KIOSK_MIN_PAGE_DWELL_MS);
  });

  test("without rotation the cycle grows with the page count past three pages", () => {
    expect(10 * kioskPageDwell(10, null)).toBe(100_000);
    expect(3 * kioskPageDwell(3, null)).toBe(NON_ROTATING_KIOSK_CYCLE_MS);
  });

  test("a rotation visit shows the whole pages its dwell fits (at least one, at most all)", () => {
    expect(kioskPagesPerVisit(3, 45_000)).toBe(3);
    expect(kioskPagesPerVisit(6, 20_000)).toBe(2);
    expect(kioskPagesPerVisit(6, 25_000)).toBe(2);
    expect(kioskPagesPerVisit(2, 8_000)).toBe(1);
    expect(kioskPagesPerVisit(0, 30_000)).toBe(0);
  });
});

describe("indicator and rotation helpers", () => {
  test("indicator reads 'Page i of P' and is null for one page", () => {
    expect(kioskIndicatorLabel(0, 4)).toBe("Page 1 of 4");
    expect(kioskIndicatorLabel(3, 4)).toBe("Page 4 of 4");
    expect(kioskIndicatorLabel(0, 1)).toBeNull();
    expect(kioskIndicatorLabel(0, 0)).toBeNull();
  });

  test("only a positive-integer overview rotation entry supplies a dwell", () => {
    const ctx = (viewId: string, dwellMs: number): ViewRotationContext => ({
      entry: { viewId, dwellMs },
      index: 0,
      total: 2,
      epoch: 1,
    });
    expect(overviewRotationDwell(null)).toBeNull();
    expect(overviewRotationDwell(ctx("overview", 45_000))).toBe(45_000);
    expect(overviewRotationDwell(ctx("alerts", 45_000))).toBeNull();
    expect(overviewRotationDwell(ctx("overview", 0))).toBeNull();
    expect(overviewRotationDwell(ctx("overview", 1.5))).toBeNull();
    expect(overviewRotationDwell(ctx("overview", Number.NaN))).toBeNull();
  });
});

describe("boundary (source review)", () => {
  const dir = new URL("../src/client/views/overview/kiosk/", import.meta.url);
  for (const file of ["paging.ts", "useKioskPaging.ts"]) {
    test(`${file} never navigates, advances rotation, or imports shell/router/store modules`, () => {
      const src = readFileSync(new URL(file, dir), "utf8");
      expect(src).not.toMatch(/navigate/);
      expect(src).not.toMatch(/setNextKioskView/);
      expect(src).not.toMatch(/\brouter\b/i);
      const specifiers = [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]!);
      for (const spec of specifiers) {
        expect(spec).not.toMatch(/\/(shell|store)\/|router\.js$|live-state/);
      }
    });
  }
  test("paging.ts is pure (no React, DOM timers or globals)", () => {
    const src = readFileSync(new URL("paging.ts", dir), "utf8");
    expect(src).not.toMatch(/from\s+"(react|@preact\/signals)/);
    expect(src).not.toMatch(/setTimeout|requestAnimationFrame|ResizeObserver|globalThis|document/);
  });
});

// ── hook ────────────────────────────────────────────────────────────────────────────────────

interface FakeClock {
  readonly clock: KioskPagingClock;
  advance(ms: number): void;
  /** Move the clock by `ms`, then deliver only the earliest pending callback (a throttled timer). */
  fireLate(ms: number): void;
  pending(): number;
  readonly cleared: number[];
  readonly scheduled: { handle: number; delay: number }[];
}

function fakeClock(): FakeClock {
  let now = 1_000; // non-zero baseline: the hook must use elapsed time, not absolute time
  let nextId = 1;
  const queue = new Map<number, { at: number; fn: () => void }>();
  const cleared: number[] = [];
  const scheduled: { handle: number; delay: number }[] = [];
  return {
    clock: {
      now: () => now,
      setTimeout(fn, delay) {
        const handle = nextId++;
        queue.set(handle, { at: now + delay, fn });
        scheduled.push({ handle, delay });
        return handle;
      },
      clearTimeout(handle) {
        cleared.push(handle);
        queue.delete(handle);
      },
    },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...queue].filter(([, e]) => e.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (due === undefined) break;
        queue.delete(due[0]);
        now = due[1].at;
        act(() => due[1].fn());
      }
      now = end;
    },
    fireLate(ms) {
      now += ms;
      const first = [...queue].sort((a, b) => a[1].at - b[1].at)[0];
      if (first === undefined) return;
      queue.delete(first[0]);
      act(() => first[1].fn());
    },
    pending: () => queue.size,
    cleared,
    scheduled,
  };
}

/** Manual requestAnimationFrame queue installed on globalThis for one test. */
function installFrames(): { flush(): void; restore(): void } {
  const g = globalThis as unknown as Record<string, unknown>;
  const realRaf = g["requestAnimationFrame"];
  const realCaf = g["cancelAnimationFrame"];
  const frames = new Map<number, () => void>();
  let id = 0;
  g["requestAnimationFrame"] = (fn: () => void) => {
    frames.set(++id, fn);
    return id;
  };
  g["cancelAnimationFrame"] = (handle: number) => frames.delete(handle);
  return {
    flush() {
      const due = [...frames.values()];
      frames.clear();
      act(() => due.forEach((fn) => fn()));
    },
    restore() {
      g["requestAnimationFrame"] = realRaf;
      g["cancelAnimationFrame"] = realCaf;
    },
  };
}

interface HarnessProps {
  readonly hosts: readonly HostStatus[];
  readonly rotation: ViewRotationContext | null;
  readonly regionRef: RefObject<HTMLElement>;
  readonly gridRef: RefObject<HTMLElement>;
  readonly clock: KioskPagingClock;
  readonly onState: (state: KioskPagingState) => void;
}

function Harness({ onState, ...options }: HarnessProps): JSX.Element {
  const state = useKioskPaging(options);
  onState(state);
  return createElement("div", { "data-page": String(state.activePageIndex) });
}

describeDom("useKioskPaging", (dom) => {
  let container: HTMLElement;
  let frames: { flush(): void; restore(): void };
  let region: HTMLElement;
  let grid: HTMLElement;
  /** The region's height and the grid's laid-out geometry (read through a stubbed getComputedStyle). */
  let layout: { height: number; columns: number; rowHeight: number; rowGap: number };
  let state: KioskPagingState;
  let savedRO: unknown;
  let savedStyle: unknown;
  let observers: { callback: () => void; observed: Element[]; disconnected: boolean }[];

  beforeEach(() => {
    resetKioskRotationCursor();
    container = document.createElement("div");
    document.body.appendChild(container);
    frames = installFrames();
    layout = { height: 200, columns: 4, rowHeight: 100, rowGap: 0 };
    region = document.createElement("div") as unknown as HTMLElement;
    region.getBoundingClientRect = () => ({ height: layout.height }) as DOMRect;
    grid = document.createElement("ul") as unknown as HTMLElement;

    const g = globalThis as unknown as Record<string, unknown>;
    savedStyle = g["getComputedStyle"];
    const realStyle = savedStyle as (el: Element) => CSSStyleDeclaration;
    g["getComputedStyle"] = (el: Element) =>
      el === (grid as unknown as Element)
        ? ({
            gridTemplateColumns: Array.from({ length: layout.columns }, () => `${layout.rowHeight}px`).join(" ") || "none",
            gridAutoRows: `${layout.rowHeight}px`,
            rowGap: `${layout.rowGap}px`,
          } as unknown as CSSStyleDeclaration)
        : realStyle(el);
    savedRO = g["ResizeObserver"];
    observers = [];
    g["ResizeObserver"] = class {
      private readonly record: (typeof observers)[number];
      constructor(callback: () => void) {
        this.record = { callback, observed: [], disconnected: false };
        observers.push(this.record);
      }
      observe(el: Element): void {
        this.record.observed.push(el);
      }
      unobserve(): void {}
      disconnect(): void {
        this.record.disconnected = true;
      }
    };
  });

  afterEach(async () => {
    const { render } = await import("./react-render.js");
    act(() => render(null, container as unknown as Element));
    container.remove();
    frames.restore();
    const g = globalThis as unknown as Record<string, unknown>;
    g["ResizeObserver"] = savedRO;
    g["getComputedStyle"] = savedStyle;
    resetKioskRotationCursor();
  });

  async function renderHook(props: Omit<HarnessProps, "onState" | "regionRef" | "gridRef">): Promise<void> {
    const { render } = await import("./react-render.js");
    act(() => {
      render(
        createElement(Harness, {
          ...props,
          regionRef: { current: region },
          gridRef: { current: grid },
          onState: (s: KioskPagingState) => {
            state = s;
          },
        }),
        container as unknown as Element,
      );
    });
  }

  async function unmount(): Promise<void> {
    const { render } = await import("./react-render.js");
    act(() => render(null, container as unknown as Element));
  }

  const rotation = (epoch: number, dwellMs = 40_000): ViewRotationContext => ({
    entry: { viewId: "overview", dwellMs },
    index: 0,
    total: 3,
    epoch,
  });

  /** Record the visible page each time it changes while advancing the fake clock in 1 s steps. */
  function pageStarts(fc: FakeClock, untilMs: number): [number, number][] {
    const starts: [number, number][] = [[0, state.activePageIndex]];
    for (let elapsed = 1_000; elapsed <= untilMs; elapsed += 1_000) {
      const before = state.activePageIndex;
      fc.advance(1_000);
      if (state.activePageIndex !== before) starts.push([elapsed, state.activePageIndex]);
    }
    return starts;
  }

  test("measures columns × rows from the grid's computed tracks and the region height", async () => {
    expect(dom.win).toBeDefined();
    const fc = fakeClock();
    await renderHook({ hosts: HOSTS, rotation: null, clock: fc.clock });
    expect(state.capacity).toBe(8);
    expect(state.pages.map((p) => p.hosts.length)).toEqual([8, 4]);
    expect(ids(state.pages)).toEqual(ids([{ hosts: HOSTS }]));
    expect(state.activePageIndex).toBe(0);
    expect(state.indicatorLabel).toBe("Page 1 of 2");
    expect(observers).toHaveLength(1);
    expect(observers[0]!.observed[0]).toBe(region as unknown as Element);
  });

  test("readKioskGridMetrics counts laid-out tracks (region height from its layout box) and is null without them", () => {
    expect(readKioskGridMetrics(region, grid)).toEqual({ height: 200, columns: 4, rowHeight: 100, rowGap: 0 });
    layout.columns = 0;
    expect(readKioskGridMetrics(region, grid)).toBeNull();
    expect(readKioskGridMetrics(null, grid)).toBeNull();
    expect(readKioskGridMetrics(region, null)).toBeNull();
  });

  test("without rotation each of three pages stays 10 s and the 30 s cycle wraps to page 1", async () => {
    const fc = fakeClock();
    layout.height = 100; // 4 per page → 3 pages
    await renderHook({ hosts: HOSTS, rotation: null, clock: fc.clock });
    expect(state.pages).toHaveLength(3);
    expect(state.pageDwellMs).toBe(10_000);
    expect(fc.scheduled[0]!.delay).toBe(10_000);
    expect(pageStarts(fc, 40_000)).toEqual([[0, 0], [10_000, 1], [20_000, 2], [30_000, 0], [40_000, 1]]);
    expect(fc.pending()).toBe(1);
  });

  test("without rotation two pages share the 30 s cycle (15 s each)", async () => {
    const fc = fakeClock();
    await renderHook({ hosts: HOSTS, rotation: null, clock: fc.clock });
    expect(state.pages).toHaveLength(2);
    expect(pageStarts(fc, 30_000)).toEqual([[0, 0], [15_000, 1], [30_000, 0]]);
  });

  test("without rotation the cycle grows with the page count: six pages, 10 s each, 60 s cycle", async () => {
    const fc = fakeClock();
    layout.height = 100;
    layout.columns = 2; // 2 per page → 6 pages
    await renderHook({ hosts: HOSTS, rotation: null, clock: fc.clock });
    expect(state.pages).toHaveLength(6);
    expect(state.pageDwellMs).toBe(10_000);
    const starts = pageStarts(fc, 60_000);
    expect(starts.map(([at]) => at)).toEqual([0, 10_000, 20_000, 30_000, 40_000, 50_000, 60_000]);
    expect(starts.map(([, page]) => page)).toEqual([0, 1, 2, 3, 4, 5, 0]);
  });

  test("a late timer advances one page and the next page still gets its full dwell", async () => {
    const fc = fakeClock();
    layout.height = 100;
    await renderHook({ hosts: HOSTS, rotation: null, clock: fc.clock });
    fc.fireLate(25_000); // the 10 000 ms boundary is delivered 15 s late
    expect(state.activePageIndex).toBe(1);
    expect(fc.scheduled.at(-1)!.delay).toBe(10_000);
  });

  test("rotation dwell drives the page dwell; every page fits the visit and the last holds", async () => {
    const fc = fakeClock();
    layout.height = 100;
    await renderHook({ hosts: HOSTS, rotation: rotation(1, 45_000), clock: fc.clock });
    expect(state.pageDwellMs).toBe(15_000);
    expect(pageStarts(fc, 45_000)).toEqual([[0, 0], [15_000, 1], [30_000, 2]]);
    expect(fc.pending()).toBe(0); // the shell advances; overview arms nothing past the visit
    expect(state.activePageIndex).toBe(2);
  });

  test("a short rotation dwell shows the pages that fit at 10 s each; the next visit resumes after them", async () => {
    const fc = fakeClock();
    layout.height = 100;
    layout.columns = 2; // 6 pages
    await renderHook({ hosts: HOSTS, rotation: rotation(1, 20_000), clock: fc.clock });
    expect(state.pageDwellMs).toBe(10_000);
    expect(pageStarts(fc, 20_000)).toEqual([[0, 0], [10_000, 1]]);
    expect(fc.pending()).toBe(0);

    // The overview unmounts while the rotation shows other views, then returns.
    await unmount();
    await renderHook({ hosts: HOSTS, rotation: rotation(4, 20_000), clock: fc.clock });
    expect(state.activePageIndex).toBe(2);
    expect(state.indicatorLabel).toBe("Page 3 of 6");
    expect(pageStarts(fc, 20_000)).toEqual([[0, 2], [10_000, 3]]);

    // A same-mount epoch change (e.g. `overview,overview`) also resumes, and wraps to page 1.
    await renderHook({ hosts: HOSTS, rotation: rotation(5, 20_000), clock: fc.clock });
    expect(state.activePageIndex).toBe(4);
    fc.advance(10_000);
    await renderHook({ hosts: HOSTS, rotation: rotation(6, 20_000), clock: fc.clock });
    expect(state.activePageIndex).toBe(0);
  });

  test("a rotation epoch change clears the prior timer and restarts the page dwell", async () => {
    const fc = fakeClock();
    layout.height = 100; // 3 pages, 40 s dwell → 13 333 ms each, all fit
    await renderHook({ hosts: HOSTS, rotation: rotation(1), clock: fc.clock });
    fc.advance(13_333);
    expect(state.activePageIndex).toBe(1);
    const armed = fc.scheduled.at(-1)!.handle;

    await renderHook({ hosts: HOSTS, rotation: rotation(2), clock: fc.clock });
    expect(state.activePageIndex).toBe(2); // resumes after the page last shown
    expect(fc.cleared).toContain(armed);
    expect(fc.pending()).toBe(1);
    fc.advance(13_332);
    expect(state.activePageIndex).toBe(2);
    fc.advance(1);
    expect(state.activePageIndex).toBe(0);
  });

  test("a status-only change or a worst-first reorder keeps the visible page and its timer", async () => {
    const fc = fakeClock();
    layout.height = 100;
    await renderHook({ hosts: HOSTS, rotation: null, clock: fc.clock });
    fc.advance(10_000);
    expect(state.activePageIndex).toBe(1);
    const scheduledBefore = fc.scheduled.length;

    // Same ids, fresh host objects (a status change), and a different order.
    const refreshed = HOSTS.map((host) => ({ ...host }));
    await renderHook({ hosts: refreshed, rotation: null, clock: fc.clock });
    expect(state.activePageIndex).toBe(1);
    expect(state.pages[1]!.hosts[0]).toBe(refreshed[4]!);
    const reordered = [...refreshed].reverse();
    await renderHook({ hosts: reordered, rotation: null, clock: fc.clock });
    expect(state.activePageIndex).toBe(1);
    expect(state.pages[1]!.hosts[0]).toBe(reordered[4]!);
    expect(fc.scheduled.length).toBe(scheduledBefore);
  });

  test("a capacity that changes and changes back restarts at page 1 and never resurrects the old page", async () => {
    const fc = fakeClock();
    layout.height = 100; // 4 per page → 3 pages
    await renderHook({ hosts: HOSTS, rotation: null, clock: fc.clock });
    fc.advance(20_000);
    expect(state.activePageIndex).toBe(2);

    layout.columns = 2; // e.g. chrome above grew: 2 per page → 6 pages, a new sequence at page 1
    act(() => observers[0]!.callback());
    expect(state.indicatorLabel).toBe("Page 1 of 6");

    layout.columns = 4; // back to the first geometry: still a new sequence, not the old page 3
    act(() => observers[0]!.callback());
    expect(state.indicatorLabel).toBe("Page 1 of 3");
    fc.advance(10_000);
    expect(state.activePageIndex).toBe(1);
  });

  test("a host newly turning critical restarts the sequence at page 1; other status changes keep the page", async () => {
    const fc = fakeClock();
    layout.height = 100; // 3 pages
    const snapshot = makeOverviewSnapshot({ hostCount: 12 });
    const order = snapshot.hosts.map((h) => h.drilldownId);
    const hostsOf = (next: typeof snapshot): HostStatus[] =>
      order.map((id) => next.hosts.find((h) => h.drilldownId === id)!);
    await renderHook({ hosts: hostsOf(snapshot), rotation: null, clock: fc.clock });
    fc.advance(20_000);
    expect(state.activePageIndex).toBe(2);

    // host-001 (OK) turns warning: no new critical host, the page and its timer hold.
    const warned = withTargetStatus(snapshot, "host:host-001", "warning", 2);
    const scheduled = fc.scheduled.length;
    await renderHook({ hosts: hostsOf(warned), rotation: null, clock: fc.clock });
    expect(state.activePageIndex).toBe(2);
    expect(fc.scheduled.length).toBe(scheduled);

    // It then turns critical: back to page 1 at once, with a fresh full dwell.
    const armed = fc.scheduled.at(-1)!.handle;
    await renderHook({ hosts: hostsOf(withTargetStatus(warned, "host:host-001", "critical", 3)), rotation: null, clock: fc.clock });
    expect(state.activePageIndex).toBe(0);
    expect(fc.cleared).toContain(armed);
    expect(fc.scheduled.at(-1)!.delay).toBe(10_000);

    // Inside a rotation it also restarts at page 1 rather than the resume page.
    await unmount();
    resetKioskRotationCursor();
    await renderHook({ hosts: hostsOf(snapshot), rotation: rotation(1, 45_000), clock: fc.clock });
    fc.advance(15_000);
    expect(state.activePageIndex).toBe(1);
    await renderHook({ hosts: hostsOf(withTargetStatus(snapshot, "host:host-001", "critical", 2)), rotation: rotation(1, 45_000), clock: fc.clock });
    expect(state.activePageIndex).toBe(0);
  });

  describe("flap guard for the critical restart", () => {
    const FLAPPER = "host:host-001";
    const snapshot = makeOverviewSnapshot({ hostCount: 12 });
    // host-001 (OK) last, so it sits on the last page whatever the capacity.
    const order = [...snapshot.hosts.map((h) => h.drilldownId).filter((id) => id !== FLAPPER), FLAPPER];
    const hostsOf = (next: typeof snapshot): HostStatus[] => order.map((id) => next.hosts.find((h) => h.drilldownId === id)!);
    const calm = hostsOf(snapshot);
    const alarmed = hostsOf(withTargetStatus(snapshot, FLAPPER, "critical", 2));

    test("a host flapping critical/OK every 3 s restarts at most once per cycle, so later pages still show", async () => {
      const fc = fakeClock();
      layout.height = 100; // 3 pages, 10 s each, 30 s cycle
      await renderHook({ hosts: calm, rotation: null, clock: fc.clock });
      const seen = new Set<number>([state.activePageIndex]);
      let restarts = 0;
      for (let t = 0; t < 90_000; t += 3_000) {
        const before = state.activePageIndex;
        await renderHook({ hosts: (t / 3_000) % 2 === 0 ? alarmed : calm, rotation: null, clock: fc.clock });
        if (state.activePageIndex === 0 && before !== 0) restarts += 1;
        fc.advance(3_000);
        seen.add(state.activePageIndex);
      }
      expect([...seen].sort()).toEqual([0, 1, 2]);
      // 90 s of flapping: at most one restart per 30 s cycle (natural wraps to page 1 included).
      expect(restarts).toBeLessThanOrEqual(3);
    });

    test("no restart when the newly critical host is already on the visible page", async () => {
      const fc = fakeClock();
      layout.height = 100;
      await renderHook({ hosts: calm, rotation: null, clock: fc.clock });
      fc.advance(20_000);
      expect(state.activePageIndex).toBe(2); // the flapper's page
      const scheduled = fc.scheduled.length;
      await renderHook({ hosts: alarmed, rotation: null, clock: fc.clock });
      expect(state.activePageIndex).toBe(2);
      expect(fc.scheduled.length).toBe(scheduled);
    });

    test("inside a rotation a flapping host does not reset the resume page on every visit", async () => {
      const fc = fakeClock();
      layout.height = 100;
      layout.columns = 2; // 6 pages at 10 s: a 60 s cycle, two pages per 20 s visit
      await renderHook({ hosts: calm, rotation: rotation(1, 20_000), clock: fc.clock });
      await renderHook({ hosts: alarmed, rotation: rotation(1, 20_000), clock: fc.clock }); // restart (page 1)
      fc.advance(3_000);
      await renderHook({ hosts: calm, rotation: rotation(1, 20_000), clock: fc.clock });
      fc.advance(7_000);
      expect(state.activePageIndex).toBe(1);
      fc.advance(10_000);
      await unmount();

      // The next visit mounts while the host keeps flapping; the flap is in its cooldown.
      await renderHook({ hosts: calm, rotation: rotation(2, 20_000), clock: fc.clock });
      expect(state.activePageIndex).toBe(2);
      await renderHook({ hosts: alarmed, rotation: rotation(2, 20_000), clock: fc.clock });
      expect(state.activePageIndex).toBe(2);
    });
  });

  test("a resize that changes capacity rebuilds pages, resets page 1 and clears the prior timer", async () => {
    const fc = fakeClock();
    layout.height = 100;
    await renderHook({ hosts: HOSTS, rotation: null, clock: fc.clock });
    fc.advance(10_000);
    expect(state.activePageIndex).toBe(1);
    const armed = fc.scheduled.at(-1)!.handle;

    layout.columns = 2; // 2 per page → 6 pages
    act(() => observers[0]!.callback()); // ResizeObserver delivers after layout: measured at once
    expect(state.capacity).toBe(2);
    expect(state.pages).toHaveLength(6);
    expect(ids(state.pages)).toEqual(ids([{ hosts: HOSTS }]));
    expect(state.activePageIndex).toBe(0);
    expect(state.indicatorLabel).toBe("Page 1 of 6");
    expect(fc.cleared).toContain(armed);
    expect(fc.pending()).toBe(1);
    expect(fc.scheduled.at(-1)!.delay).toBe(10_000);
  });

  test("unmounting releases the timer and the observer", async () => {
    const fc = fakeClock();
    layout.height = 100;
    await renderHook({ hosts: HOSTS, rotation: null, clock: fc.clock });
    expect(fc.pending()).toBe(1);
    await unmount();
    expect(fc.pending()).toBe(0);
    expect(observers.every((o) => o.disconnected)).toBe(true);
  });

  test("one page arms no timer and shows no indicator", async () => {
    const fc = fakeClock();
    await renderHook({ hosts: HOSTS.slice(0, 3), rotation: rotation(1), clock: fc.clock });
    expect(state.pages).toHaveLength(1);
    expect(state.indicatorLabel).toBeNull();
    expect(fc.pending()).toBe(0);
  });

  test("missing ResizeObserver does not throw and re-measures on window resize", async () => {
    const g = globalThis as unknown as Record<string, unknown>;
    delete g["ResizeObserver"];
    const listeners: (() => void)[] = [];
    const realAdd = g["addEventListener"];
    const realRemove = g["removeEventListener"];
    g["addEventListener"] = (type: string, fn: () => void) => {
      if (type === "resize") listeners.push(fn);
    };
    g["removeEventListener"] = (type: string, fn: () => void) => {
      if (type === "resize") listeners.splice(listeners.indexOf(fn), 1);
    };
    try {
      const fc = fakeClock();
      await renderHook({ hosts: HOSTS, rotation: null, clock: fc.clock });
      expect(state.capacity).toBe(8);
      expect(listeners).toHaveLength(1);
      layout.columns = 1;
      act(() => listeners[0]!());
      frames.flush();
      expect(state.capacity).toBe(2);
      expect(state.activePageIndex).toBe(0);
      await unmount();
      expect(listeners).toHaveLength(0);
    } finally {
      g["addEventListener"] = realAdd;
      g["removeEventListener"] = realRemove;
    }
  });

  test("a throwing ResizeObserver constructor or an unmeasurable grid falls back to capacity one", async () => {
    (globalThis as unknown as Record<string, unknown>)["ResizeObserver"] = class {
      constructor() {
        throw new Error("unsupported");
      }
    };
    const fc = fakeClock();
    layout.columns = 0; // no laid-out tracks
    await renderHook({ hosts: HOSTS.slice(0, 5), rotation: null, clock: fc.clock });
    expect(state.capacity).toBe(1);
    expect(state.pages).toHaveLength(5);
    expect(state.indicatorLabel).toBe("Page 1 of 5");
  });

  test("a throwing clock.setTimeout keeps page 1 visible without an error", async () => {
    const fc = fakeClock();
    layout.height = 100;
    const clock: KioskPagingClock = {
      now: fc.clock.now,
      setTimeout: () => {
        throw new Error("timers unavailable");
      },
      clearTimeout: fc.clock.clearTimeout,
    };
    await renderHook({ hosts: HOSTS, rotation: null, clock });
    expect(state.activePageIndex).toBe(0);
    expect(state.indicatorLabel).toBe("Page 1 of 3");
  });
});

describeDom("kiosk ribbon — acked count (REQ-ACK-07d, REQ-AUTHZ-05)", () => {
  const router = { navigate: () => {} } as unknown as PathRouter;
  const clock = createEstateClock(FIXTURE_ESTATE);

  async function mountKiosk(alerts: ReturnType<typeof makeOverviewSnapshot>["alerts"]): Promise<{ root: HTMLElement; unmount(): void }> {
    let result!: Awaited<ReturnType<typeof renderWithStore>>;
    await act(async () => {
      result = await renderWithStore(
        createElement(FiringRibbon, { alerts, router, clock, kiosk: true, alertsCurrent: true, alertsLastGoodAt: null }) as unknown as JSX.Element,
      );
    });
    return { root: result.container, unmount: () => result.unmount() };
  }

  test("'N acknowledged' with a circle-check glyph follows the counts line; never focusable", async () => {
    const alerts = makeOverviewSnapshot().alerts;
    expect(alerts.length).toBeGreaterThanOrEqual(2);
    const acked = alerts.map((a, i) => (i < 2 ? { ...a, acked: true as const } : a));
    const { root, unmount } = await mountKiosk(acked);
    const line = root.querySelector("[data-ribbon-acked]")!;
    expect(line.previousElementSibling?.hasAttribute("data-ribbon-counts")).toBe(true);
    expect(line.textContent).toBe("2 acknowledged");
    expect(line.querySelector("svg")?.getAttribute("class") ?? "").toContain("circle-check");
    const ribbon = root.querySelector("[data-ribbon='kiosk']")!;
    expect(ribbon.querySelectorAll("button, a, input, [role='button'], [tabindex], [href]").length).toBe(0);
    unmount();
  });

  test("no acked alerts → no acknowledged line", async () => {
    const { root, unmount } = await mountKiosk(makeOverviewSnapshot().alerts);
    expect(root.querySelector("[data-ribbon-acked]")).toBeNull();
    expect(root.textContent).not.toContain("acknowledged");
    unmount();
  });
});
