// apps/web/src/client/views/overview/kiosk/useKioskPaging.ts — measured kiosk paging hook.
//
// The hook only picks which page of the already-derived groups is visible. The shell stays the
// sole owner of view rotation and its timers; this module reads `rotation` and never writes it.
// All page timing goes through the injected `KioskPagingClock`.

import type { RefObject } from "react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { ViewRotationContext } from "../../../../shared/registry.js";
import { TARGET_ID_ATTRIBUTE } from "../grid/navigation.js";
import type { KioskPage, OverviewGroup } from "../model.js";
import {
  MIN_KIOSK_CAPACITY,
  NON_ROTATING_KIOSK_CYCLE_MS,
  buildKioskPages,
  fitKioskCapacity,
  pageSchedule,
  type KioskFitMetrics,
} from "./paging.js";

/** Injected timer/clock seam used by deterministic unit tests. */
export interface KioskPagingClock {
  /** Return monotonic milliseconds for elapsed-time selection. */
  now(): number;
  /** Schedule one page boundary callback. */
  setTimeout(callback: () => void, delayMs: number): number;
  /** Cancel a previously scheduled callback. */
  clearTimeout(handle: number): void;
}

/** Inputs to the kiosk paging hook. */
export interface UseKioskPagingOptions {
  /** Ordered groups from the coherent `OverviewModel`. */
  readonly groups: readonly OverviewGroup[];
  /** True only for `route.query.kiosk === "1"`. */
  readonly kiosk: boolean;
  /** Current shell-owned rotation context, or null without active rotation. */
  readonly rotation: ViewRotationContext | null;
  /** Element containing exactly the available grouped-grid page area. */
  readonly viewportRef: RefObject<HTMLElement | null>;
  /** Hidden, inert page probe used to validate actual rendered fit. */
  readonly measurementRef: RefObject<HTMLElement | null>;
  /** Optional deterministic test seam; defaults to a performance/global-timer adapter. */
  readonly clock?: KioskPagingClock;
}

/** Render state returned to `OverviewGrid`; target health is never copied into this state. */
export interface KioskPagingState {
  /** Deterministic partition; empty only when the estate has no hosts. */
  readonly pages: readonly KioskPage[];
  /** Zero-based visible page. */
  readonly activePageIndex: number;
  /** Measured host count per page, clamped to at least one. */
  readonly capacity: number;
  /** True while kiosk paging, false for the ordinary complete grid. */
  readonly paged: boolean;
  /** Stable accessible text, for example `Page 2 of 4`; null when not paged. */
  readonly indicatorLabel: string | null;
}

/** The view id whose rotation entry this hook may follow. */
const OVERVIEW_VIEW_ID = "overview";

/** Selector for group headings inside the measurement probe. */
export const KIOSK_PROBE_HEADING_SELECTOR = "h2, h3, [role='heading']";

/** Production clock: `performance.now()` plus global timers read at call time. */
const handles = new Map<number, ReturnType<typeof globalThis.setTimeout>>();
let nextHandle = 0;
const defaultClock: KioskPagingClock = {
  now: () => (typeof performance !== "undefined" ? performance.now() : Date.now()),
  setTimeout(callback, delayMs) {
    const id = ++nextHandle;
    handles.set(
      id,
      globalThis.setTimeout(() => {
        handles.delete(id);
        callback();
      }, delayMs),
    );
    return id;
  },
  clearTimeout(handle) {
    const timer = handles.get(handle);
    if (timer === undefined) return;
    handles.delete(handle);
    globalThis.clearTimeout(timer);
  },
};

/** `Page i of P` for a multi-page kiosk partition, otherwise null. */
export function kioskIndicatorLabel(activePageIndex: number, pageCount: number): string | null {
  return pageCount > 1 ? `Page ${activePageIndex + 1} of ${pageCount}` : null;
}

/** Positive integer dwell of a rotation entry that belongs to this view, else null. */
export function overviewRotationDwell(rotation: ViewRotationContext | null): number | null {
  if (rotation === null || rotation.entry.viewId !== OVERVIEW_VIEW_ID) return null;
  const dwell = rotation.entry.dwellMs;
  return Number.isInteger(dwell) && dwell > 0 ? dwell : null;
}

