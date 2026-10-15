// apps/web/src/client/views/overview/kiosk/useKioskPaging.ts — measured kiosk paging hook.
//
// The hook only picks which page of the flat worst-first host list is visible; a host newly turning
// critical restarts the sequence at page 1. Capacity is columns ×
// rows of the fixed-height tile grid (read from the grid's computed tracks and the region height).
// Every page stays up for at least KIOSK_MIN_PAGE_DWELL_MS, so the cycle grows with the page count.
// The shell stays the sole owner of view rotation and its timers; this module reads `rotation` and
// never writes it. Inside a rotation a visit shows the pages that fit its dwell and holds the last
// one; the next visit resumes at the first page not yet shown. All timing goes through the injected
// `KioskPagingClock`.

import type { RefObject } from "react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { HostStatus } from "@pulse/web-data/wire";
import type { ViewRotationContext } from "../../../../shared/registry.js";
import { effectiveStatus } from "../freshness.js";
import type { KioskPage } from "../model.js";
import {
  MIN_KIOSK_CAPACITY,
  buildKioskPages,
  kioskCapacity,
  kioskPageDwell,
  kioskPagesPerVisit,
  type KioskGridMetrics,
} from "./paging.js";

/** Injected timer/clock seam used by deterministic unit tests. */
export interface KioskPagingClock {
  /** Return monotonic milliseconds. */
  now(): number;
  /** Schedule one page boundary callback. */
  setTimeout(callback: () => void, delayMs: number): number;
  /** Cancel a previously scheduled callback. */
  clearTimeout(handle: number): void;
}

/** Inputs to the kiosk paging hook. */
export interface UseKioskPagingOptions {
  /** Every host, worst status first (`deriveKioskHosts`). */
  readonly hosts: readonly HostStatus[];
  /** Current shell-owned rotation context, or null without active rotation. */
  readonly rotation: ViewRotationContext | null;
  /** The region the tile grid may fill; its height bounds the rows and its resizes re-measure. */
  readonly regionRef: RefObject<HTMLElement | null>;
  /** The rendered tile grid; its computed column tracks, row height and row gap are read. */
  readonly gridRef: RefObject<HTMLElement | null>;
  /**
   * A value whose change means the region may have been resized by the parent's own layout effect
   * (the page root's offset below the shell chrome). Child layout effects run before the parent's,
   * so without it the first measurement would read the region before the parent sized it.
   */
  readonly layoutKey?: unknown;
  /** Optional deterministic test seam; defaults to a performance/global-timer adapter. */
  readonly clock?: KioskPagingClock;
}

/** Render state returned to the kiosk grid; target health is never copied into this state. */
export interface KioskPagingState {
  /** Deterministic partition; empty only when the estate has no hosts. */
  readonly pages: readonly KioskPage[];
  /** Zero-based visible page. */
  readonly activePageIndex: number;
  /** Measured tiles per page, at least one. */
  readonly capacity: number;
  /** How long each page stays up, in ms. */
  readonly pageDwellMs: number;
  /** Stable accessible text, for example `Page 2 of 4`; null for a single page. */
  readonly indicatorLabel: string | null;
}

/** The view id whose rotation entry this hook may follow. */
const OVERVIEW_VIEW_ID = "overview";

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

/**
 * The page the next rotation visit starts on. The overview unmounts between visits, so the cursor
 * lives at module scope; it is only a starting hint and is taken modulo the current page count.
 */
let rotationCursor = 0;

/**
 * When each host id last restarted the sequence by turning critical (clock ms). Module scope for
 * the same reason as the cursor: a host flapping across rotation visits must not reset every visit.
 */
const criticalRestarts = new Map<string, number>();

/** When the wall last restarted for a critical host (clock ms): at most one restart per cycle. */
let lastCriticalRestart = Number.NEGATIVE_INFINITY;

