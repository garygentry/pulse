// Pure detail-region model: readout ordering, chart titles, unavailable-state copy and the
// Estate/Grafana link builders for the selected-target detail region.
import type { RangeId } from "@pulse/web-data/wire";
import type { HOST_CHART_QUERIES } from "../_shared/timeseries/query-meta.js";
import type { LaneNode } from "./model.js";

// ---------------------------------------------------------------------------
// Constants and copy
// ---------------------------------------------------------------------------

/** Readout order of the first detail chart: after every lane block and the swimlane. */
export const CHART_READOUT_ORDER = 1000;

/** Chart titles for the host capacity queries. */
export const HOST_CHART_TITLE: Readonly<Record<(typeof HOST_CHART_QUERIES)[number], string>> = {
  "host.cpu.utilization": "CPU utilization",
  "host.memory.utilization": "Memory utilization",
  "host.disk.utilization": "Disk utilization",
  "host.load.1m": "Load average (1m)",
};

/** "Not available at this range (max {maxRange})". */
export function notAvailableAtRange(maxRange: RangeId): string {
  return `Not available at this range (max ${maxRange})`;
}

/** Service latency state for an endpoint the index does not list. */
export const CHECK_LATENCY_UNAVAILABLE = "Check latency history not available";

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

/**
 * In-app estate entity path: host → `/estate/host/${enc(name)}`;
 * service → `/estate/service/${enc(hostName)}/${enc(name)}`. Every segment is encodeURIComponent-
 * encoded, so a name cannot change the path, query or origin. Pure.
 */
export function estateHref(node: LaneNode): string {
  if (node.target.kind === "service") {
    return `/estate/service/${encodeURIComponent(node.hostName ?? "")}/${encodeURIComponent(node.name)}`;
  }
  return `/estate/host/${encodeURIComponent(node.name)}`;
}

/**
 * The server-resolved Grafana board URL for a target, or null. Returns `url` only when
 * `new URL(url)` parses with protocol "http:" or "https:"; null for null input, a parse failure or
 * any other scheme. The URL is the snapshot's frozen deep-link and is not rebuilt. Pure.
 */
export function safeGrafanaHref(url: string | null): string | null {
  if (typeof url !== "string" || url === "") return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}
