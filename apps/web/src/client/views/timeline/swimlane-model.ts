// Pure alert-swimlane model: the swimlane readout order, per-severity row text and fill status, and
// the interval description and /alerts link used by the tooltip, readout, pinned list and keyboard.
import type { EstateClock } from "../../format.js";
import { findLane } from "./model.js";
import type { LaneTree as LaneTreeModel } from "./model.js";
import { UNMATCHED_TARGET_TEXT } from "./swimlane-pack.js";
import type { SwimInterval, SwimSeverity } from "./swimlane-pack.js";
import { isoOf } from "./lanes-model.js";
import { targetRef } from "../../target-ref.js";

/** Readout order of the swimlane source: after every lane block, before the charts. */
export const SWIMLANE_READOUT_ORDER = 500;

/** Row heading text per severity. */
export const SWIM_ROW_TEXT: Readonly<Record<SwimSeverity, string>> = {
  critical: "Critical", warning: "Warning", info: "Info", unknown: "Unknown severity",
};

/**
 * The interval description used by the tooltip, the readout, the pinned list and announcements:
 * "{alertname} — {target} — {start} → {end}", with times in estate time (clock.format).
 * {target} is the lane label (findLane) for attributed targets in the tree; UNMATCHED_TARGET_TEXT
 * when interval.unmatched is true (with " ({targetRef})" appended when the target is non-null but not
 * in the tree). All parts are plain text. Pure.
 */
export function swimIntervalText(interval: SwimInterval, tree: LaneTreeModel | null, clock: EstateClock): string {
  const t = interval.target;
  let target: string;
  if (interval.unmatched) {
    target = t === null ? UNMATCHED_TARGET_TEXT : `${UNMATCHED_TARGET_TEXT} (${targetRef(t)})`;
  } else if (t === null) {
    target = UNMATCHED_TARGET_TEXT;
  } else {
    target = (tree !== null ? findLane(tree, t)?.label : undefined) ?? targetRef(t);
  }
  return `${interval.alertname} — ${target} — ${clock.format(isoOf(interval.start))} → ${clock.format(isoOf(interval.end))}`;
}

/**
 * The /alerts link for an interval. Attributed (target !== null):
 * `/alerts?hs=${encodeURIComponent(targetRef(target))}` — alert-triage's existing
 * host/service facet, whose values are canonical target refs (GitHub #10). Unattributed
 * (target === null): `/alerts?sev=${encodeURIComponent(severity)}`. No new triage query keys. Pure.
 */
export function swimIntervalHref(interval: SwimInterval): string {
  const t = interval.target;
  return t !== null
    ? `/alerts?hs=${encodeURIComponent(targetRef(t))}`
    : `/alerts?sev=${encodeURIComponent(interval.severity)}`;
}