/** Forget where rotation visits resume and which hosts recently restarted the sequence (tests). */
export function resetKioskRotationCursor(): void {
  rotationCursor = 0;
  criticalRestarts.clear();
  lastCriticalRestart = Number.NEGATIVE_INFINITY;
}

/** Longest the first page timer waits for web fonts before starting anyway. */
export const KIOSK_FONT_WAIT_MS = 1_000 as const;

interface FontSetLike {
  readonly status?: string;
  readonly ready?: Promise<unknown>;
  check?(font: string): boolean;
  load?(font: string): Promise<unknown>;
}

/** The face the wall's text is set in (`--font-sans`). Faces load lazily, on first use. */
const KIOSK_FONT = "1em 'Geist Variable'";

/** Whether the wall's font is usable now: no font API, or the face is loaded and nothing is loading. */
function fontsSettledNow(fonts: FontSetLike | null): boolean {
  if (fonts === null) return true;
  try {
    return fonts.status === "loaded" && (typeof fonts.check !== "function" || fonts.check(KIOSK_FONT));
  } catch {
    return true;
  }
}

/** The document's font set, or null where there is none (no DOM, or no CSS Font Loading API). */
function documentFonts(): FontSetLike | null {
  try {
    const fonts = (globalThis as { document?: { fonts?: FontSetLike } }).document?.fonts;
    return fonts !== undefined && fonts !== null && typeof fonts.ready?.then === "function" ? fonts : null;
  } catch {
    return null;
  }
}

/** Ids of the hosts whose effective rollup is critical (the danger tone). */
function criticalIds(hosts: readonly HostStatus[]): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const host of hosts) if (effectiveStatus(host.rollupEvidence) === "critical") ids.add(host.drilldownId);
  return ids;
}

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
 * Read the tile grid's geometry: the region's height, the grid's laid-out column tracks
 * (`grid-template-columns` resolves `repeat(auto-fill, …)` to one length per track), its fixed row
 * height and its row gap. Null when either element is missing or the grid reports no tracks.
 */
export function readKioskGridMetrics(region: HTMLElement | null, grid: HTMLElement | null): KioskGridMetrics | null {
  if (region === null || grid === null || typeof globalThis.getComputedStyle !== "function") return null;
  const style = globalThis.getComputedStyle(grid);
  const columns = (style.gridTemplateColumns ?? "").trim().split(/\s+/).filter((track) => /^\d+(\.\d+)?px$/.test(track)).length;
  const rowHeight = px(style.gridAutoRows);
  if (columns < 1 || rowHeight <= 0) return null;
  return { height: region.getBoundingClientRect().height, columns, rowHeight, rowGap: px(style.rowGap) };
}

