// Per-device delivery queues and the shared delivery monitor. One FIFO and one worker per device: the worker sends
// only the head, retries it with backoff, and removes it only at a terminal outcome, so later items never overtake
// it. Devices never wait on each other.

import type { LastDelivery } from "@pulse/web-data/wire";
import { createKeyedLogLimiter, log as defaultLog, type LogEvent } from "../../log.js";
import { recordPushNotification } from "../../routes/metrics.js";
import type { ApnsClient, ApnsClassification, ApnsResult } from "../apns/client.js";
import type { ProviderTokenSigner } from "../apns/jwt.js";
import { PUSH_LIMITS } from "../constants.js";
import type { Clock, RandomSource } from "../ids.js";
import type { NotifiedMemory } from "../memory.js";
import { toApnsRequest } from "../payload.js";
import type { NotificationKind, PlannedNotification } from "../plan.js";
import type { RegistryStore } from "../registry/store.js";
import { removeDevice } from "../registry/summary.js";
import { nextDelay } from "./backoff.js";
import { classifyApnsResponse } from "./classify.js";

/** Injectable timers (fake in tests). */
export interface Timers {
  /** Run `fn` once after `ms` milliseconds; returns an opaque handle. */
  setTimeout(fn: () => void, ms: number): unknown;
  /** Cancel a setTimeout handle. */
  clearTimeout(handle: unknown): void;
  /** Run `fn` every `ms` milliseconds; returns an opaque handle. */
  setInterval(fn: () => void, ms: number): unknown;
  /** Cancel a setInterval handle. */
  clearInterval(handle: unknown): void;
}

/** One queued delivery. */
export interface QueueItem {
  /** The planned notification to send. */
  readonly planned: PlannedNotification;
  /** Enqueue time, epoch milliseconds; the retry deadline counts from it. */
  readonly enqueuedAt: number;
  /** Transient attempts so far (an auth-expired re-sign does not count). */
  attempt: number;
}

/** Why an item left a queue without delivery. */
export type DropCause = "deadline" | "overflow";

/** The per-device FIFOs fed by the intake. */
export interface DeviceQueues {
  /** Append in order. Overflow drops the oldest unsent item (counted dropped, unmark-on-drop). */
  enqueue(items: readonly PlannedNotification[]): void;
  /** Remove a device's FIFO without counting (device removed). */
  drop(deviceId: string): void;
  /** Resolves when every queue is empty (tests). */
  idle(): Promise<void>;
  /** Cancel timers and abandon items without counting. */
  close(): void;
}

// ---------------------------------------------------------------------------------------------------------------
// Delivery monitor
// ---------------------------------------------------------------------------------------------------------------

/** Why a delivery failure was logged. */
export type DeliveryFailureClassification = "permanent" | "auth-failed" | "dead-token-unremoved" | "transient-exhausted";

/**
 * Shared delivery bookkeeping for the queues and the test send: the last-success instant for the metrics provider,
 * the auth-failure edge latch, and the per-device log rate limiter. One per runtime.
 */
export interface DeliveryMonitor {
  /** Record a successful hand-off to Apple. Sets lastSuccessAtMs and clears the auth latch. */
  noteSuccess(nowMs: number): void;
  /** Record an APNs response with status other than 403. The provider token was accepted, so the latch clears. */
  noteTokenAccepted(): void;
  /** Record an auth-failed result. Logs `push_apns_auth_failed {status, reason}` only on the false → true edge. */
  noteAuthFailed(status: number, reason: string): void;
  /** `push_delivery_failed`, at most once per device per `PUSH_LIMITS.deliveryFailedLogIntervalMs`. */
  logFailed(
    deviceId: string,
    kind: NotificationKind,
    classification: DeliveryFailureClassification,
    status: number | null,
    reason: string,
  ): void;
  /** `push_delivery_dropped`, rate-limited separately from logFailed with the same interval. */
  logDropped(deviceId: string, kind: NotificationKind, cause: DropCause): void;
  /** Forget a removed device's rate-limit entries. */
  forgetDevice(deviceId: string): void;
  /** Epoch ms of the last successful delivery, or null. Read by the metrics provider. */
  lastSuccessAtMs(): number | null;
}

/** Dependencies of {@link createDeliveryMonitor}. */
export interface DeliveryMonitorDeps {
  /** Time source for the log rate limiter. */
  readonly clock: Clock;
  /** Log sink; defaults to the server's structured `log`. */
  readonly log?: (evt: LogEvent) => void;
}

