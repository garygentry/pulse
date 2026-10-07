// packages/web-data/src/history/points.ts — deterministic numeric-series normalization and
// the shared timestamp sort/dedupe primitive (07-history-service.md §§9, 10.1). Package
// internal: `history/service.ts` composes these into curated numeric payloads and the Gatus
// history normalization in `history/intervals.ts` reuses `sortDedupeByTimestamp`. Server-side
// only (reached through the `/history` barrel, never `/wire`).
//
// Normalization validates finite timestamps, preserves explicit-missing/NaN values as null
// (never coerced to zero), sorts ascending, dedupes equal timestamps with a documented
// last-sample rule, and enforces the §9 series/sample/label hard limits — rejecting the whole
// operation at boundary+1 rather than truncating. Series are returned in canonical bounded
// label order so identical inputs produce byte-identical payloads.

import { canonicalJson } from "../canonical.js";
import {
  ERROR_MESSAGES,
  HISTORY_MAX_LABEL_KEY_BYTES,
  HISTORY_MAX_LABEL_VALUE_BYTES,
  HISTORY_MAX_LABELS,
  HISTORY_MAX_POINTS,
  HISTORY_MAX_SERIES,
} from "../wire/common.js";
import type { HistorySeries } from "../wire/history.js";
import type { VmRangeSample, VmRangeSeries } from "../sources/vm.js";
import type { HistoryResult } from "./service.js";

const utf8 = new TextEncoder();
const decoder = new TextDecoder();

/** UTF-8 byte length of `value`. */
function byteLength(value: string): number {
  return utf8.encode(value).length;
}

/** A `HISTORY_LIMIT_EXCEEDED` failure with the exact catalog message (never caches). */
export function historyLimitExceeded(): HistoryResult<never> {
  return {
    ok: false,
    error: { code: "HISTORY_LIMIT_EXCEEDED", message: ERROR_MESSAGES.HISTORY_LIMIT_EXCEEDED, retryAfterSeconds: null },
  };
}

/** Canonical comparison of two bounded label bags for deterministic series ordering. */
function compareCanonicalLabels(a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>): number {
  const ca = decoder.decode(canonicalJson(a));
  const cb = decoder.decode(canonicalJson(b));
  return ca < cb ? -1 : ca > cb ? 1 : 0;
}

/** True when every bounded label key/value in `labels` is within the §9 byte limits. */
function labelsWithinBounds(labels: Readonly<Record<string, string>>): boolean {
  const keys = Object.keys(labels);
  if (keys.length > HISTORY_MAX_LABELS) return false;
  for (const key of keys) {
    if (byteLength(key) > HISTORY_MAX_LABEL_KEY_BYTES) return false;
    const value = labels[key];
    if (value !== undefined && byteLength(value) > HISTORY_MAX_LABEL_VALUE_BYTES) return false;
  }
  return true;
}

/**
 * A finite-timestamped sample carrying an already-null-normalized numeric value. The
 * generic sort/dedupe primitive works over this shape so both numeric series and Gatus
 * endpoint results share one deterministic ordering rule.
 */
export interface TimestampedSample<V> {
  /** Sample instant in epoch milliseconds (already validated finite). */ readonly timestampMs: number;
  /** The retained sample value. */ readonly value: V;
}

/**
 * Sort `samples` ascending by timestamp and dedupe equal timestamps by the documented
 * last-sample rule (the final sample seen at a timestamp wins). Non-finite timestamps are
 * dropped: they cannot be deterministically ordered and never represent a real observation.
 * A stable index tie-break makes the "last sample" deterministic regardless of input order.
 */
export function sortDedupeByTimestamp<V>(samples: readonly TimestampedSample<V>[]): TimestampedSample<V>[] {
  const indexed = samples
    .map((sample, index) => ({ sample, index }))
    .filter((entry) => Number.isFinite(entry.sample.timestampMs));
  indexed.sort((a, b) => a.sample.timestampMs - b.sample.timestampMs || a.index - b.index);
  const out: TimestampedSample<V>[] = [];
  for (const entry of indexed) {
    const last = out[out.length - 1];
    if (last !== undefined && last.timestampMs === entry.sample.timestampMs) {
      out[out.length - 1] = entry.sample; // last-sample rule for an equal timestamp
    } else {
      out.push(entry.sample);
    }
  }
  return out;
}

/** Coerce a range sample's value to a finite number or an explicit null gap (never zero). */
function finiteOrNull(value: number | null): number | null {
  return value !== null && Number.isFinite(value) ? value : null;
}

/**
 * Normalize curated numeric range series (07 §10.1). Each series is validated against the §9
 * label limits, its samples are sorted ascending, deduped by the last-sample rule, and value
 * gaps preserved as explicit null; the ≤600-sample ceiling (which already reserves the two
 * boundary samples via the caller's `effectiveStepSeconds`) and the ≤1,024-series ceiling
 * reject the whole operation at boundary+1. Series are emitted in canonical bounded label
 * order. Missing/NaN values are never coerced to zero.
 *
 * @param series - The validated VM matrix series.
 * @param effectiveStepSeconds - The point-budget step; the ≤600 ceiling already reserves the
 *   two boundary samples, so no out-of-window trimming is required for VM's in-window matrix.
 * @returns The normalized bounded series, or `HISTORY_LIMIT_EXCEEDED`.
 */
export function normalizeHistorySeries(
  series: readonly VmRangeSeries[],
  effectiveStepSeconds: number,
): HistoryResult<readonly HistorySeries[]> {
  void effectiveStepSeconds;
  if (series.length > HISTORY_MAX_SERIES) return historyLimitExceeded();
  const out: HistorySeries[] = [];
  for (const entry of series) {
    if (!labelsWithinBounds(entry.metric)) return historyLimitExceeded();
    const ordered = sortDedupeByTimestamp<number | null>(
      entry.samples.map((sample: VmRangeSample) => ({ timestampMs: sample.timestampMs, value: sample.value })),
    );
    if (ordered.length > HISTORY_MAX_POINTS) return historyLimitExceeded();
    const points = ordered.map((sample) => [sample.timestampMs, finiteOrNull(sample.value)] as const);
    out.push({ labels: entry.metric, points });
  }
  out.sort((a, b) => compareCanonicalLabels(a.labels, b.labels));
  return { ok: true, data: out, delivery: "miss" };
}
