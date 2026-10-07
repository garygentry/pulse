// src/client/views/timeline/swimlane-pack.ts — alert-history severity rows and sub-lane packing
// (05 §6). Pure and DOM-free; never throws. Swimlane identity is AlertHistoryLane.id (CON-07).

import type { AlertHistoryLane, HashId, IntervalHistoryPayload, TargetIdentity } from "@pulse/web-data/wire";
import type { TimeWindow } from "../_shared/timeseries/axis.js";
import { findLane } from "./model.js";
import type { LaneTree } from "./model.js";

// ---------------------------------------------------------------------------
// Types (00 §5.5) and constants (00 §6.3)
// ---------------------------------------------------------------------------

/** Swimlane severity row id (REQ-SWIM-01). */
export type SwimSeverity = AlertHistoryLane["severity"];

/** One firing interval flattened for the swimlane (epoch seconds). */
export interface SwimInterval {
  /** Source lane id (canonical tuple hash, CON-07). */ readonly laneId: HashId;
  /** Alert name (plain text). */ readonly alertname: string;
  /** Severity row. */ readonly severity: SwimSeverity;
  /** Attributed target, or null. */ readonly target: TargetIdentity | null;
  /** True when attribution is "unmatched" or the target is not in the lane tree (REQ-SWIM-03, REQ-LANE-07). */ readonly unmatched: boolean;
  /** Inclusive start, epoch seconds. */ readonly start: number;
  /** Exclusive end, epoch seconds. */ readonly end: number;
}

/** One visual sub-lane within a severity row (REQ-SWIM-02). */
export interface SubLane {
  /** 0-based sub-lane index within the row (< MAX_SUBLANES). */ readonly index: number;
  /** Intervals drawn in this sub-lane; non-overlapping except in the overflow sub-lane. */ readonly intervals: readonly SwimInterval[];
  /** Count of intervals folded into this sub-lane beyond the visible cap ("+k overlapping"); 0 when none. */ readonly overflow: number;
}

/** One severity row. */
export interface SeverityRow {
  /** Row severity. */ readonly severity: SwimSeverity;
  /** Packed sub-lanes (1..MAX_SUBLANES). */ readonly subLanes: readonly SubLane[];
  /** Every interval in the row sorted by (start, end, laneId): the keyboard traversal order (REQ-SWIM-04). */ readonly ordered: readonly SwimInterval[];
}

/** Maximum visible sub-lanes per severity row (REQ-SWIM-02). */
export const MAX_SUBLANES = 4;

// ---------------------------------------------------------------------------
// Text carriers (05 §6.1)
// ---------------------------------------------------------------------------

/** Label for intervals with `unmatched: true`, in tooltip, readout and lane label. */
export const UNMATCHED_TARGET_TEXT = "unmatched target";
/** Overflow badge copy for the last sub-lane: "+{k} overlapping". */
export function overflowText(k: number): string {
  return `+${k} overlapping`;
}
/** Row order (REQ-SWIM-01): critical, warning, info, then unknown only when present. */
export const SWIM_ROW_ORDER: readonly SwimSeverity[] = ["critical", "warning", "info", "unknown"];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** ISO-8601 → epoch seconds, or null when unparseable (never throws). */
function isoToSec(iso: string): number | null {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms / 1000 : null;
}

/** Total order on intervals: start, then end, then laneId (code-unit order). */
function byStartEndLaneId(a: SwimInterval, b: SwimInterval): number {
  if (a.start !== b.start) return a.start - b.start;
  if (a.end !== b.end) return a.end - b.end;
  return a.laneId < b.laneId ? -1 : a.laneId > b.laneId ? 1 : 0;
}

// ---------------------------------------------------------------------------
// buildSeverityRows (05 §6.2) and packSeverityRow (05 §6.3)
// ---------------------------------------------------------------------------

/**
 * Flatten the alert-history payload into severity rows of packed sub-lanes for the visible window.
 * Pure; never throws.
 *
 * Intervals keep their TRUE bounds and are filtered (not truncated) to those intersecting `window`.
 * Unparseable or zero-length intervals are skipped. Rows: critical, warning, info always; unknown
 * only when an unknown-severity interval intersects the window.
 *
 * @param payload - The ready alerts payload.
 * @param tree - The current lane tree, or null (then only attribution decides `unmatched`).
 * @param window - The visible window (axis view).
 * @returns Rows in SWIM_ROW_ORDER, or [] when the payload has no parseable interval at all.
 */
export function buildSeverityRows(
  payload: IntervalHistoryPayload,
  tree: LaneTree | null,
  window: TimeWindow,
): readonly SeverityRow[] {
  const buckets = new Map<SwimSeverity, SwimInterval[]>();
  for (const sev of SWIM_ROW_ORDER) buckets.set(sev, []);
  let any = false;

  for (const lane of payload.lanes) {
    const unmatched =
      lane.attribution === "unmatched" ||
      lane.target === null ||
      (tree !== null && findLane(tree, lane.target) === null);
    for (const iv of lane.intervals) {
      const start = isoToSec(iv.start);
      const end = isoToSec(iv.end);
      if (start === null || end === null || end <= start) continue;
      any = true;
      if (!(end > window.start && start < window.end)) continue;
      const bucket = buckets.get(lane.severity);
      if (bucket === undefined) continue; // out-of-contract severity: no row to hold it
      bucket.push({
        laneId: lane.id, alertname: lane.alertname, severity: lane.severity, target: lane.target,
        unmatched, start, end,
      });
    }
  }

  if (!any) return [];

  const rows: SeverityRow[] = [];
  for (const severity of SWIM_ROW_ORDER) {
    const bucket = buckets.get(severity) ?? [];
    if (severity === "unknown" && bucket.length === 0) continue;
    const ordered = bucket.sort(byStartEndLaneId);
    rows.push({ severity, subLanes: packSeverityRow(ordered), ordered });
  }
  return rows;
}

/**
 * Greedy first-fit packing into at most MAX_SUBLANES sub-lanes so that no two overlapping intervals
 * share a sub-lane (half-open). An interval that fits none is placed in the LAST sub-lane, whose
 * `overflow` counts such intervals; it stays listed so it remains reachable.
 *
 * @param intervals - The row's intervals. Sorted internally by (start, end, laneId); input is not mutated.
 * @returns 1..MAX_SUBLANES sub-lanes; one empty sub-lane for empty input.
 */
export function packSeverityRow(intervals: readonly SwimInterval[]): readonly SubLane[] {
  const sorted = [...intervals].sort(byStartEndLaneId);
  const lanes: { ivs: SwimInterval[]; end: number; overflow: number }[] = [];
  for (const iv of sorted) {
    let placed = false;
    for (const lane of lanes) {
      if (lane.end <= iv.start) {
        lane.ivs.push(iv);
        lane.end = iv.end;
        placed = true;
        break;
      }
    }
    if (placed) continue;
    if (lanes.length < MAX_SUBLANES) {
      lanes.push({ ivs: [iv], end: iv.end, overflow: 0 });
      continue;
    }
    const last = lanes[MAX_SUBLANES - 1]!;
    last.ivs.push(iv);
    last.overflow += 1;
    last.end = Math.max(last.end, iv.end);
  }
  if (lanes.length === 0) return [{ index: 0, intervals: [], overflow: 0 }];
  return lanes.map((l, index) => ({ index, intervals: l.ivs, overflow: l.overflow }));
}