/**
 * Create the delivery monitor. No log field carries an APNs token, a provider token or payload text; reasons are
 * already sanitised by the classifier.
 *
 * @param deps - Clock and optional log sink.
 * @returns A DeliveryMonitor.
 */
export function createDeliveryMonitor(deps: DeliveryMonitorDeps): DeliveryMonitor {
  const emit = deps.log ?? defaultLog;
  const limiter = createKeyedLogLimiter(PUSH_LIMITS.deliveryFailedLogIntervalMs, () => deps.clock.nowMs());
  let lastSuccess: number | null = null;
  let authFailed = false;

  const monitor: DeliveryMonitor = {
    noteSuccess(nowMs: number): void {
      lastSuccess = nowMs;
      authFailed = false;
    },
    noteTokenAccepted(): void {
      authFailed = false;
    },
    noteAuthFailed(status: number, reason: string): void {
      if (authFailed) return;
      authFailed = true;
      emit({ event: "push_apns_auth_failed", ok: false, status, reason });
    },
    logFailed(deviceId, kind, classification, status, reason): void {
      if (!limiter.allow(`failed|${deviceId}`)) return;
      emit({ event: "push_delivery_failed", ok: false, deviceId, kind, classification, status, reason });
    },
    logDropped(deviceId, kind, cause): void {
      if (!limiter.allow(`dropped|${deviceId}`)) return;
      emit({ event: "push_delivery_dropped", ok: false, deviceId, kind, cause });
    },
    forgetDevice(deviceId: string): void {
      limiter.forget(`failed|${deviceId}`);
      limiter.forget(`dropped|${deviceId}`);
    },
    lastSuccessAtMs: () => lastSuccess,
  };
  return Object.freeze(monitor);
}

// ---------------------------------------------------------------------------------------------------------------
// Per-device queues
// ---------------------------------------------------------------------------------------------------------------

/** Dependencies of the delivery queues. Every field is injected by the push bootstrap. */
export interface DeviceQueuesDeps {
  /** APNs client. The queues never close it. */
  readonly apns: ApnsClient;
  /**
   * Registry. Read at send time; written through touchSoft and removeDevice. The concrete store is required
   * because a dead-token removal needs the reason-carrying mutate.
   */
  readonly store: RegistryStore;
  /** Notified memory, for unmark-on-drop and device clearing. */
  readonly memory: NotifiedMemory;
  /** Provider-token signer. When given, an auth-expired result that reaches the queue also invalidates it. */
  readonly signer?: ProviderTokenSigner;
  /** Shared delivery monitor. */
  readonly monitor: DeliveryMonitor;
  /** Time source for enqueue instants, deadlines and lastDelivery. */
  readonly clock: Clock;
  /** Backoff timers. */
  readonly timers: Timers;
  /** Jitter source for nextDelay. */
  readonly random: RandomSource;
  /** `ApnsSettings.topic`, written as `apns-topic`. */
  readonly topic: string;
}

/** How an item left its queue. `discarded` = device gone or unregistered at send time; `abandoned` = drop/close. */
export type QueueItemFate = "delivered" | "failed" | "dropped" | "token_removed" | "discarded" | "abandoned";

/** Test-only observation hooks. Production passes none. */
export interface DeviceQueuesHooks {
  /** Called once when an item reaches its fate (overflow victims included). */
  onSettled?(item: Readonly<QueueItem>, fate: QueueItemFate): void;
}

interface DeviceQueue {
  readonly deviceId: string;
  /** FIFO. items[0] is the head. */
  readonly items: QueueItem[];
  /** True while the worker owns items[0] (sending it or waiting to retry it). */
  busy: boolean;
  /** Pending backoff timer, if any. */
  retryHandle: unknown;
  /** Wakes the worker early when the queue is dropped or closed during a backoff wait. */
  wake: (() => void) | null;
  /** Set by drop()/close(). Once true, the worker abandons whatever it holds, uncounted. */
  cancelled: boolean;
}

type Step = "next" | "retry" | "exit";

/**
 * Create the per-device delivery queues. They subscribe to `store.onRemoved` immediately (a removed device's FIFO,
 * notified memory and log-limit entries are dropped), and `close()` unsubscribes.
 *
 * @param deps - Collaborators.
 * @param hooks - Test-only observation hooks.
 * @returns DeviceQueues. Nothing it exposes throws or rejects.
 */
