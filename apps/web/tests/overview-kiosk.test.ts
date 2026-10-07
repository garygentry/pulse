// apps/web/tests/overview-kiosk.test.ts — kiosk partition/schedule/capacity helpers and the
// useKioskPaging hook (06 §§4–6, 08 §4.8; REQ-DEN-03..04, REQ-GROUP-01). Timing runs on an
// injected fake KioskPagingClock and frames on a manual queue — no wall-clock waits.
// Kiosk DOM composition (controls, drawer, indicator markup) is covered in item 015.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createElement, type JSX, type RefObject } from "react";
import { act } from "./react-render.js";

import type { HostStatus } from "@pulse/web-data/wire";
import type { ViewRotationContext } from "../src/shared/registry.js";
import { DEFAULT_OVERVIEW_PREFERENCES, type OverviewGroup } from "../src/client/views/overview/model.js";
import { deriveOverviewModel } from "../src/client/views/overview/selectors.js";
import {
  MIN_KIOSK_CAPACITY,
  NON_ROTATING_KIOSK_CYCLE_MS,
  buildKioskPages,
  fitKioskCapacity,
  kioskPageFits,
  pageSchedule,
  type KioskFitMetrics,
} from "../src/client/views/overview/kiosk/paging.js";
import {
  kioskIndicatorLabel,
  overviewRotationDwell,
  useKioskPaging,
  type KioskPagingClock,
  type KioskPagingState,
} from "../src/client/views/overview/kiosk/useKioskPaging.js";
import { createEstateClock } from "../src/client/format.js";
import type { PathRouter } from "../src/client/router.js";
import { FiringRibbon } from "../src/client/views/overview/ribbon/FiringRibbon.js";
import { FIXTURE_ESTATE, makeOverviewSnapshot } from "./fixtures/overview/factory.js";
import { describeDom, renderWithStore } from "./dom.js";

const HOSTS: readonly HostStatus[] = makeOverviewSnapshot({ hostCount: 12 }).hosts;

/** Hand-built groups over fixture hosts: sizes [a, b, …] consume HOSTS in order. */
function groupsOf(...sizes: number[]): OverviewGroup[] {
  let at = 0;
  return sizes.map((size, i) => {
    const hosts = HOSTS.slice(at, at + size);
    at += size;
    return { id: `class:g${i}`, label: `Group ${i}`, hosts };
  });
}

function flatIds(groups: readonly { readonly hosts: readonly HostStatus[] }[]): string[] {
  return groups.flatMap((g) => g.hosts.map((host) => host.drilldownId));
}

describe("kiosk constants", () => {
  test("30 s non-rotating cycle and a minimum capacity of one", () => {
    expect(NON_ROTATING_KIOSK_CYCLE_MS).toBe(30_000);
    expect(MIN_KIOSK_CAPACITY).toBe(1);
  });
});

