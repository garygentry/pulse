// Persistent-staleness gate shared by /engine and /timeline (02 §6, tech-spec §3.1, REQ-EFRESH-02):
// the pure isNotCurrent predicate and the useNotCurrent hook that drives it from render.

import { useEffect, useRef, useState } from "react";
import type { ViewDeliveryState } from "@pulse/web-data/wire";
import type { ConnectionPhase } from "../../../../store/types.js";
import { REFRESH_INTERVAL_MS } from "../../../../../shared/constants.js";

/** Inputs to the pure persistent-staleness predicate (tech-spec §3.1). */
export interface FreshnessInput {
  /** `store.connection.value.phase`; `"stale"` means the control channel failed past its window. */
  readonly connectionPhase: ConnectionPhase;
  /** `store.connection.value.views[view].phase`. */
  readonly viewPhase: ViewDeliveryState["phase"];
  /** Epoch ms when `viewPhase` last entered `"stale"`, or null when it is not stale. */
  readonly viewStaleSinceMs: number | null;
  /** Reference time, epoch ms. */
  readonly nowMs: number;
}

/**
 * Persistent-staleness predicate (tech-spec §3.1, REQ-EFRESH-02).
 *
 * Not current iff
 *   input.connectionPhase === "stale"                         (control channel failed past its window), or
 *   input.viewPhase === "stale" && input.viewStaleSinceMs !== null
 *     && input.nowMs − input.viewStaleSinceMs > REFRESH_INTERVAL_MS   (stale for more than one refresh).
 *
 * A view-stale phase shorter than or equal to one refresh interval, or with an unknown start
 * (`viewStaleSinceMs === null`), counts as current. `"initial"` is never "not current" by itself:
 * Loading vs Unknown is decided by the caller (03 §verdict step 1).
 *
 * Pure and total; never throws. Negative elapsed time (clock skew) counts as current.
 *
 * @param input - See FreshnessInput (00 §4.1).
 * @returns true when the view must be presented as not current.
 */
export function isNotCurrent(input: FreshnessInput): boolean {
  if (input.connectionPhase === "stale") return true;
  if (input.viewPhase !== "stale" || input.viewStaleSinceMs === null) return false;
  return input.nowMs - input.viewStaleSinceMs > REFRESH_INTERVAL_MS;
}

/**
 * Track when the view phase entered "stale" and report persistent staleness (tech-spec §3.1).
 *
 * - Records `now()` in a ref on each transition INTO viewPhase "stale"; clears it on any transition
 *   out. A connection-phase change alone does not reset the timestamp.
 * - While the view is stale but not yet past the threshold, schedules exactly one timer for
 *   `staleSince + REFRESH_INTERVAL_MS + 1 − now()` ms. When it fires, it forces a re-render so the
 *   result flips to true without waiting for another store change. The timer is cleared on phase
 *   change and on unmount.
 * - Returns `isNotCurrent({ connectionPhase, viewPhase, viewStaleSinceMs, nowMs: now() })`.
 *
 * Takes plain values, never the store: each view's model.ts is the only store reader.
 *
 * @param connectionPhase - `store.connection.value.phase`, read via the view's model.
 * @param viewPhase - `store.connection.value.views[view].phase`, read via the view's model.
 * @param now - Clock, injectable for tests; defaults to `Date.now`.
 * @returns true when the view is persistently not current.
 */
export function useNotCurrent(
  connectionPhase: ConnectionPhase,
  viewPhase: ViewDeliveryState["phase"],
  now: () => number = Date.now,
): boolean {
  const staleSince = useRef<number | null>(null);
  const [, setTick] = useState(0);

  // Update the transition timestamp during render so the first stale render already has it.
  if (viewPhase === "stale") {
    if (staleSince.current === null) staleSince.current = now();
  } else {
    staleSince.current = null;
  }

  useEffect(() => {
    if (viewPhase !== "stale" || staleSince.current === null) return;
    const remaining = staleSince.current + REFRESH_INTERVAL_MS + 1 - now();
    if (remaining <= 0) return; // already past; this render reports true
    const id = setTimeout(() => setTick((n) => n + 1), remaining);
    return () => clearTimeout(id);
  }, [viewPhase, now]);

  return isNotCurrent({
    connectionPhase,
    viewPhase,
    viewStaleSinceMs: staleSince.current,
    nowMs: now(),
  });
}
