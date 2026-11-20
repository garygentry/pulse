// Identifier generation and the injectable entropy, clock and timer sources for the push gateway.

import type { Timers } from "./dispatch/queue.js"; // type-only

/** Injectable entropy source. The production source is crypto.getRandomValues; tests use a seeded source. */
export interface RandomSource {
  /** `n` fresh random bytes. */
  bytes(n: number): Uint8Array;
  /** Uniform in [0, 1), for backoff jitter. */
  unit(): number;
}

/** Injectable clock. */
export interface Clock {
  /** Current time in epoch milliseconds. */
  nowMs(): number;
}

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64url");
}

/** A one-time pairing token: 16 random bytes → 22 base64url characters. */
export function newPairingToken(rng: RandomSource): string {
  return base64url(rng.bytes(16));
}

/** A device bearer credential: 32 random bytes → 43 base64url characters. */
export function newCredential(rng: RandomSource): string {
  return base64url(rng.bytes(32));
}

/** A device id: `dev_` + 8 random bytes → 11 base64url characters. */
export function newDeviceId(rng: RandomSource): string {
  return `dev_${base64url(rng.bytes(8))}`;
}

/** 2^53, the number of distinct doubles `unit()` can produce. */
const TWO_POW_53 = 9_007_199_254_740_992;

/** Production entropy: crypto.getRandomValues. */
export const SYSTEM_RANDOM: RandomSource = Object.freeze({
  bytes: (n: number): Uint8Array => crypto.getRandomValues(new Uint8Array(n)),
  unit: (): number => {
    const w = crypto.getRandomValues(new Uint32Array(2));
    // 27 high bits + 26 low bits = 53 bits of uniform entropy, divided by 2^53 → [0, 1).
    return ((w[0]! >>> 5) * 67_108_864 + (w[1]! >>> 6)) / TWO_POW_53;
  },
});

/** Production clock: Date.now. */
export const SYSTEM_CLOCK: Clock = Object.freeze({
  nowMs: (): number => Date.now(),
});

/** Unref a timer handle where the runtime supports it (bun and node both do). */
function unrefHandle<T>(h: T): T {
  (h as { unref?: () => void }).unref?.();
  return h;
}

/** Production timers. Every handle is unref'd, so a push timer never keeps a process or a test run alive. */
export const SYSTEM_TIMERS: Timers = Object.freeze({
  setTimeout: (fn: () => void, ms: number): unknown => unrefHandle(setTimeout(fn, ms)),
  clearTimeout: (handle: unknown): void => clearTimeout(handle as ReturnType<typeof setTimeout>),
  setInterval: (fn: () => void, ms: number): unknown => unrefHandle(setInterval(fn, ms)),
  clearInterval: (handle: unknown): void => clearInterval(handle as ReturnType<typeof setInterval>),
});
