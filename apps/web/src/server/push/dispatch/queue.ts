// Per-device delivery queues. For now this module declares only the injectable `Timers` seam.

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
