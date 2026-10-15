// packages/core/src/endpoint-alert/index.ts — the timing an endpoint alert binding renders with
// (the `@pulse/core/endpoint-alert` subpath; dependency-free so the browser bundle can import it).
//
// A binding (schema/service.ts `endpointAlertSchema`) renders one vmalert `GatusCheckFailed` rule.
// stack/alerting builds the rule from these values (its `GATUS_CHECKS`), and the web estate entity
// page describes the binding from the same values, so the two cannot drift.

/** Shared endpoint-alert timing (docs/operator/alerting.md). */
export const ENDPOINT_ALERT_TIMING = {
  /** Gatus's default endpoint interval in seconds (the renderer emits none). */
  checkIntervalSeconds: 60,
  /** Failed checks needed to fire when a binding omits `failure_threshold`. */
  defaultFailureThreshold: 3,
  /** Passing checks needed to resolve when a binding omits `success_threshold`. */
  defaultSuccessThreshold: 2,
  /** The clear window holds this many times S checks (rounded up) plus one interval, so S passes
   *  still fit in it when checks run somewhat slower than nominal (default S = 2 → 4m). */
  clearWindowFactor: 1.5,
} as const;

/**
 * The clear window, in seconds, for a success threshold S: ceil(`clearWindowFactor`·S)·I + I.
 * The firing rule resolves once this window holds ≥ S passing checks and no failed check.
 */
export function endpointAlertClearWindowSeconds(successThreshold: number): number {
  const T = ENDPOINT_ALERT_TIMING;
  return Math.ceil(T.clearWindowFactor * successThreshold) * T.checkIntervalSeconds + T.checkIntervalSeconds;
}