function px(value: string | undefined): number {
  const n = Number.parseFloat(value ?? "");
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * Read fit metrics from the viewport and the probe's first rendered host cell and heading; null
 * when either element or a representative cell is unavailable.
 */
export function readKioskFitMetrics(viewport: HTMLElement | null, probe: HTMLElement | null): KioskFitMetrics | null {
  if (viewport === null || probe === null) return null;
  const cell = probe.querySelector(`[${TARGET_ID_ATTRIBUTE}]`);
  if (cell === null) return null;
  const cellRect = cell.getBoundingClientRect();
  const heading = probe.querySelector(KIOSK_PROBE_HEADING_SELECTOR);
  const grid = cell.parentElement;
  const style =
    grid !== null && typeof globalThis.getComputedStyle === "function" ? globalThis.getComputedStyle(grid) : null;
  return {
    width: viewport.clientWidth,
    height: viewport.clientHeight,
    cellWidth: cellRect.width,
    cellHeight: cellRect.height,
    headingHeight: heading === null ? 0 : heading.getBoundingClientRect().height,
    columnGap: px(style?.columnGap),
    rowGap: px(style?.rowGap),
  };
}

/** Ordered group/host identity sequence: a change here repartitions; status-only changes don't. */
function orderKeyOf(groups: readonly OverviewGroup[]): string {
  return groups.map((g) => `${g.id}\u0000${g.hosts.map((h) => h.drilldownId).join("\u0001")}`).join("\u0002");
}

/** Measure, partition, schedule, and reset kiosk pages without owning shell rotation. */
export function useKioskPaging(options: UseKioskPagingOptions): KioskPagingState {
  const { groups, kiosk, rotation, viewportRef, measurementRef } = options;
  const clock = options.clock ?? defaultClock;

  // null until the first measurement commits: no page timer is armed on an unmeasured partition.
  const [capacity, setCapacity] = useState<number | null>(null);
  const [active, setActive] = useState<{ readonly key: string; readonly index: number }>({ key: "", index: 0 });

  const orderKey = useMemo(() => orderKeyOf(groups), [groups]);
  const groupsRef = useRef(groups);
  groupsRef.current = groups;

  const totalHosts = useMemo(() => groups.reduce((n, g) => n + g.hosts.length, 0), [groups]);
  const measured = capacity !== null;
  const effectiveCapacity = kiosk ? (capacity ?? MIN_KIOSK_CAPACITY) : Math.max(MIN_KIOSK_CAPACITY, totalHosts);
  const pages = useMemo(() => buildKioskPages(groups, effectiveCapacity), [groups, effectiveCapacity]);

  const rotationDwell = kiosk ? overviewRotationDwell(rotation) : null;
  const rotating = rotationDwell !== null;
  const dwell = rotationDwell ?? NON_ROTATING_KIOSK_CYCLE_MS;
  const epoch = rotating && rotation !== null ? rotation.epoch : null;
  // Any change here selects page 1 in the same render and restarts the page timers.
  const resetKey = `${kiosk ? 1 : 0}|${effectiveCapacity}|${dwell}|${epoch ?? "-"}|${orderKey}`;

  // Measurement: once per kiosk entry / ordered-host change, then on viewport resize.
  useLayoutEffect(() => {
    if (!kiosk) return undefined;
    let live = true;
    let frame: number | null = null;
    const measure = (): void => {
      frame = null;
      if (!live) return;
      let next: number = MIN_KIOSK_CAPACITY;
      try {
        next = fitKioskCapacity(groupsRef.current, readKioskFitMetrics(viewportRef.current, measurementRef.current));
      } catch {
        next = MIN_KIOSK_CAPACITY;
      }
      setCapacity(next);
    };
    const raf = typeof globalThis.requestAnimationFrame === "function" ? globalThis.requestAnimationFrame : null;
    const caf = typeof globalThis.cancelAnimationFrame === "function" ? globalThis.cancelAnimationFrame : null;
    const scheduleMeasure = (): void => {
      if (frame !== null || !live) return;
      if (raf === null) {
        measure();
        return;
      }
      try {
        frame = raf(measure);
      } catch {
        measure();
      }
    };

    measure();

    let observer: ResizeObserver | null = null;
    const viewport = viewportRef.current;
    try {
      const RO = globalThis.ResizeObserver;
      if (typeof RO !== "function" || viewport === null) throw new Error("ResizeObserver unavailable");
      observer = new RO(scheduleMeasure);
      observer.observe(viewport);
    } catch {
      // Bounded fallback: keep the current (≥1) capacity and re-measure on window resize.
      observer = null;
    }
    const onWindowResize = (): void => scheduleMeasure();
    const listenWindow = observer === null && typeof globalThis.addEventListener === "function";
    if (listenWindow) globalThis.addEventListener("resize", onWindowResize);

    return () => {
      live = false;
      if (frame !== null && caf !== null) {
        try {
          caf(frame);
        } catch {
          // Already-fired or foreign frame handle: nothing left to cancel.
        }
      }
      frame = null;
      observer?.disconnect();
      if (listenWindow) globalThis.removeEventListener("resize", onWindowResize);
    };
  }, [kiosk, orderKey, viewportRef, measurementRef]);

  const pageCount = pages.length;

  // Page timers: one armed boundary at a time against the generation's monotonic baseline.
  useEffect(() => {
    if (!kiosk || !measured || pageCount <= 1) return undefined;
    const schedule = pageSchedule(pageCount, dwell);
    if (schedule.length === 0) return undefined;
    let live = true;
    let handle: number | null = null;
    let baseline = clock.now();

    const arm = (elapsed: number): void => {
      const next = schedule.find((entry) => entry.startsAtMs > elapsed);
      // Rotating: the last page holds until the shell advances. Non-rotating: wrap every cycle.
      const target = next !== undefined ? next.startsAtMs : rotating ? null : dwell;
      if (target === null) return;
      try {
        handle = clock.setTimeout(tick, Math.max(0, target - elapsed));
      } catch {
        // Timer failure: the current page stays visible; no false progress is reported.
        handle = null;
      }
    };

    function tick(): void {
      handle = null;
      if (!live) return;
      let elapsed = clock.now() - baseline;
      if (!rotating && elapsed >= dwell) {
        baseline = clock.now();
        elapsed = 0;
      }
      let index = 0;
      for (const entry of schedule) if (entry.startsAtMs <= elapsed) index = entry.pageIndex;
      setActive({ key: resetKey, index });
      arm(elapsed);
    }

    arm(0);
    return () => {
      live = false;
      if (handle === null) return;
      try {
        clock.clearTimeout(handle);
      } catch {
        // A throwing clear leaves the callback guarded by `live`.
      }
      handle = null;
    };
  }, [resetKey, measured, pageCount, dwell, rotating, clock]);

  const activePageIndex = active.key === resetKey ? Math.min(active.index, Math.max(0, pageCount - 1)) : 0;

  return {
    pages,
    activePageIndex,
    capacity: effectiveCapacity,
    paged: kiosk,
    indicatorLabel: kiosk ? kioskIndicatorLabel(activePageIndex, pageCount) : null,
  };
}
