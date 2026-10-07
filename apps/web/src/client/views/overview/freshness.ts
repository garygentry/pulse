// freshness.ts — top-level overview surface state and per-target effective status.
// Pure module: reads the existing AppStore signals only. It owns no cadence, stale threshold,
// timer, endpoint or transport — freshness configuration stays in live-state. Unknown
// runtime discriminants fail closed to loading/unavailable/stale or `unknown`, never ready or OK.
import type { TargetStatus, TargetStatusEvidence } from "@pulse/web-data/wire";
import type { AppStore } from "../../store/index.js";
import type { OverviewSurfaceState } from "./model.js";

/** Visible copy for the no-snapshot initial / NOT_READY state. */
export const OVERVIEW_LOADING_MESSAGE = "Overview data is not ready yet.";

/** Visible copy for the no-snapshot failed-delivery state. */
export const OVERVIEW_UNAVAILABLE_MESSAGE =
  "The overview feed could not be delivered. Pulse keeps retrying automatically.";

const TARGET_STATUSES: ReadonlySet<string> = new Set<TargetStatus>([
  "ok",
  "warning",
  "critical",
  "unknown",
  "suppressed",
]);

/**
 * Derive the exhaustive top-level overview delivery state from the existing store.
 *
 * - no accepted snapshot, control channel not yet stale (initial contact, NOT_READY responses,
 *   or a live control channel still awaiting its first overview body) → `loading`;
 * - no accepted snapshot and the connection or overview delivery is stale → `unavailable`;
 * - accepted snapshot with overview delivery `current` and connection `live` → `ready`;
 * - any other accepted-snapshot combination (stale/initial delivery, stale or initial
 *   connection, missing observation) → `stale`, retaining the snapshot with `lastGoodAt`.
 */
export function deriveOverviewSurfaceState(store: AppStore): OverviewSurfaceState {
  const snapshot = store.snapshot.value;
  const connection = store.connection.value;
  const connectionPhase: string = connection.phase;
  const deliveryPhase: string = connection.views.overview.phase;

  if (snapshot === null) {
    const loading =
      (connectionPhase === "initial" || connectionPhase === "live") &&
      (deliveryPhase === "initial" || deliveryPhase === "current");
    return loading
      ? { status: "loading", message: OVERVIEW_LOADING_MESSAGE }
      : { status: "unavailable", message: OVERVIEW_UNAVAILABLE_MESSAGE, retryable: true };
  }

  if (deliveryPhase === "current" && connectionPhase === "live" && connection.observation !== null) {
    return { status: "ready", snapshot, stale: false };
  }
  return { status: "stale", snapshot, stale: true, lastGoodAt: validEpoch(connection.lastGoodAt) };
}

/**
 * Apply governing evidence so missing proof can never render nominal health:
 * current evidence keeps its status; any non-current evidence yields `unknown`, except a
 * declared `suppressed` stays `suppressed`. Never promotes stale evidence to `ok`.
 */
export function effectiveStatus(evidence: TargetStatusEvidence): TargetStatus {
  const status: string = evidence.status;
  if (status === "suppressed") return "suppressed";
  const state: string = evidence.availability.state;
  if (state !== "current" || !TARGET_STATUSES.has(status)) return "unknown";
  return evidence.status;
}

function validEpoch(value: number | null): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
