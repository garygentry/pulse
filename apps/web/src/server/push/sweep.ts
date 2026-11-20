// Expiry sweep: removes devices not seen for the expiry period and garbage-collects expired pairing tokens. One pass
// runs at start, then one per sweep interval.

import { log } from "../log.js";
import { PUSH_LIMITS } from "./constants.js";
import type { Timers } from "./dispatch/queue.js";
import type { Clock } from "./ids.js";
import type { PairingService } from "./pairing.js";
import type { RegistryStore } from "./registry/store.js";

/** Dependencies of the sweep. */
export interface SweepDeps {
  /** The registry the expired devices are removed from. */
  readonly store: RegistryStore;
  /** The pairing service whose expired tokens are collected. */
  readonly pairing: PairingService;
  /** Time source for the expiry cutoff. */
  readonly clock: Clock;
  /** Schedules the periodic pass. */
  readonly timers: Timers;
}

/** Outcome of one sweep pass. */
export interface SweepResult {
  /** Devices removed as expired; 0 when nothing was due or the write failed. */
  readonly expired: number;
  /** True when the removal write failed (the next pass retries). */
  readonly writeFailed: boolean;
}

/** A running sweep. */
export interface Sweep {
  /** Run one pass now. Concurrent calls share the in-flight pass. */
  runOnce(): Promise<SweepResult>;
  /** Stop the periodic timer. Idempotent. An in-flight pass completes. */
  close(): void;
}

const NOTHING: SweepResult = Object.freeze({ expired: 0, writeFailed: false });
const WRITE_FAILED: SweepResult = Object.freeze({ expired: 0, writeFailed: true });

/**
 * Start the sweep: one pass immediately (not awaited), then every PUSH_LIMITS.sweepIntervalMs through
 * timers.setInterval. A throwing pass is logged as push_internal_error and does not stop the interval.
 */
export function createSweep(deps: SweepDeps): Sweep {
  const { store, pairing, clock, timers } = deps;
  let inflight: Promise<SweepResult> | null = null;
  let handle: unknown = null;
  let closed = false;

  async function pass(): Promise<SweepResult> {
    try {
      pairing.gc();
      const cutoff = clock.nowMs() - PUSH_LIMITS.deviceExpiryMs;
      const r = await store.mutate<number>((devices) => {
        const kept = devices.filter((d) => !(Date.parse(d.seenAt) < cutoff));
        if (kept.length === devices.length) return { kind: "abort", result: 0 };
        return { kind: "commit", devices: kept, result: devices.length - kept.length };
      }, "expired");
      if (!r.ok) return WRITE_FAILED;
      return r.result === 0 ? NOTHING : { expired: r.result, writeFailed: false };
    } catch {
      log({ event: "push_internal_error", ok: false, route: "sweep" });
      return NOTHING;
    }
  }

  function runOnce(): Promise<SweepResult> {
    if (inflight !== null) return inflight;
    const p = pass().finally(() => {
      if (inflight === p) inflight = null;
    });
    inflight = p;
    return p;
  }

  void runOnce();
  handle = timers.setInterval(() => {
    if (!closed) void runOnce();
  }, PUSH_LIMITS.sweepIntervalMs);

  return {
    runOnce,
    close() {
      if (closed) return;
      closed = true;
      timers.clearInterval(handle);
      handle = null;
    },
  };
}