describe("buildKioskPages", () => {
  const groups = groupsOf(3, 4, 2); // 9 hosts

  test.each([
    ["zero", 0],
    ["negative", -3],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
  ])("capacity %s clamps to one host per page", (_label, capacity) => {
    const pages = buildKioskPages(groups, capacity);
    expect(pages).toHaveLength(9);
    expect(pages.every((p) => p.hosts.length === 1 && p.groupStarts.length === 1)).toBe(true);
  });

  test.each([
    ["one", 1, [1, 1, 1, 1, 1, 1, 1, 1, 1]],
    ["exact fit", 9, [9]],
    ["one over", 8, [8, 1]],
    ["larger than estate", 50, [9]],
    ["fractional", 4.9, [4, 4, 1]],
    ["many groups", 3, [3, 3, 3]],
  ])("capacity %s → page sizes", (_label, capacity, sizes) => {
    const pages = buildKioskPages(groups, capacity);
    expect(pages.map((p) => p.hosts.length)).toEqual(sizes);
    expect(pages.map((p) => p.index)).toEqual(sizes.map((_, i) => i));
  });

  test("flattened pages equal the source hosts exactly once, in order, by identity", () => {
    const matrix = [groupsOf(3, 4, 2), groupsOf(1, 1, 1, 1), groupsOf(12), groupsOf(5, 0, 7), groupsOf(2, 3, 1, 6)];
    for (const input of matrix) {
      const source = input.flatMap((g) => g.hosts);
      for (let capacity = 0; capacity <= 14; capacity++) {
        const out = buildKioskPages(input, capacity).flatMap((p) => p.hosts);
        expect(out).toHaveLength(source.length);
        out.forEach((host, i) => expect(host).toBe(source[i]!));
        expect(new Set(flatIds([{ hosts: out }])).size).toBe(source.length);
      }
    }
  });

  test("a split group repeats its heading at offset 0; a new group records its exact offset", () => {
    const pages = buildKioskPages(groupsOf(3, 4, 2), 4);
    expect(pages.map((p) => p.groupStarts)).toEqual([
      [
        { groupId: "class:g0", label: "Group 0", hostOffset: 0 },
        { groupId: "class:g1", label: "Group 1", hostOffset: 3 },
      ],
      [
        { groupId: "class:g1", label: "Group 1", hostOffset: 0 },
        { groupId: "class:g2", label: "Group 2", hostOffset: 3 },
      ],
      [{ groupId: "class:g2", label: "Group 2", hostOffset: 0 }],
    ]);
  });

  test("empty groups and an empty estate produce no phantom page", () => {
    expect(buildKioskPages([], 4)).toEqual([]);
    expect(buildKioskPages(groupsOf(0, 0), 4)).toEqual([]);
    const pages = buildKioskPages(groupsOf(2, 0, 2), 4);
    expect(pages).toHaveLength(1);
    expect(pages[0]!.groupStarts.map((s) => s.groupId)).toEqual(["class:g0", "class:g2"]);
  });

  test("inputs are not mutated and the model's real group order is preserved", () => {
    const model = deriveOverviewModel(makeOverviewSnapshot({ hostCount: 10 }), DEFAULT_OVERVIEW_PREFERENCES);
    const before = JSON.stringify(model.groups);
    const pages = buildKioskPages(model.groups, 3);
    expect(JSON.stringify(model.groups)).toBe(before);
    expect(flatIds(pages)).toEqual(flatIds(model.groups));
  });
});

describe("pageSchedule", () => {
  test.each([
    [1, 30_000],
    [3, 30_000],
    [4, 45_000],
    [7, 10_001],
    [100, 30_000],
  ])("P=%d D=%d: starts at 0, monotonic, every start < D", (pageCount, dwell) => {
    const schedule = pageSchedule(pageCount, dwell);
    expect(schedule).toHaveLength(pageCount);
    expect(schedule[0]).toEqual({ pageIndex: 0, startsAtMs: 0 });
    schedule.forEach((entry, i) => {
      expect(entry.pageIndex).toBe(i);
      expect(entry.startsAtMs).toBe(Math.floor((i * dwell) / pageCount));
      expect(entry.startsAtMs).toBeLessThan(dwell);
      if (i > 0) expect(entry.startsAtMs).toBeGreaterThan(schedule[i - 1]!.startsAtMs);
    });
  });

  test("invalid page counts or dwells produce no schedule", () => {
    expect(pageSchedule(0, 30_000)).toEqual([]);
    expect(pageSchedule(-1, 30_000)).toEqual([]);
    expect(pageSchedule(2.5, 30_000)).toEqual([]);
    expect(pageSchedule(3, 0)).toEqual([]);
    expect(pageSchedule(3, Number.NaN)).toEqual([]);
    expect(pageSchedule(3, Number.POSITIVE_INFINITY)).toEqual([]);
    expect(pageSchedule(10, 5)).toEqual([]);
  });
});