/** Measure, partition and time kiosk pages without owning shell rotation. */
export function useKioskPaging(options: UseKioskPagingOptions): KioskPagingState {
  const { hosts, rotation, regionRef, gridRef, layoutKey } = options;
  const clock = options.clock ?? defaultClock;

  // null until the first measurement commits: no page timer is armed on an unmeasured partition.
  const [capacity, setCapacity] = useState<number | null>(null);
  const effectiveCapacity = capacity ?? MIN_KIOSK_CAPACITY;
  const pages = useMemo(() => buildKioskPages(hosts, effectiveCapacity), [hosts, effectiveCapacity]);
  const pageCount = pages.length;

  const rotationDwell = overviewRotationDwell(rotation);
  const rotating = rotationDwell !== null;
  const pageDwellMs = kioskPageDwell(pageCount, rotationDwell);
  const visitPages = rotationDwell !== null ? kioskPagesPerVisit(pageCount, rotationDwell) : pageCount;
  const epoch = rotating && rotation !== null ? rotation.epoch : null;
  // A change here starts a new sequence: page timers restart and the visible page is re-chosen.
  // Status/order changes keep the sequence, so a flapping host never pins the wall to page 1 — except
  // when a host newly turns critical off screen: the sequence restarts at page 1 (flap-guarded).
  const resetKey = `${effectiveCapacity}|${pageCount}|${rotationDwell ?? "-"}|${epoch ?? "-"}`;
  const cycleMs = pageCount * pageDwellMs;

  const [advance, setAdvance] = useState<{ readonly sequence: number; readonly steps: number }>({ sequence: 0, steps: 0 });
  const sequence = useRef<{ readonly id: number; readonly key: string; readonly start: number } | null>(null);

  const critical = useMemo(() => criticalIds(hosts), [hosts]);
  const previousCritical = useRef<ReadonlySet<string> | null>(null);
  const gained = previousCritical.current === null ? [] : [...critical].filter((id) => !previousCritical.current!.has(id));
  previousCritical.current = critical;

  // Flap guard: a newly critical host restarts the sequence only when it is not already on the
  // visible page and has not itself triggered a restart within the last full cycle, and the wall has
  // not restarted for any critical host within that cycle either.
  let criticalRestart = false;
  if (gained.length > 0 && sequence.current !== null && sequence.current.key === resetKey && pageCount > 0) {
    const currentSteps = advance.sequence === sequence.current.id ? advance.steps : 0;
    const visible = pages[(sequence.current.start + currentSteps) % pageCount]?.hosts ?? [];
    const now = clock.now();
    const triggers = gained.filter(
      (id) => !visible.some((host) => host.drilldownId === id) && !(now - (criticalRestarts.get(id) ?? Number.NEGATIVE_INFINITY) < cycleMs),
    );
    if (triggers.length > 0 && now - lastCriticalRestart >= cycleMs) {
      criticalRestart = true;
      lastCriticalRestart = now;
      for (const [id, at] of criticalRestarts) if (now - at >= cycleMs) criticalRestarts.delete(id);
      for (const id of triggers) criticalRestarts.set(id, now);
    }
  }

  // Each sequence has its own id (never reused, so returning to an earlier key cannot resurrect an
  // old step count) and starts on page 1, or inside a rotation on the page the last visit stopped
  // before. A critical restart always starts at page 1, where the worst hosts are: a newly critical
  // host sorts onto it unless more critical hosts than one page holds sort ahead of it.
  if (sequence.current === null || sequence.current.key !== resetKey || criticalRestart) {
    const resume = rotating && pageCount > 0 && !criticalRestart ? rotationCursor % pageCount : 0;
    sequence.current = { id: (sequence.current?.id ?? 0) + 1, key: resetKey, start: resume };
  }
  const { id: sequenceId, start } = sequence.current;

  const steps = advance.sequence === sequenceId ? advance.steps : 0;
  const activePageIndex = pageCount > 0 ? (start + steps) % pageCount : 0;

  // Measurement: on mount, when the first hosts arrive and when `layoutKey` changes (all before
  // paint), then on every ResizeObserver delivery for the region (or, without ResizeObserver, on
  // window resize coalesced to one frame).
  const hasHosts = pageCount > 0;
  // Startup settle: the first page timer waits for one ResizeObserver delivery (the region's settled
  // size after the chrome above it and the page offset land) and for web fonts (bounded), so the
  // first sequence runs on settled metrics instead of restarting a moment later.
  const [regionSettled, setRegionSettled] = useState(false);
  // `document.fonts.status` can read "loaded" before the lazily loaded face is even requested, so
  // the gate asks for the wall's own face (check/load) after the first layout, bounded at 1 s.
  const [fontsSettled, setFontsSettled] = useState(() => documentFonts() === null);
  useEffect(() => {
    if (fontsSettled) return undefined;
    const fonts = documentFonts();
    if (fontsSettledNow(fonts)) {
      setFontsSettled(true);
      return undefined;
    }
    let live = true;
    let handle: number | null = null;
    const done = (): void => {
      if (live) setFontsSettled(true);
    };
    try {
      handle = clock.setTimeout(done, KIOSK_FONT_WAIT_MS);
    } catch {
      handle = null;
    }
    try {
      const wait = typeof fonts?.load === "function" ? fonts.load(KIOSK_FONT).then(() => fonts.ready) : fonts?.ready;
      wait?.then(done, done);
    } catch {
      done();
    }
    return () => {
      live = false;
      if (handle !== null) {
        try {
          clock.clearTimeout(handle);
        } catch {
          // Nothing left to cancel.
        }
      }
    };
    // Mount-only: once settled it stays settled.
  }, []);
  useLayoutEffect(() => {
    let live = true;
    let frame: number | null = null;
    const measure = (): void => {
      frame = null;
      if (!live) return;
      let next: number = MIN_KIOSK_CAPACITY;
      try {
        next = kioskCapacity(readKioskGridMetrics(regionRef.current, gridRef.current));
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
    const region = regionRef.current;
    try {
      const RO = globalThis.ResizeObserver;
      if (typeof RO !== "function" || region === null) throw new Error("ResizeObserver unavailable");
      // ResizeObserver already delivers once per frame, after layout: measure right away.
      observer = new RO(() => {
        measure();
        if (live) setRegionSettled(true);
      });
      observer.observe(region);
    } catch {
      // Bounded fallback: keep the current (≥1) capacity and re-measure on window resize.
      observer = null;
    }
    if (observer === null) setRegionSettled(true);
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
  }, [regionRef, gridRef, hasHosts, layoutKey]);

  const measured = capacity !== null;
  const ready = measured && regionSettled && fontsSettled;
  const lastOfVisit = rotating && steps + 1 >= visitPages;

  // When the visible page appeared (its sequence started or the wall advanced to it).
  const visibleSince = useRef<{ readonly sequence: number; readonly page: number; readonly at: number } | null>(null);
  if (visibleSince.current?.sequence !== sequenceId || visibleSince.current.page !== activePageIndex) {
    visibleSince.current = { sequence: sequenceId, page: activePageIndex, at: clock.now() };
  }
  // A visit's last page counts as shown after half the shorter of the page and rotation dwells: the
  // shell may advance the view right at its dwell's end, which can be sooner than a page dwell.
  const lastPageShownMs = Math.floor(Math.min(pageDwellMs, rotationDwell ?? pageDwellMs) / 2);

  // Page timer: one armed boundary at a time; each page keeps its full dwell from when it appeared.
  // Inside a rotation the resume cursor records only pages actually shown: a page that ran its full
  // dwell, or the visit's last page once it has been up for `lastPageShownMs` — checked when its
  // timer fires and again when the view leaves (the effect cleanup), since a short rotation dwell can
  // end the visit first. A re-measure or resize mid-visit therefore never skips a page.
  useEffect(() => {
    if (!ready || pageCount <= 1) return undefined;
    let live = true;
    let handle: number | null = null;
    const shown = activePageIndex;
    const since = visibleSince.current?.at ?? clock.now();
    const record = (): void => {
      if (rotating) rotationCursor = (shown + 1) % pageCount;
    };
    try {
      handle = clock.setTimeout(
        () => {
          handle = null;
          if (!live) return;
          record();
          if (!lastOfVisit) setAdvance({ sequence: sequenceId, steps: steps + 1 });
        },
        lastOfVisit ? Math.max(0, lastPageShownMs - (clock.now() - since)) : pageDwellMs,
      );
    } catch {
      // Timer failure: the current page stays visible; no false progress is reported.
      handle = null;
    }
    return () => {
      live = false;
      if (lastOfVisit && clock.now() - since >= lastPageShownMs) record();
      if (handle === null) return;
      try {
        clock.clearTimeout(handle);
      } catch {
        // A throwing clear leaves the callback guarded by `live`.
      }
      handle = null;
    };
  }, [sequenceId, ready, pageCount, steps, rotating, lastOfVisit, activePageIndex, pageDwellMs, lastPageShownMs, clock]);

  return {
    pages,
    activePageIndex,
    capacity: effectiveCapacity,
    pageDwellMs,
    indicatorLabel: kioskIndicatorLabel(activePageIndex, pageCount),
  };
}
