// src/client/views/engine/trends-model.ts — the fetched window for an engine trend. Pure.

import type { RangeId } from "@pulse/web-data/wire";
import type { TimeWindow } from "../_shared/timeseries/axis.js";
import { RANGE_SECONDS } from "../_shared/timeseries/query-meta.js";

/**
 * The fetched window for a trend, `[end − range, end)`, in epoch seconds. Pure.
 *
 * @param endSec - Window end in epoch seconds: the payload's fetchedAt, or now before any data.
 * @param range - Range id.
 * @returns The TimeWindow.
 */
export function trendWindow(endSec: number, range: RangeId): TimeWindow {
  return { start: endSec - RANGE_SECONDS[range], end: endSec };
}
