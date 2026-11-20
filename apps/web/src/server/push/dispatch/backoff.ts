// Retry backoff for per-device delivery: capped exponential growth with multiplicative jitter.

import { PUSH_LIMITS } from "../constants.js";
import type { RandomSource } from "../ids.js";

/**
 * Delay before the next retry of a queue item, in whole milliseconds:
 *   floor( min(backoffMaxMs, backoffBaseMs × 2^attempt) × U(backoffJitterLow, backoffJitterHigh) )
 * with U drawn as `low + (high − low) × rng.unit()`, `rng.unit() ∈ [0, 1)`.
 *
 * @param attempt - Transient attempts already made for this item (0 for the first retry). A negative or non-finite
 *   value is treated as 0. The exponent is clamped at 16, so 2^attempt never overflows.
 * @param rng - Injectable randomness (seeded in tests).
 * @returns Delay in ms, in [800, 72000).
 */
export function nextDelay(attempt: number, rng: RandomSource): number {
  const a = Number.isFinite(attempt) && attempt > 0 ? Math.min(Math.floor(attempt), 16) : 0;
  const base = Math.min(PUSH_LIMITS.backoffMaxMs, PUSH_LIMITS.backoffBaseMs * 2 ** a);
  const { backoffJitterLow: lo, backoffJitterHigh: hi } = PUSH_LIMITS;
  return Math.floor(base * (lo + (hi - lo) * rng.unit()));
}
