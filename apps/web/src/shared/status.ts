// src/shared/status.ts — the ordering constants and non-colour token contract both tiers depend on.
// The resolution matrix itself (signal × alert × suppression → status)
// is implemented in snapshot/build.ts; only the
// ordering primitives live here.

import type { ActiveAlert, TargetStatus } from "./snapshot.js";

/** Roll-up severity order (REQ-GRID-03): a host cell's `rollup` is the worst of its own status and
 *  all NON-suppressed services. `unknown` DOES propagate (a monitoring gap is visible at a glance);
 *  `suppressed` contributes nothing to roll-up (charter invariant 6). Higher index = more severe. */
export const ROLLUP_ORDER: readonly TargetStatus[] = ["ok", "unknown", "warning", "critical"];

/** Active-alert severity precedence for cell colour (REQ-STATE-02): highest matched severity wins.
 *  `info` is intentionally absent from colouring — it never colours a cell. */
export const SEVERITY_ORDER: readonly ActiveAlert["severity"][] = ["info", "warning", "critical"];

/**
 * Fold a set of statuses to the most severe under `ROLLUP_ORDER`, ignoring `suppressed` inputs.
 *
 * `suppressed` contributes nothing (it is filtered out before the fold), so a suppressed service
 * never worsens — or improves — a host cell. `unknown` propagates because a monitoring gap must be
 * visible at a glance. When every contributing input is suppressed the cell is itself `suppressed`.
 *
 * @param own - the entity's own status
 * @param services - contributing service statuses (suppressed ones are ignored)
 * @returns the dominant `TargetStatus` for the host cell (REQ-GRID-03)
 */
export function rollup(own: TargetStatus, services: TargetStatus[]): TargetStatus {
  const contributing = [own, ...services].filter((s): s is TargetStatus => s !== "suppressed");
  if (contributing.length === 0) return "suppressed";
  let worst = contributing[0]!;
  for (const status of contributing) {
    if (ROLLUP_ORDER.indexOf(status) > ROLLUP_ORDER.indexOf(worst)) worst = status;
  }
  return worst;
}
