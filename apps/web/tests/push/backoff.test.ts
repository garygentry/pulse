// apps/web/tests/push/backoff.test.ts — retry delay bounds per attempt, jitter extremes and input clamping.

import { describe, expect, test } from "bun:test";

import { nextDelay } from "../../src/server/push/dispatch/backoff.js";
import type { RandomSource } from "../../src/server/push/ids.js";

function stub(unit: number): RandomSource {
  return { bytes: (n) => new Uint8Array(n), unit: () => unit };
}

const LOW = stub(0);
const HIGH = stub(0.999999);

/** [attempt, lower bound inclusive, upper bound exclusive] */
const BOUNDS: ReadonlyArray<readonly [number, number, number]> = [
  [0, 800, 1_200],
  [1, 1_600, 2_400],
  [2, 3_200, 4_800],
  [3, 6_400, 9_600],
  [4, 12_800, 19_200],
  [5, 25_600, 38_400],
  [6, 48_000, 72_000],
  [7, 48_000, 72_000],
  [8, 48_000, 72_000],
];

describe("nextDelay", () => {
  for (const [attempt, lo, hi] of BOUNDS) {
    test(`attempt ${attempt} stays within [${lo}, ${hi})`, () => {
      const min = nextDelay(attempt, LOW);
      const max = nextDelay(attempt, HIGH);
      expect(min).toBe(lo);
      expect(max).toBeGreaterThanOrEqual(lo);
      expect(max).toBeLessThan(hi);
      expect(max).toBeGreaterThan(hi - 2);
      expect(Number.isInteger(min) && Number.isInteger(max)).toBe(true);
    });
  }

  test("-1 and NaN behave as attempt 0", () => {
    for (const rng of [LOW, HIGH]) {
      expect(nextDelay(-1, rng)).toBe(nextDelay(0, rng));
      expect(nextDelay(Number.NaN, rng)).toBe(nextDelay(0, rng));
      expect(nextDelay(Number.NEGATIVE_INFINITY, rng)).toBe(nextDelay(0, rng));
    }
  });

  test("1000 behaves as the 60 s cap", () => {
    expect(nextDelay(1000, LOW)).toBe(48_000);
    expect(nextDelay(1000, HIGH)).toBe(nextDelay(6, HIGH));
  });

  test("a non-finite attempt (Infinity) is treated as 0", () => {
    expect(nextDelay(Number.POSITIVE_INFINITY, LOW)).toBe(nextDelay(0, LOW));
  });
});
