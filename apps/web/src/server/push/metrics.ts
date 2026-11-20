// Push-side metric wiring: the snapshot provider that /metrics reads for the pulse_web_push_state,
// pulse_web_push_devices and last-success gauges. Rendering lives in routes/metrics.ts.

import type { PushState } from "@pulse/web-data/wire";

import { setPushMetricsProvider, type PushMetricsSnapshot } from "../routes/metrics.js";
// The last-success instant is held by the delivery monitor, which the queue worker and the test send share.
// It lives for the process only: after a restart the gauge is absent until the first success.
import type { DeliveryMonitor } from "./dispatch/queue.js";
import type { DeviceStore } from "./registry/store.js";

/** What the provider reads. Every field is in-process state; no I/O happens at scrape time. */
export interface PushMetricsSource {
  /** Gateway state of the runtime that installs the provider. */
  readonly state: Exclude<PushState, "disabled">;
  /** The loaded store, or null when misconfigured (no usable registry). */
  readonly store: Pick<DeviceStore, "list"> | null;
  /** The delivery monitor's last-success view. */
  readonly delivery: Pick<DeliveryMonitor, "lastSuccessAtMs">;
}

/**
 * Build the snapshot thunk: `state` from the source, `devices` = every registry record (0 without a store),
 * `lastSuccessAtMs` from the delivery monitor. Allocates only the returned object.
 *
 * @param source - The runtime's in-process state.
 * @returns The provider for `setPushMetricsProvider`.
 */
export function buildPushMetricsProvider(source: PushMetricsSource): () => PushMetricsSnapshot {
  return () => ({
    state: source.state,
    devices: source.store?.list().length ?? 0,
    lastSuccessAtMs: source.delivery.lastSuccessAtMs(),
  });
}

/** The provider most recently installed through {@link installPushMetrics}, or null. */
let current: (() => PushMetricsSnapshot) | null = null;

/**
 * Install the provider and return its uninstall function. Uninstall clears the provider only while this one
 * is still the installed one, so closing an older runtime cannot clear a newer runtime's provider.
 *
 * @param source - The runtime's in-process state.
 * @returns Idempotent uninstall.
 */
export function installPushMetrics(source: PushMetricsSource): () => void {
  const thunk = buildPushMetricsProvider(source);
  current = thunk;
  setPushMetricsProvider(thunk);
  return () => {
    if (current !== thunk) return;
    current = null;
    setPushMetricsProvider(null);
  };
}
