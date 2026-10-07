// apps/web/tests/overview-percentile.test.ts — pure unit tests for the overview performance
// suite's nearest-rank percentile (08-testing-strategy.md §7.1). No browser: the helper lives in
// fixtures/overview/percentile.ts so importing it never registers the browser suite.

import { describe, expect, test } from "bun:test";

import {
  PERFORMANCE_SAMPLE_COUNT,
  nearestRankPercentile,
  summarizeSamples,
} from "./fixtures/overview/percentile.js";

/** 20 distinct samples in scrambled order: 1..20 ms. */
const TWENTY = [7, 3, 20, 11, 1, 16, 9, 14, 5, 18, 2, 12, 19, 6, 15, 4, 10, 13, 8, 17];

describe("nearestRankPercentile", () => {
  test("p95 of 20 samples is the rank-19 value", () => {
    expect(nearestRankPercentile(TWENTY, 0.95)).toBe(19);
  });

  test("nearest-rank values across percentiles", () => {
    expect(nearestRankPercentile(TWENTY, 0.5)).toBe(10);
    expect(nearestRankPercentile(TWENTY, 1)).toBe(20);
    expect(nearestRankPercentile(TWENTY, 0.01)).toBe(1);
    expect(nearestRankPercentile([42], 0.95)).toBe(42);
    expect(nearestRankPercentile([0, 0, 0], 0.95)).toBe(0);
  });

  test("copies before sorting (input untouched)", () => {
    const input = [...TWENTY];
    nearestRankPercentile(input, 0.95);
    expect(input).toEqual(TWENTY);
    const frozen = Object.freeze([...TWENTY]);
    expect(nearestRankPercentile(frozen, 0.95)).toBe(19);
  });

  test("sorts numerically, not lexically", () => {
    expect(nearestRankPercentile([100, 9, 20], 1)).toBe(100);
    expect(nearestRankPercentile([100, 9, 20], 0.33)).toBe(9);
  });

  test("rejects empty samples", () => {
    expect(() => nearestRankPercentile([], 0.95)).toThrow(RangeError);
  });

  test.each([[Number.NaN], [Number.POSITIVE_INFINITY], [Number.NEGATIVE_INFINITY], [-1], [-0.001]])(
    "rejects invalid sample %p",
    (bad) => {
      expect(() => nearestRankPercentile([1, 2, bad], 0.95)).toThrow(RangeError);
    },
  );

  test.each([[0], [-0.5], [1.0001], [2], [Number.NaN], [Number.POSITIVE_INFINITY]])(
    "rejects percentile %p outside (0, 1]",
    (bad) => {
      expect(() => nearestRankPercentile(TWENTY, bad)).toThrow(RangeError);
    },
  );
});

describe("summarizeSamples", () => {
  test("reports median, p95 and max with the limit", () => {
    const set = summarizeSamples("status-paint", TWENTY, 100);
    expect(set).toEqual({
      name: "status-paint",
      samplesMs: TWENTY,
      medianMs: 10,
      p95Ms: 19,
      maximumMs: 20,
      limitMs: 100,
    });
    expect(set.samplesMs).not.toBe(TWENTY);
  });

  test("requires exactly 20 samples", () => {
    expect(PERFORMANCE_SAMPLE_COUNT).toBe(20);
    expect(() => summarizeSamples("initial-paint", TWENTY.slice(1), 1_000)).toThrow(RangeError);
    expect(() => summarizeSamples("initial-paint", [...TWENTY, 21], 1_000)).toThrow(RangeError);
  });
});
