// Per-device delivery queues. For now this module declares the injectable `Timers` seam and the queue vocabulary;
// the implementation is added later.

import type { PlannedNotification } from "../plan.js";

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
