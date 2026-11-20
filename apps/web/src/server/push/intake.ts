// Serial webhook intake: parsed notifications are planned one per timer tick, in arrival order, and each call's
// planned items are enqueued before the next call is planned.

import { log } from "../log.js";
import { recordPushNotification } from "../routes/metrics.js";
import type { DeviceQueues, Timers } from "./dispatch/queue.js";
import type { Clock } from "./ids.js";
import type { NotifiedMemory } from "./memory.js";
import { planDeliveries } from "./plan.js";
import type { DeviceStore } from "./registry/store.js";
import type { AmNotification } from "./webhook.js";

/** Collaborators. Bootstrap builds one intake per configured runtime. */
export interface IntakeDeps {
  /** Device source; read at plan time, never at submit time. */
  readonly store: DeviceStore;
  /** The single notified memory shared with the queues. */
  readonly memory: NotifiedMemory;
  /** Per-device FIFOs. */
  readonly queues: DeviceQueues;
  /** Badge source, read once per planned call. */
  readonly badge: () => number | null;
  /** Clock for the plan's `nowMs`. */
  readonly clock: Clock;
  /** Injectable timers; the drain is scheduled with `timers.setTimeout(fn, 0)`. */
  readonly timers: Timers;
}

/** The serial planner/enqueuer. */
export interface Intake {
  /**
   * Append a parsed notification to the pending FIFO and, if no drain is scheduled, schedule one. Synchronous, O(1),
   * never throws, never plans.
   *
   * @param notification - A validated notification.
   */
  submit(notification: AmNotification): void;
  /** Number of submitted calls not yet planned. */
  pending(): number;
  /** Resolves once the pending FIFO is empty and no drain is scheduled. */
  idle(): Promise<void>;
  /** Cancel the scheduled drain and discard pending calls without planning or counting them. */
  close(): void;
}

/**
 * Create the serial intake. One drain tick plans exactly one notification and reschedules itself while more are
 * pending, so the event loop gets a turn between calls without changing their order.
 *
 * @param deps - Collaborators.
 * @returns An Intake. After close(), submit() is a silent no-op.
 */
export function createIntake(deps: IntakeDeps): Intake {
  const pendingFifo: AmNotification[] = [];
  let scheduled: unknown = null;
  let closed = false;
  let waiters: Array<() => void> = [];

  const settleIdle = (): void => {
    if (pendingFifo.length > 0 || scheduled !== null) return;
    const ready = waiters;
    waiters = [];
    for (const resolve of ready) resolve();
  };

  const schedule = (): void => {
    scheduled = deps.timers.setTimeout(drainOne, 0);
  };

  function drainOne(): void {
    scheduled = null;
    const notification = pendingFifo.shift();
    if (notification === undefined) {
      settleIdle();
      return;
    }
    try {
      // Everything is read at plan time: the device list, the badge and the clock.
      const devices = deps.store.list();
      const ctx = { badge: deps.badge(), nowMs: deps.clock.nowMs() };
      const plan = planDeliveries(notification, devices, deps.memory, ctx);
      for (const [kind, n] of plan.filtered) if (n > 0) recordPushNotification(kind, "filtered", n);
      // Enqueue in the same synchronous block, so no other call is planned in between.
      const items = [...plan.perDevice.values()].flat();
      if (items.length > 0) deps.queues.enqueue(items);
    } catch {
      // A throw here is a bug. Skip this call and keep draining; never crash the server.
      log({ event: "push_internal_error", ok: false, route: "intake" });
    } finally {
      if (pendingFifo.length > 0 && !closed) schedule();
      settleIdle();
    }
  }

  return {
    submit(notification) {
      if (closed) return;
      pendingFifo.push(notification);
      if (scheduled === null) schedule();
    },
    pending() {
      return pendingFifo.length;
    },
    idle() {
      if (pendingFifo.length === 0 && scheduled === null) return Promise.resolve();
      return new Promise<void>((resolve) => {
        waiters.push(resolve);
      });
    },
    close() {
      if (closed) return;
      closed = true;
      if (scheduled !== null) deps.timers.clearTimeout(scheduled);
      scheduled = null;
      pendingFifo.length = 0;
      settleIdle();
    },
  };
}
