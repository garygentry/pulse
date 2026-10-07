// src/client/views/estate/status.ts — HealthState → TargetStatus mapping for the estate view
// (spec 00 §3, 06 §3; REQ-A11Y-01, invariants I3/I4).
//
// Single source of truth for every status glyph/label the estate surfaces show. Computes only;
// it never renders — consumers render the result through StatusBadge and the `@/ui` status maps,
// which emit `data-status` + icon + label text (never color alone, I4).

import type { DataAvailability, HealthState, TargetStatus } from "@pulse/web-data/wire";

import { STATUS_LABEL } from "../../a11y/index.js";
import { HEALTH_TO_STATUS } from "../../status/target-status.js";

/** Human note for each non-`current` availability state (06 §3.1 precedence 2). Keyed by
 *  `Exclude<…, "current">` so a new availability state without a note is a typecheck error. */
const AVAILABILITY_NOTE: Record<Exclude<DataAvailability["state"], "current">, string> = {
  stale: "Live state is stale",
  unavailable: "Live state unavailable",
  "not-configured": "Live state not configured",
};

/**
 * Map a live target's wire health, its declared suppression, and its data availability into the
 * `TargetStatus` the view renders through the `TARGET_STATUS` map.
 *
 * Precedence (highest first): suppression → non-current availability → raw health. NEVER returns
 * `ok` when the entity is suppressed or its availability is not `current` (invariant I3).
 *
 * @returns The resolved status plus a human `staleNote` (`null` unless a non-current availability
 *          forced `unknown`).
 */
export function toTargetStatus(input: {
  readonly health: HealthState;
  readonly suppressed: boolean;
  readonly availability: DataAvailability["state"];
}): { readonly status: TargetStatus; readonly staleNote: string | null } {
  // 1. Suppression overrides everything (I3 — suppressed is never ok).
  if (input.suppressed) {
    return { status: "suppressed", staleNote: null };
  }
  // 2. Any non-current availability forces `unknown` + a note (I3 — never silent-green). This
  //    widens 00 §3's {stale, unavailable} row to every non-current state (06 §3.1).
  if (input.availability !== "current") {
    return { status: "unknown", staleNote: AVAILABILITY_NOTE[input.availability] };
  }
  // 3. Otherwise map the raw wire health.
  return { status: HEALTH_TO_STATUS[input.health], staleNote: null };
}

/** SR/visual label for a resolved status — a thin wrapper over the a11y contract STATUS_LABEL so
 *  every surface labels status the same way. */
export function statusLabel(status: TargetStatus): string {
  return STATUS_LABEL[status];
}

/** Human phrase for the RAW wire health, including the "not configured" nuance that
 *  toTargetStatus collapses to `unknown`. For entity-page detail/tooltips; the status glyph's
 *  label still comes from statusLabel. */
export function describeHealth(health: HealthState): string {
  switch (health) {
    case "healthy":
      return "healthy";
    case "unhealthy":
      return "unhealthy";
    case "unknown":
      return "unknown";
    case "not-configured":
      return "not configured";
  }
}
