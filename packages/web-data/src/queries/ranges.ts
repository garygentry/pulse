// packages/web-data/src/queries/ranges.ts — fixed history ranges and point-aware step
// planning (06-curated-query-catalog.md §5). Exactly four closed ranges are accepted;
// the effective step reserves two of the 600-point ceiling for boundary samples via the
// 598 denominator. VM start/end/step are derived from one captured `now`, the range
// seconds, and this step — never accepted from clients.

import type { ApiError, RangeId } from "../wire/common.js";
import { ERROR_MESSAGES } from "../wire/common.js";
import type { CuratedQueryDefinition } from "./catalog.js";

/** Duration in seconds for each closed range id (06 §5). */
export const RANGE_SECONDS: Readonly<Record<RangeId, number>> = {
  "1h": 3600,
  "6h": 21600,
  "24h": 86400,
  "7d": 604800,
};

/** Range ids in ascending duration order. */
export const RANGE_IDS: readonly RangeId[] = ["1h", "6h", "24h", "7d"];

/**
 * Denominator reserving two of the 600-point ceiling for boundary samples (06 §5).
 * A range sampled at `ceil(rangeSeconds / 598)` yields at most 598 interior points plus
 * the two boundaries, never exceeding 600.
 */
const STEP_DENOMINATOR = 598;

/**
 * Effective VM sampling step in seconds: the larger of the catalog preferred step and the
 * point-budget floor `ceil(rangeSeconds / 598)` (06 §5). Reserves the 600-point boundary
 * exactly.
 */
export function effectiveStepSeconds(rangeSeconds: number, preferredStepSeconds: number): number {
  return Math.max(preferredStepSeconds, Math.ceil(rangeSeconds / STEP_DENOMINATOR));
}

/**
 * The ranges a query accepts — all closed ranges no longer than its `maxRange`, in
 * ascending duration order — derived from `RANGE_SECONDS` and the definition (06 §5).
 */
export function acceptedRangesForQuery(definition: CuratedQueryDefinition): readonly RangeId[] {
  const maxSeconds = RANGE_SECONDS[definition.maxRange];
  return RANGE_IDS.filter((id) => RANGE_SECONDS[id] <= maxSeconds);
}

/** Whether `value` is a known closed range id. */
function isRangeId(value: string): value is RangeId {
  return Object.prototype.hasOwnProperty.call(RANGE_SECONDS, value);
}

/**
 * Resolve the requested range against a query definition (06 §5, §7). An absent range
 * uses the entry default; an unknown/malformed range value is `INVALID_REQUEST`; a known
 * range longer than the entry max is `RANGE_UNSUPPORTED`. On success the resolved range,
 * its seconds, and the point-aware effective step are returned. Never accepts a
 * client-supplied step.
 */
export function parseRange(
  value: string | null,
  definition: CuratedQueryDefinition,
):
  | { readonly ok: true; readonly range: RangeId; readonly seconds: number; readonly effectiveStepSeconds: number }
  | { readonly ok: false; readonly error: ApiError<"INVALID_REQUEST" | "RANGE_UNSUPPORTED"> } {
  const maxSeconds = RANGE_SECONDS[definition.maxRange];

  if (value === null) {
    const seconds = RANGE_SECONDS[definition.defaultRange];
    return {
      ok: true,
      range: definition.defaultRange,
      seconds,
      effectiveStepSeconds: effectiveStepSeconds(seconds, definition.preferredStepSeconds),
    };
  }

  if (!isRangeId(value)) {
    return { ok: false, error: { code: "INVALID_REQUEST", message: ERROR_MESSAGES.INVALID_REQUEST } };
  }

  const seconds = RANGE_SECONDS[value];
  if (seconds > maxSeconds) {
    return {
      ok: false,
      error: {
        code: "RANGE_UNSUPPORTED",
        message: ERROR_MESSAGES.RANGE_UNSUPPORTED,
        details: { queryId: definition.id, range: value, maxRange: definition.maxRange },
      },
    };
  }

  return {
    ok: true,
    range: value,
    seconds,
    effectiveStepSeconds: effectiveStepSeconds(seconds, definition.preferredStepSeconds),
  };
}
