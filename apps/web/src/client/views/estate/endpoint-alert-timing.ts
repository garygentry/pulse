// src/client/views/estate/endpoint-alert-timing.ts — the timing a declared endpoint-alert binding's
// vmalert `GatusCheckFailed` rule renders with (docs/operator/alerting.md).
//
// A browser-side copy of stack/alerting's `GATUS_CHECKS` (the client bundle may not import server
// packages). tests/estate-endpoint-alert-timing.test.ts pins every value and the clear-window formula
// to stack/alerting/src/constants.ts, so the entity page's wording cannot drift from the rule.

/** The subset of stack/alerting `GATUS_CHECKS` the entity page describes a binding with. */
export const ENDPOINT_ALERT_TIMING = {
  /** Gatus's default endpoint interval in seconds (the renderer emits none). */
  checkIntervalSeconds: 60,
  /** Failed checks needed to fire when a binding omits `failureThreshold`. */
  defaultFailureThreshold: 3,
  /** Passing checks needed to resolve when a binding omits `successThreshold`. */
  defaultSuccessThreshold: 2,
  /** The clear window holds this many times S checks (rounded up) plus one interval. */
  clearWindowFactor: 1.5,
} as const;

/** The clear window in seconds for success threshold S: ceil(`clearWindowFactor`·S)·I + I. A firing
 *  rule resolves once this window holds ≥ S passing checks and no failed check. */
export function clearWindowSeconds(successThreshold: number): number {
  const T = ENDPOINT_ALERT_TIMING;
  return Math.ceil(T.clearWindowFactor * successThreshold) * T.checkIntervalSeconds + T.checkIntervalSeconds;
}