export function createDeviceQueues(deps: DeviceQueuesDeps, hooks: DeviceQueuesHooks = {}): DeviceQueues {
  const queues = new Map<string, DeviceQueue>();
  const running = new Set<DeviceQueue>();
  let idleWaiters: Array<() => void> = [];
  let closed = false;

  const settled = (item: QueueItem, fate: QueueItemFate): void => {
    try {
      hooks.onSettled?.(item, fate);
    } catch {
      // A test hook never affects delivery.
    }
  };

  const settleIdle = (): void => {
    if (!closed && (queues.size > 0 || running.size > 0)) return;
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const resolve of waiters) resolve();
  };

  const ld = (id: string, outcome: LastDelivery["outcome"], reason: string | null, now: number): void => {
    deps.store.touchSoft(id, { lastDelivery: { outcome, at: new Date(now).toISOString(), reason } });
  };

  const cancel = (q: DeviceQueue): void => {
    q.cancelled = true;
    if (q.retryHandle !== null) {
      deps.timers.clearTimeout(q.retryHandle);
      q.retryHandle = null;
    }
    const wake = q.wake;
    q.wake = null;
    wake?.();
    // A busy head belongs to its worker, which settles it when the in-flight send or wait returns.
    for (const item of q.busy ? q.items.slice(1) : q.items) settled(item, "abandoned");
    q.items.length = 0;
  };

  const drop = (deviceId: string): void => {
    try {
      const q = queues.get(deviceId);
      if (q === undefined) return;
      queues.delete(deviceId);
      cancel(q);
      settleIdle();
    } catch {
      // drop never throws.
    }
  };

  const unsubscribe = deps.store.onRemoved((id) => {
    drop(id);
    deps.memory.dropDevice(id);
    deps.monitor.forgetDevice(id);
  });

  const waitOrWake = (q: DeviceQueue, ms: number): Promise<void> =>
    new Promise<void>((resolve) => {
      if (q.cancelled) {
        resolve();
        return;
      }
      const done = (): void => {
        q.retryHandle = null;
        q.wake = null;
        resolve();
      };
      q.wake = done;
      q.retryHandle = deps.timers.setTimeout(done, ms);
    });

  /** Apply the transition for one classified result. The head stays items[0] throughout. */
  async function handle(
    q: DeviceQueue,
    item: QueueItem,
    sentToken: string,
    c: ApnsClassification,
    result: ApnsResult,
  ): Promise<Step> {
    const id = q.deviceId;
    const kind = item.planned.kind;
    const now = deps.clock.nowMs();
    switch (c.kind) {
      case "delivered": {
        recordPushNotification(kind, "delivered");
        deps.monitor.noteSuccess(now);
        ld(id, "delivered", null, now);
        settled(item, "delivered");
        return "next";
      }
      case "dead-token": {
        if (deps.store.get(id)?.apnsToken !== sentToken) {
          // The phone refreshed its token since the send: the dead report is for the old token.
          recordPushNotification(kind, "failed");
          ld(id, "failed", c.reason, now);
          settled(item, "failed");
          return "next";
        }
        const removed = await removeDevice(deps.store, id, "dead-token", { expectedApnsToken: sentToken });
        if (removed === "removed") {
          // The store logs the removal and counts removed_dead; onRemoved has already cancelled this queue.
          recordPushNotification(kind, "token_removed");
          settled(item, "token_removed");
          return "exit";
        }
        recordPushNotification(kind, "failed");
        if (removed === "write-failed") {
          ld(id, "failed", c.reason, deps.clock.nowMs());
          deps.monitor.logFailed(id, kind, "dead-token-unremoved", 410, c.reason);
        }
        settled(item, "failed");
        return "next";
      }
      case "permanent": {
        recordPushNotification(kind, "failed");
        ld(id, "failed", c.reason, now);
        const status = result.kind === "response" ? result.status : null;
        if (status !== null && status !== 403) deps.monitor.noteTokenAccepted();
        deps.monitor.logFailed(id, kind, "permanent", status, c.reason);
        settled(item, "failed");
        return "next";
      }
      case "auth-failed": {
        recordPushNotification(kind, "failed");
        ld(id, "failed", c.reason, now);
        deps.monitor.noteAuthFailed(403, c.reason);
        deps.monitor.logFailed(id, kind, "auth-failed", 403, c.reason);
        settled(item, "failed");
        return "next";
      }
      case "auth-expired":
      case "transient": {
        if (c.kind === "auth-expired") deps.signer?.invalidate();
        const reason = c.kind === "auth-expired" ? "ExpiredProviderToken" : c.reason;
        const delay = nextDelay(item.attempt, deps.random);
        if (now + delay - item.enqueuedAt > PUSH_LIMITS.retryDeadlineMs) {
          recordPushNotification(kind, "dropped");
          deps.memory.unmarkIfCurrent(id, item.planned.marks);
          ld(id, "dropped", reason, now);
          deps.monitor.logDropped(id, kind, "deadline");
          settled(item, "dropped");
          return "next";
        }
        item.attempt += 1;
        await waitOrWake(q, delay);
        return "retry";
      }
    }
  }

  async function runWorker(q: DeviceQueue): Promise<void> {
    running.add(q);
    try {
      while (!q.cancelled && q.items.length > 0) {
        const item = q.items[0]!;
        try {
          q.busy = true;
          const device = deps.store.get(q.deviceId);
          if (device === undefined || device.apnsToken === null || device.environment === null) {
            q.items.shift(); // device gone or not registered: discard, uncounted
            q.busy = false;
            settled(item, "discarded");
            continue;
          }
          const sentToken = device.apnsToken;
          const result = await deps.apns.send(device.environment, sentToken, toApnsRequest(item.planned, deps.topic));
          if (q.cancelled) {
            settled(item, "abandoned"); // dropped or closed while in flight: abandon, uncounted
            return;
          }
          const step = await handle(q, item, sentToken, classifyApnsResponse(result), result);
          if (step === "exit") return;
          if (q.cancelled) {
            if (step === "retry") settled(item, "abandoned");
            return;
          }
          if (step === "retry") continue; // re-resolve the device and resend the same head
          q.items.shift();
          q.busy = false;
        } catch {
          defaultLog({ event: "push_internal_error", ok: false, route: "dispatch" });
          if (q.cancelled) return;
          try {
            recordPushNotification(item.planned.kind, "failed");
            ld(q.deviceId, "failed", "other", deps.clock.nowMs());
          } catch {
            // Counting is best effort here; the item still leaves the queue.
          }
          if (q.items[0] === item) q.items.shift();
          q.busy = false;
          settled(item, "failed");
        }
      }
    } finally {
      running.delete(q);
      if (queues.get(q.deviceId) === q) queues.delete(q.deviceId);
      settleIdle();
    }
  }

  const evictFor = (q: DeviceQueue, now: number): void => {
    const victimIndex = q.busy ? 1 : 0;
    const [victim] = q.items.splice(victimIndex, 1);
    if (victim === undefined) return;
    const kind = victim.planned.kind;
    deps.memory.unmarkIfCurrent(q.deviceId, victim.planned.marks);
    recordPushNotification(kind, "dropped");
    ld(q.deviceId, "dropped", "overflow", now);
    deps.monitor.logDropped(q.deviceId, kind, "overflow");
    settled(victim, "dropped");
  };

  const api: DeviceQueues = {
    enqueue(items: readonly PlannedNotification[]): void {
      if (closed) return;
      try {
        const now = deps.clock.nowMs();
        const byDevice = new Map<string, PlannedNotification[]>();
        for (const planned of items) {
          const list = byDevice.get(planned.deviceId);
          if (list === undefined) byDevice.set(planned.deviceId, [planned]);
          else list.push(planned);
        }
        for (const [deviceId, list] of byDevice) {
          let q = queues.get(deviceId);
          const fresh = q === undefined;
          if (q === undefined) {
            q = { deviceId, items: [], busy: false, retryHandle: null, wake: null, cancelled: false };
            queues.set(deviceId, q);
          }
          for (const planned of list) {
            if (q.items.length >= PUSH_LIMITS.queueMaxPerDevice) evictFor(q, now);
            q.items.push({ planned, enqueuedAt: now, attempt: 0 });
          }
          if (fresh) void runWorker(q);
        }
      } catch {
        defaultLog({ event: "push_internal_error", ok: false, route: "dispatch" });
      }
    },
    drop,
    idle(): Promise<void> {
      return new Promise<void>((resolve) => {
        idleWaiters.push(resolve);
        settleIdle();
      });
    },
    close(): void {
      if (closed) return;
      closed = true;
      try {
        unsubscribe();
      } catch {
        // Unsubscribe is idempotent and never expected to throw.
      }
      for (const q of queues.values()) cancel(q);
      queues.clear();
      settleIdle();
    },
  };
  return Object.freeze(api);
}
