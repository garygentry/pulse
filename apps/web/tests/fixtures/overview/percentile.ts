// apps/web/tests/fixtures/overview/percentile.ts — pure performance-sample helpers for the overview
// production-Chromium performance suite (08-testing-strategy.md §7.1). Kept outside
// tests/browser/ so the root unit test (overview-percentile.test.ts) imports it without ever
// registering the browser suite. No I/O, no globals.

/** One acceptance metric's samples and summary (08 §7.1). */
export interface PerformanceSampleSet {
  /** Acceptance metric represented by this sample set. */
  readonly name: "initial-paint" | "status-paint" | "input-response";
  /** Exactly 20 finite non-negative event-to-paint durations in milliseconds. */
  readonly samplesMs: readonly number[];
  /** Median duration in milliseconds, retained for diagnostics. */
  readonly medianMs: number;
  /** Nearest-rank 95th percentile duration in milliseconds. */
  readonly p95Ms: number;
  /** Maximum observed duration in milliseconds. */
  readonly maximumMs: number;
  /** Inclusive acceptance threshold in milliseconds. */
  readonly limitMs: number;
}

/** Samples collected per metric (08 §7.1). */
export const PERFORMANCE_SAMPLE_COUNT = 20;

/** Human-readable p95 method, printed with every report and failure. */
export const P95_METHOD = "nearest-rank: sorted ascending, 1-based rank ceil(0.95 * n)";

/**
 * Nearest-rank percentile: the value at 1-based rank `ceil(percentile * n)` of an ascending copy of
 * `values` (p95 of 20 samples = rank 19). The input is never mutated.
 *
 * @throws {RangeError} when `values` is empty, any value is non-finite or negative, or `percentile`
 *   is not a number in `(0, 1]`.
 */
export function nearestRankPercentile(values: readonly number[], percentile: number): number {
  if (!Number.isFinite(percentile) || percentile <= 0 || percentile > 1) {
    throw new RangeError(`percentile must be in (0, 1], got ${String(percentile)}`);
  }
  if (values.length === 0) throw new RangeError("cannot take a percentile of zero samples");
  for (const value of values) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new RangeError(`samples must be finite and non-negative, got ${String(value)}`);
    }
  }
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil(percentile * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1]!;
}

/**
 * Summarize one metric's samples. Median is the nearest-rank p50 (a real observed sample).
 *
 * @throws {RangeError} when `samplesMs` does not hold exactly {@link PERFORMANCE_SAMPLE_COUNT} valid
 *   samples — a failed run is never discarded to make up the count.
 */
export function summarizeSamples(
  name: PerformanceSampleSet["name"],
  samplesMs: readonly number[],
  limitMs: number,
): PerformanceSampleSet {
  if (samplesMs.length !== PERFORMANCE_SAMPLE_COUNT) {
    throw new RangeError(`${name}: expected exactly ${PERFORMANCE_SAMPLE_COUNT} samples, got ${samplesMs.length}`);
  }
  return {
    name,
    samplesMs: [...samplesMs],
    medianMs: nearestRankPercentile(samplesMs, 0.5),
    p95Ms: nearestRankPercentile(samplesMs, 0.95),
    maximumMs: nearestRankPercentile(samplesMs, 1),
    limitMs,
  };
}
