// apps/web/src/client/views/overview/kiosk/paging.ts — pure kiosk capacity, partition and timing
// helpers.
//
// No DOM, timers or React here: the hook in ./useKioskPaging.ts reads layout and owns timing.
// Kiosk tiles have one fixed height and the tile grid fixes its column tracks, so capacity is plain
// arithmetic (columns × rows) over the measured grid region — there is no representative-card probe.

import type { HostStatus } from "@pulse/web-data/wire";
import type { KioskPage } from "../model.js";

/**
 * Base cycle for a kiosk that is not in a shell rotation: up to three pages share it. Past that the
 * cycle grows with the page count, because no page is shown for less than `KIOSK_MIN_PAGE_DWELL_MS`.
 */
export const NON_ROTATING_KIOSK_CYCLE_MS = 30_000 as const;

/** Shortest time any kiosk page stays on screen, so a wallboard can be read from across a room. */
export const KIOSK_MIN_PAGE_DWELL_MS = 10_000 as const;

/** Capacity always remains positive, including before or without browser measurement. */
export const MIN_KIOSK_CAPACITY = 1 as const;

/** `Math.max(1, Math.floor(capacity))`; non-finite input becomes one. */
export function normalizeKioskCapacity(capacity: number): number {
  if (!Number.isFinite(capacity)) return MIN_KIOSK_CAPACITY;
  return Math.max(MIN_KIOSK_CAPACITY, Math.floor(capacity));
}

/** Rendered geometry of the kiosk tile grid. */
export interface KioskGridMetrics {
  /** Height of the region the tile grid may fill (its `clientHeight`). */
  readonly height: number;
  /** Column tracks the grid laid out (its computed `grid-template-columns` track count). */
  readonly columns: number;
  /** The fixed tile row height (its computed `grid-auto-rows`). */
  readonly rowHeight: number;
  /** Computed grid row gap. */
  readonly rowGap: number;
}

/** Rows of fixed-height tiles that fit `height`; at least one. */
export function kioskRows(metrics: KioskGridMetrics): number {
  const { height, rowHeight, rowGap } = metrics;
  if (!(Number.isFinite(height) && height > 0 && Number.isFinite(rowHeight) && rowHeight > 0)) return 1;
  const gap = Number.isFinite(rowGap) && rowGap > 0 ? rowGap : 0;
  return Math.max(1, Math.floor((height + gap) / (rowHeight + gap)));
}

/** Tiles per page: columns × rows; `MIN_KIOSK_CAPACITY` when the metrics are unavailable. */
export function kioskCapacity(metrics: KioskGridMetrics | null): number {
  if (metrics === null || !Number.isInteger(metrics.columns) || metrics.columns < 1) return MIN_KIOSK_CAPACITY;
  return normalizeKioskCapacity(metrics.columns * kioskRows(metrics));
}

/** Partition the ordered hosts into consecutive pages of `capacity` (the last may be short). */
export function buildKioskPages(hosts: readonly HostStatus[], capacity: number): readonly KioskPage[] {
  const size = normalizeKioskCapacity(capacity);
  const pages: KioskPage[] = [];
  for (let start = 0; start < hosts.length; start += size) {
    pages.push(Object.freeze({ index: pages.length, hosts: Object.freeze(hosts.slice(start, start + size)) }));
  }
  return Object.freeze(pages);
}

/**
 * How long each page stays up: the cycle (the overview's rotation dwell, else
 * `NON_ROTATING_KIOSK_CYCLE_MS`) split across the pages, never below `KIOSK_MIN_PAGE_DWELL_MS`.
 */
export function kioskPageDwell(pageCount: number, rotationDwellMs: number | null): number {
  const cycle = rotationDwellMs ?? NON_ROTATING_KIOSK_CYCLE_MS;
  if (!Number.isInteger(pageCount) || pageCount < 1) return Math.max(KIOSK_MIN_PAGE_DWELL_MS, cycle);
  return Math.max(KIOSK_MIN_PAGE_DWELL_MS, Math.floor(cycle / pageCount));
}

/**
 * Pages one rotation visit shows: as many whole page dwells as fit the rotation dwell (at least one,
 * at most every page). The rest are shown on later visits.
 */
export function kioskPagesPerVisit(pageCount: number, rotationDwellMs: number): number {
  if (!Number.isInteger(pageCount) || pageCount < 1) return 0;
  const dwell = kioskPageDwell(pageCount, rotationDwellMs);
  return Math.min(pageCount, Math.max(1, Math.floor(rotationDwellMs / dwell)));
}
