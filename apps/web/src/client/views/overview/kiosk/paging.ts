// apps/web/src/client/views/overview/kiosk/paging.ts — pure kiosk partition, schedule and
// capacity-fit helpers.
//
// No DOM, timers or React here: the hook in ./useKioskPaging.ts reads layout and owns timing.

import type { HostStatus } from "@pulse/web-data/wire";
import type { KioskPage, OverviewGroup, PageScheduleEntry } from "../model.js";

/** Default complete cycle for a kiosk that is not participating in shell rotation. */
export const NON_ROTATING_KIOSK_CYCLE_MS = 30_000 as const;

/** Capacity always remains positive, including before or without browser measurement. */
export const MIN_KIOSK_CAPACITY = 1 as const;

/** `Math.max(1, Math.floor(capacity))`; non-finite input becomes one. */
export function normalizeKioskCapacity(capacity: number): number {
  if (!Number.isFinite(capacity)) return MIN_KIOSK_CAPACITY;
  return Math.max(MIN_KIOSK_CAPACITY, Math.floor(capacity));
}

type GroupStart = KioskPage["groupStarts"][number];

/** Partition ordered grouped hosts into complete deterministic pages. */
export function buildKioskPages(
  groups: readonly OverviewGroup[],
  capacity: number,
): readonly KioskPage[] {
  const size = normalizeKioskCapacity(capacity);
  const pages: KioskPage[] = [];
  let hosts: HostStatus[] = [];
  let starts: GroupStart[] = [];

  const flush = (): void => {
    if (hosts.length === 0) return;
    pages.push(Object.freeze({ index: pages.length, hosts: Object.freeze(hosts), groupStarts: Object.freeze(starts) }));
    hosts = [];
    starts = [];
  };

  for (const group of groups) {
    let first = true;
    for (const host of group.hosts) {
      if (hosts.length === size) flush();
      // A heading opens the group and repeats on every continuation page.
      if (first || hosts.length === 0) {
        starts.push(Object.freeze({ groupId: group.id, label: group.label, hostOffset: hosts.length }));
      }
      first = false;
      hosts.push(host);
    }
  }
  flush();
  return Object.freeze(pages);
}

/** Build zero-based page start offsets inside one dwell/cycle. */
export function pageSchedule(pageCount: number, dwellMs: number): readonly PageScheduleEntry[] {
  if (!Number.isInteger(pageCount) || pageCount <= 0) return [];
  if (!Number.isFinite(dwellMs) || dwellMs <= 0) return [];
  // Every page needs a distinct whole-millisecond start strictly inside the dwell.
  if (pageCount > Math.floor(dwellMs)) return [];
  return Object.freeze(
    Array.from({ length: pageCount }, (_, pageIndex) =>
      Object.freeze({ pageIndex, startsAtMs: Math.floor((pageIndex * dwellMs) / pageCount) }),
    ),
  );
}

/** Rendered dimensions read from the kiosk viewport and the inert measurement probe. */
export interface KioskFitMetrics {
  /** Viewport `clientWidth` available to one page. */
  readonly width: number;
  /** Viewport `clientHeight` available to one page. */
  readonly height: number;
  /** Rendered width of one representative host cell. */
  readonly cellWidth: number;
  /** Rendered height of one representative host cell. */
  readonly cellHeight: number;
  /** Rendered height of one group heading (zero when the probe has none). */
  readonly headingHeight: number;
  /** Computed grid column gap. */
  readonly columnGap: number;
  /** Computed grid row gap, also used between group sections. */
  readonly rowGap: number;
}

function validMetrics(m: KioskFitMetrics): boolean {
  const positive = [m.width, m.height, m.cellWidth, m.cellHeight];
  const nonNegative = [m.headingHeight, m.columnGap, m.rowGap];
  return positive.every((v) => Number.isFinite(v) && v > 0) && nonNegative.every((v) => Number.isFinite(v) && v >= 0);
}

function columnsFor(m: KioskFitMetrics): number {
  return Math.floor((m.width + m.columnGap) / (m.cellWidth + m.columnGap));
}

/** True when every group section of `page` (heading + wrapped cell rows) fits the viewport. */
export function kioskPageFits(page: KioskPage, metrics: KioskFitMetrics): boolean {
  if (!validMetrics(metrics)) return false;
  const columns = columnsFor(metrics);
  if (columns < 1) return false;
  let used = 0;
  page.groupStarts.forEach((start, i) => {
    const end = page.groupStarts[i + 1]?.hostOffset ?? page.hosts.length;
    const rows = Math.ceil((end - start.hostOffset) / columns);
    if (i > 0) used += metrics.rowGap;
    used += metrics.headingHeight + rows * metrics.cellHeight + Math.max(0, rows - 1) * metrics.rowGap;
  });
  return used <= metrics.height;
}

/**
 * Largest capacity whose every page fits. The geometric `columns × rows` estimate is an
 * upper bound (headings only consume extra height), so the search only decrements from it; it is
 * also capped at the host count. Invalid/unavailable metrics yield `MIN_KIOSK_CAPACITY`.
 */
export function fitKioskCapacity(groups: readonly OverviewGroup[], metrics: KioskFitMetrics | null): number {
  if (metrics === null || !validMetrics(metrics)) return MIN_KIOSK_CAPACITY;
  const columns = columnsFor(metrics);
  const rows = Math.floor((metrics.height + metrics.rowGap) / (metrics.cellHeight + metrics.rowGap));
  if (columns < 1 || rows < 1) return MIN_KIOSK_CAPACITY;
  const total = groups.reduce((n, g) => n + g.hosts.length, 0);
  let candidate = Math.max(MIN_KIOSK_CAPACITY, Math.min(columns * rows, total));
  while (candidate > MIN_KIOSK_CAPACITY && !buildKioskPages(groups, candidate).every((p) => kioskPageFits(p, metrics))) {
    candidate -= 1;
  }
  return candidate;
}

/** Split a page's hosts at its recorded group starts; never re-infers groups from hosts. */
export function pageSegments(page: KioskPage): { readonly groupId: string; readonly label: string; readonly hosts: readonly HostStatus[] }[] {
  return page.groupStarts.map((start, i) => ({
    groupId: start.groupId,
    label: start.label,
    hosts: page.hosts.slice(start.hostOffset, page.groupStarts[i + 1]?.hostOffset ?? page.hosts.length),
  }));
}