describe("capacity fit", () => {
  const base: KioskFitMetrics = {
    width: 400,
    height: 200,
    cellWidth: 100,
    cellHeight: 100,
    headingHeight: 0,
    columnGap: 0,
    rowGap: 0,
  };

  test("geometric fit without headings is columns × rows, capped at the host count", () => {
    expect(fitKioskCapacity(groupsOf(12), base)).toBe(8);
    expect(fitKioskCapacity(groupsOf(5), base)).toBe(5);
  });

  test("gaps are included in the column/row estimate", () => {
    expect(fitKioskCapacity(groupsOf(12), { ...base, width: 430, columnGap: 10, rowGap: 10, height: 210 })).toBe(8);
    expect(fitKioskCapacity(groupsOf(12), { ...base, width: 429, columnGap: 10, rowGap: 10, height: 210 })).toBe(6);
  });

  test("overflow from repeated headings reduces capacity until every page fits", () => {
    const metrics = { ...base, headingHeight: 20 };
    const capacity = fitKioskCapacity(groupsOf(12), metrics);
    expect(capacity).toBe(4);
    expect(buildKioskPages(groupsOf(12), capacity).every((p) => kioskPageFits(p, metrics))).toBe(true);
    expect(buildKioskPages(groupsOf(12), capacity + 1).every((p) => kioskPageFits(p, metrics))).toBe(false);
  });

  test("several groups on one page consume extra rows", () => {
    // Three 1-host groups need three rows even though 3 hosts fit one geometric row.
    const metrics = { ...base, height: 250, headingHeight: 10 };
    expect(fitKioskCapacity(groupsOf(1, 1, 1, 1), metrics)).toBe(2);
  });

  test("invalid or unavailable metrics fall back to one", () => {
    expect(fitKioskCapacity(groupsOf(12), null)).toBe(1);
    expect(fitKioskCapacity(groupsOf(12), { ...base, width: 0 })).toBe(1);
    expect(fitKioskCapacity(groupsOf(12), { ...base, height: Number.NaN })).toBe(1);
    expect(fitKioskCapacity(groupsOf(12), { ...base, cellWidth: 500 })).toBe(1);
    expect(fitKioskCapacity(groupsOf(12), { ...base, rowGap: -1 })).toBe(1);
    expect(fitKioskCapacity([], base)).toBe(1);
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
  readonly groups: readonly OverviewGroup[];
  readonly kiosk: boolean;
  readonly rotation: ViewRotationContext | null;
  readonly viewportRef: RefObject<HTMLElement>;
  readonly measurementRef: RefObject<HTMLElement>;
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
  let viewport: HTMLElement;
  let probe: HTMLElement;
  let size: { width: number; height: number };
  let state: KioskPagingState;
  let savedRO: unknown;
  let observers: { callback: () => void; observed: Element[]; disconnected: boolean }[];

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    frames = installFrames();
    size = { width: 400, height: 200 };
    viewport = document.createElement("div") as unknown as HTMLElement;
    Object.defineProperty(viewport, "clientWidth", { get: () => size.width });
    Object.defineProperty(viewport, "clientHeight", { get: () => size.height });
    probe = document.createElement("div") as unknown as HTMLElement;
    const grid = document.createElement("div");
    const cell = document.createElement("div");
    cell.setAttribute("data-target-id", "host:probe");
    cell.getBoundingClientRect = () => ({ width: 100, height: 100 }) as DOMRect;
    grid.appendChild(cell);
    probe.appendChild(grid);

    const g = globalThis as unknown as Record<string, unknown>;
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
    (globalThis as unknown as Record<string, unknown>)["ResizeObserver"] = savedRO;
  });

  async function renderHook(props: Omit<HarnessProps, "onState" | "viewportRef" | "measurementRef">): Promise<void> {
    const { render } = await import("./react-render.js");
    act(() => {
      render(
        createElement(Harness, {
          ...props,
          viewportRef: { current: viewport },
          measurementRef: { current: probe },
          onState: (s: KioskPagingState) => {
            state = s;
          },
        }),
        container as unknown as Element,
      );
    });
  }

  const rotation = (epoch: number, dwellMs = 40_000): ViewRotationContext => ({
    entry: { viewId: "overview", dwellMs },
    index: 0,
    total: 3,
    epoch,
  });

  test("non-kiosk: one complete unpaged page, no indicator, no timers or observer", async () => {
    expect(dom.win).toBeDefined();
    const fc = fakeClock();
    const groups = groupsOf(3, 4, 5);
    await renderHook({ groups, kiosk: false, rotation: rotation(1), clock: fc.clock });
    expect(state.paged).toBe(false);
    expect(state.indicatorLabel).toBeNull();
    expect(state.pages).toHaveLength(1);
    expect(flatIds(state.pages)).toEqual(flatIds(groups));
    expect(fc.pending()).toBe(0);
    expect(observers).toHaveLength(0);
  });

  test("kiosk measures capacity from the viewport and probe and pages every host once", async () => {
    const fc = fakeClock();
    const groups = groupsOf(12);
    await renderHook({ groups, kiosk: true, rotation: null, clock: fc.clock });
    expect(state.paged).toBe(true);
    expect(state.capacity).toBe(8);
    expect(state.pages.map((p) => p.hosts.length)).toEqual([8, 4]);
    expect(flatIds(state.pages)).toEqual(flatIds(groups));
    expect(state.activePageIndex).toBe(0);
    expect(state.indicatorLabel).toBe("Page 1 of 2");
    expect(observers).toHaveLength(1);
    expect(observers[0]!.observed[0]).toBe(viewport as unknown as Element);
  });

  test("without rotation the 30 s cycle shows every page once and wraps to page 1", async () => {
    const fc = fakeClock();
    size = { width: 400, height: 100 }; // 4 per page → 3 pages
    await renderHook({ groups: groupsOf(12), kiosk: true, rotation: null, clock: fc.clock });
    expect(state.pages).toHaveLength(3);
    expect(fc.scheduled[0]!.delay).toBe(10_000);
    const seen = [state.activePageIndex];
    fc.advance(10_000);
    seen.push(state.activePageIndex);
    fc.advance(10_000);
    seen.push(state.activePageIndex);
    expect(seen).toEqual([0, 1, 2]);
    expect(state.indicatorLabel).toBe("Page 3 of 3");
    fc.advance(10_000); // end of the 30 000 ms cycle
    expect(state.activePageIndex).toBe(0);
    expect(fc.pending()).toBe(1);
    fc.advance(10_000);
    expect(state.activePageIndex).toBe(1);
  });

  test("rotation dwell drives the schedule; every page starts before the dwell and the last holds", async () => {
    const fc = fakeClock();
    size = { width: 400, height: 100 };
    await renderHook({ groups: groupsOf(12), kiosk: true, rotation: rotation(1, 45_000), clock: fc.clock });
    const starts: number[] = [];
    let elapsed = 0;
    let last = state.activePageIndex;
    starts[last] = 0;
    while (fc.pending() > 0 && elapsed < 45_000) {
      fc.advance(1_000);
      elapsed += 1_000;
      if (state.activePageIndex !== last) {
        last = state.activePageIndex;
        starts[last] = elapsed;
      }
    }
    expect(starts).toEqual([0, 15_000, 30_000]);
    expect(fc.pending()).toBe(0); // the shell advances; overview arms nothing past the last page
    expect(state.activePageIndex).toBe(2);
  });

  test("a late timer jumps to the greatest due page without replaying intermediates", async () => {
    const fc = fakeClock();
    size = { width: 400, height: 100 };
    const seen: number[] = [];
    const { render } = await import("./react-render.js");
    act(() => {
      render(
        createElement(Harness, {
          groups: groupsOf(12),
          kiosk: true,
          rotation: rotation(1, 30_000),
          viewportRef: { current: viewport },
          measurementRef: { current: probe },
          clock: fc.clock,
          onState: (s: KioskPagingState) => seen.push(s.activePageIndex),
        }),
        container as unknown as Element,
      );
    });
    fc.fireLate(25_000); // the 10 000 ms boundary is delivered 15 s late
    expect(seen.at(-1)).toBe(2);
    expect(seen).not.toContain(1);
    expect(fc.pending()).toBe(0);
  });

  test("a rotation epoch change resets to page 1 and clears the prior timer", async () => {
    const fc = fakeClock();
    size = { width: 400, height: 100 };
    const groups = groupsOf(12);
    await renderHook({ groups, kiosk: true, rotation: rotation(1), clock: fc.clock });
    fc.advance(15_000);
    expect(state.activePageIndex).toBe(1);
    const armed = fc.scheduled.at(-1)!.handle;

    await renderHook({ groups, kiosk: true, rotation: rotation(2), clock: fc.clock });
    expect(state.activePageIndex).toBe(0);
    expect(state.indicatorLabel).toBe("Page 1 of 3");
    expect(fc.cleared).toContain(armed);
    expect(fc.pending()).toBe(1);
    // The new generation restarts its schedule from the epoch baseline.
    fc.advance(13_332);
    expect(state.activePageIndex).toBe(0);
    fc.advance(1);
    expect(state.activePageIndex).toBe(1);
  });

  test("a status-only snapshot change keeps the active page and its timer", async () => {
    const fc = fakeClock();
    size = { width: 400, height: 100 };
    const groups = groupsOf(12);
    await renderHook({ groups, kiosk: true, rotation: null, clock: fc.clock });
    fc.advance(10_000);
    expect(state.activePageIndex).toBe(1);
    const scheduledBefore = fc.scheduled.length;
    // Same ordered ids, fresh host objects (e.g. a status change).
    const refreshed = groups.map((g) => ({ ...g, hosts: g.hosts.map((host) => ({ ...host })) }));
    await renderHook({ groups: refreshed, kiosk: true, rotation: null, clock: fc.clock });
    expect(state.activePageIndex).toBe(1);
    expect(fc.scheduled.length).toBe(scheduledBefore);
    expect(state.pages[1]!.hosts[0]).toBe(refreshed[0]!.hosts[4]!);
  });

  test("a resize that changes capacity rebuilds pages, resets page 1 and clears the prior timer", async () => {
    const fc = fakeClock();
    size = { width: 400, height: 100 };
    const groups = groupsOf(12);
    await renderHook({ groups, kiosk: true, rotation: null, clock: fc.clock });
    fc.advance(10_000);
    expect(state.activePageIndex).toBe(1);
    const armed = fc.scheduled.at(-1)!.handle;

    size = { width: 200, height: 100 }; // 2 per page → 6 pages
    act(() => observers[0]!.callback());
    expect(state.capacity).toBe(4); // coalesced into the next frame, not measured synchronously
    frames.flush();
    expect(state.capacity).toBe(2);
    expect(state.pages).toHaveLength(6);
    expect(flatIds(state.pages)).toEqual(flatIds(groups));
    expect(state.activePageIndex).toBe(0);
    expect(state.indicatorLabel).toBe("Page 1 of 6");
    expect(fc.cleared).toContain(armed);
    expect(fc.pending()).toBe(1);
    expect(fc.scheduled.at(-1)!.delay).toBe(5_000);
  });

  test("leaving kiosk and unmounting release timers and the observer", async () => {
    const fc = fakeClock();
    size = { width: 400, height: 100 };
    const groups = groupsOf(12);
    await renderHook({ groups, kiosk: true, rotation: null, clock: fc.clock });
    expect(fc.pending()).toBe(1);
    await renderHook({ groups, kiosk: false, rotation: null, clock: fc.clock });
    expect(fc.pending()).toBe(0);
    expect(observers[0]!.disconnected).toBe(true);
    expect(state.paged).toBe(false);

    await renderHook({ groups, kiosk: true, rotation: null, clock: fc.clock });
    const { render } = await import("./react-render.js");
    act(() => render(null, container as unknown as Element));
    expect(fc.pending()).toBe(0);
    expect(observers.every((o) => o.disconnected)).toBe(true);
  });

  test("one page arms no timer and shows no indicator", async () => {
    const fc = fakeClock();
    await renderHook({ groups: groupsOf(3), kiosk: true, rotation: rotation(1), clock: fc.clock });
    expect(state.paged).toBe(true);
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
      const groups = groupsOf(12);
      await renderHook({ groups, kiosk: true, rotation: null, clock: fc.clock });
      expect(state.capacity).toBeGreaterThanOrEqual(1);
      expect(flatIds(state.pages)).toEqual(flatIds(groups));
      expect(listeners).toHaveLength(1);
      size = { width: 200, height: 100 };
      act(() => listeners[0]!());
      frames.flush();
      expect(state.capacity).toBe(2);
      expect(state.activePageIndex).toBe(0);
      const { render } = await import("./react-render.js");
      act(() => render(null, container as unknown as Element));
      expect(listeners).toHaveLength(0);
    } finally {
      g["addEventListener"] = realAdd;
      g["removeEventListener"] = realRemove;
    }
  });

  test("a throwing ResizeObserver constructor or unmeasurable probe falls back to capacity one", async () => {
    (globalThis as unknown as Record<string, unknown>)["ResizeObserver"] = class {
      constructor() {
        throw new Error("unsupported");
      }
    };
    const fc = fakeClock();
    probe.replaceChildren(); // no representative host cell to measure
    const groups = groupsOf(3, 2);
    await renderHook({ groups, kiosk: true, rotation: null, clock: fc.clock });
    expect(state.capacity).toBe(1);
    expect(state.pages).toHaveLength(5);
    expect(flatIds(state.pages)).toEqual(flatIds(groups));
    expect(state.indicatorLabel).toBe("Page 1 of 5");
  });

  test("a throwing clock.setTimeout keeps page 1 visible without an error", async () => {
    const fc = fakeClock();
    size = { width: 400, height: 100 };
    const clock: KioskPagingClock = {
      now: fc.clock.now,
      setTimeout: () => {
        throw new Error("timers unavailable");
      },
      clearTimeout: fc.clock.clearTimeout,
    };
    await renderHook({ groups: groupsOf(12), kiosk: true, rotation: null, clock });
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
