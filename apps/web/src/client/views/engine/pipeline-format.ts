// src/client/views/engine/pipeline-format.ts — formatter bindings for the notification and capacity
// tiles. Pure.

import { formatBytes, formatCount, formatRate, formatSeconds } from "./labels.js";
import type { CapacityTileId } from "./model.js";

/** Notification formatter bindings. */
export const NOTIFICATION_FORMAT = {
  /** Failures per second. */ failures: (n: number): string => formatRate(n, "failures"),
  /** p95 latency in seconds. */ latency: (n: number): string => formatSeconds(n),
} as const;

/** Capacity formatter bindings per tile id. */
export const CAPACITY_FORMAT: Readonly<Record<CapacityTileId, (n: number) => string>> = {
  "ingestion-rate": (n) => formatRate(n, "rows"),
  "active-series": (n) => formatCount(n),
  "data-size": (n) => formatBytes(n),
  "free-disk": (n) => formatBytes(n),
};
