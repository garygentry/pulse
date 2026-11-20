// The badge source: the firing-alert count the web UI shows, read in process from the attached runtime.

import type { ServerRuntime } from "../refresh.js";

/**
 * Current firing-alert count exactly as the web UI shows it, or null when the read model is unavailable.
 *
 * Read in process with no I/O. A null result omits `aps.badge`: before the first cycle, while the estate model has an
 * error, or whenever Alertmanager is not `current` (a stale count is never sent). Never throws; an unexpected throw
 * returns null so planning proceeds without a badge.
 *
 * @param runtime - The attached ServerRuntime, or null before the push runtime has been attached.
 * @returns The length of the overview alert strip (heartbeat excluded, capped at the overview limit), or null.
 */
export function currentBadge(runtime: ServerRuntime | null): number | null {
  if (runtime === null) return null;
  try {
    const ctx = runtime.getContext(null);
    if (ctx.cycle === null) return null;
    if (runtime.getStatus().model.error !== null) return null;
    if (ctx.cycle.observation.sources["alertmanager-alerts"].state !== "current") return null;
    return ctx.cycle.overview.value.alerts.length;
  } catch {
    return null;
  }
}
