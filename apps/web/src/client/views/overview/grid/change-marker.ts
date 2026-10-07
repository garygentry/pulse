// apps/web/src/client/views/overview/grid/change-marker.ts — accepted status-transition markers.
//
// State is keyed by canonical drilldownId and holds only the last observed status per id, so
// group/sort/page reorder and component remount never read as a change.

import { useEffect, useRef, useState } from "react";

import type { TargetStatus } from "@pulse/web-data/wire";
import type { ChangeTracker, StatusChange } from "../model.js";

/** Marker visibility window; animation duration still comes from semantic motion tokens. */
export const STATUS_CHANGE_MARKER_WINDOW_MS = 1_200 as const;

/** One tracker per mounted overview. */
export function createChangeTracker(): ChangeTracker {
  const lastStatus = new Map<string, TargetStatus>();
  return {
    observe(drilldownId, status, reducedMotion) {
      const previous = lastStatus.get(drilldownId);
      lastStatus.set(drilldownId, status);
      if (previous === undefined || previous === status) return null;
      return Object.freeze({
        drilldownId,
        previous,
        current: status,
        marker: reducedMotion ? "static" : "animated",
      });
    },
    retain(ids) {
      for (const id of [...lastStatus.keys()]) {
        if (!ids.has(id)) lastStatus.delete(id);
      }
    },
    clear() {
      lastStatus.clear();
    },
  };
}

/** Observe one accepted status and retain its bounded marker state for rendering. */
export function useStatusChangeMarker(
  tracker: ChangeTracker,
  drilldownId: string,
  status: TargetStatus,
  reducedMotion: boolean,
): StatusChange | null {
  const [change, setChange] = useState<StatusChange | null>(null);
  // The marker as last rendered or queued. A no-op `setChange(null)` is skipped: React keeps even a
  // same-value update queued, and it costs the cell an extra render on its next status commit.
  // Queued updates are tracked too, so StrictMode's same-commit effect re-run clears a marker the
  // first run queued (its timer was cancelled by the cleanup in between).
  const rendered = useRef(change);
  rendered.current = change;
  const queue = (value: StatusChange | null): void => {
    rendered.current = value;
    setChange(value);
  };

  useEffect(() => {
    const next = tracker.observe(drilldownId, status, reducedMotion);
    // A re-run without a transition (e.g. motion mode flip) drops any marker whose timer the
    // previous cleanup cancelled, so a marker never outlives its window.
    if (next !== null || rendered.current !== null) queue(next);
    if (next === null) return undefined;
    // Timers are read from globalThis at call time so tests can substitute a fake clock.
    let handle: ReturnType<typeof globalThis.setTimeout> | null = globalThis.setTimeout(() => {
      handle = null;
      queue(null);
    }, STATUS_CHANGE_MARKER_WINDOW_MS);
    return () => {
      if (handle === null) return;
      globalThis.clearTimeout(handle);
      handle = null;
    };
  }, [tracker, drilldownId, status, reducedMotion]);

  return change;
}

/** The marker kind a target exposes as `data-changed` for the bounded window, or undefined without one. */
export function changeMarkerAttribute(change: StatusChange | null): StatusChange["marker"] | undefined {
  return change === null ? undefined : change.marker;
}
