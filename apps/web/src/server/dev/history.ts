// src/server/dev/history.ts — range-query and check-history bodies for the dev mock engine.
//
// The history routes (`/api/history/*`) read VictoriaMetrics `/api/v1/query_range` and Gatus
// `/api/v1/endpoints/{key}/statuses`. A scenario carries only instant fixtures, so these bodies are
// derived from the scenario's current fold instead of authored:
//   - alert history (`ALERTS{…}`): one firing series per current Alertmanager alert, from its
//     `startsAt` to its `endsAt` (or now);
//   - liveness (`… or vector(0/0)`): the current VM `up`/`pulse_agent_up`/deep-health value of the
//     selected `job`/`instance` series (the post-relabel identity), service, or the whole estate,
//     held over the range;
//   - curated host/endpoint/engine metrics: a deterministic wave in a plausible band per metric,
//     phased by the query text so different hosts draw different curves (a host metric only when
//     its `job`/`instance` selectors name a series the VM fixture stores);
//   - check history: the endpoint's fixture row, as the statuses list serves it, addressed by the
//     key Gatus derives from its group and name.
// Anything else (the binder's never-match query, an unknown metric) is an empty matrix: "no data",
// never a source failure. Pure: no I/O and no clock reads; equal inputs give equal bodies.

import { gatusEndpointKey } from "@pulse/web-data/sources";

import type { AmAlertsResponse, GatusStatusesResponse, VmQueryResponse } from "../sources/index.js";

/** VictoriaMetrics' own per-series point limit for `query_range`; a request past it is a 422. */
const MAX_POINTS = 30_000;

/** The VM range body (`resultType: "matrix"`). */
export interface VmRangeBody {
  status: "success";
  data: { resultType: "matrix"; result: { metric: Record<string, string>; values: [number, string][] }[] };
}

/** The parsed `start`/`end`/`step` of a range request, in seconds. */
export interface RangeWindow {
  /** Range start, epoch seconds. */ start: number;
  /** Range end, epoch seconds. */ end: number;
  /** Step, seconds (> 0). */ step: number;
}

/** Parse a `query_range` window, or null when it is missing, non-finite, inverted, or too dense. */
export function parseRangeWindow(params: URLSearchParams): RangeWindow | null {
  const start = Number(params.get("start"));
  const end = Number(params.get("end"));
  const step = Number(params.get("step"));
  if (![start, end, step].every(Number.isFinite) || step <= 0 || end < start) return null;
  if ((end - start) / step + 1 > MAX_POINTS) return null;
  return { start, end, step };
}

/** A metric's plausible band and period for the wave. */
interface Band {
  /** Low value. */ lo: number;
  /** High value. */ hi: number;
  /** Wave period, seconds. */ period: number;
}

/** Curated metric name → band. First match wins; matched as a substring of the PromQL. */
const BANDS: readonly (readonly [string, Band])[] = [
  ["node_cpu_seconds_total", { lo: 12, hi: 48, period: 2_400 }],
  ["node_memory_MemAvailable_bytes", { lo: 38, hi: 56, period: 7_200 }],
  ["node_filesystem_avail_bytes", { lo: 57, hi: 63, period: 43_200 }],
  ["node_load1", { lo: 0.3, hi: 1.4, period: 1_800 }],
  ["gatus_results_duration_seconds", { lo: 35, hi: 140, period: 1_200 }],
  ["vm_rows_inserted_total", { lo: 2_600, hi: 3_400, period: 3_600 }],
  ["vm_cache_entries", { lo: 118_000, hi: 124_000, period: 21_600 }],
  ["vm_data_size_bytes", { lo: 4.1e9, hi: 4.4e9, period: 86_400 }],
  ["alertmanager_notifications_failed_total", { lo: 0, hi: 0, period: 3_600 }],
  ["alertmanager_notification_latency_seconds", { lo: 0.12, hi: 0.48, period: 10_800 }],
  ["backup_freshness_age_seconds", { lo: 3_600, hi: 30_000, period: 86_400 }],
  ["deep_health", { lo: 1, hi: 1, period: 3_600 }],
];

/** The alert-attribution labels the alerts query groups by. */
const ALERT_LABELS = ["alertname", "severity", "host", "service", "instance"] as const;

/** Small stable string hash (FNV-1a), for a per-query wave phase. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** The sample instants of a window. */
function instants(window: RangeWindow): number[] {
  const out: number[] = [];
  for (let t = window.start; t <= window.end; t += window.step) out.push(t);
  return out;
}

/** Every value of `label="…"` in the PromQL. */
function selectorValues(promql: string, label: string): string[] {
  return [...promql.matchAll(new RegExp(`\\b${label}="((?:[^"\\\\]|\\\\.)*)"`, "g"))].map((m) => m[1]!);
}

/** One firing series per current alert, sampled "1" while it fires inside the window. */
function alertSeries(alerts: AmAlertsResponse, window: RangeWindow, nowMs: number): VmRangeBody["data"]["result"] {
  const byTuple = new Map<string, { metric: Record<string, string>; firing: Set<number> }>();
  for (const alert of alerts) {
    const startMs = Date.parse(alert.startsAt);
    const endsAtMs = Date.parse(alert.endsAt ?? "");
    const endMs = Number.isNaN(endsAtMs) ? nowMs : Math.min(endsAtMs, nowMs);
    const metric: Record<string, string> = {};
    for (const label of ALERT_LABELS) {
      const value = alert.labels[label];
      if (value !== undefined && value !== "") metric[label] = value;
    }
    const key = JSON.stringify(metric);
    const series = byTuple.get(key) ?? { metric, firing: new Set<number>() };
    for (const t of instants(window)) {
      if (t * 1000 >= startMs && t * 1000 < endMs) series.firing.add(t);
    }
    byTuple.set(key, series);
  }
  return [...byTuple.values()]
    .filter((s) => s.firing.size > 0)
    .map((s) => ({ metric: s.metric, values: [...s.firing].sort((a, b) => a - b).map((t): [number, string] => [t, "1"]) }));
}

/**
 * The `job`/`instance` pairs a host query selects. The binder pins both labels on every series
 * selector (`{job="…",instance="…"}`, the post-relabel identity — issue #69), so a sample matches
 * only when its own pair is one of these.
 */
function seriesPairs(promql: string): Set<string> {
  return new Set(
    [...promql.matchAll(/\bjob="((?:[^"\\]|\\.)*)",instance="((?:[^"\\]|\\.)*)"/g)].map((m) => `${m[1]}\u0000${m[2]}`),
  );
}

/** The current liveness value the query selects from the VM instant fixture, or null if none. */
function livenessValue(promql: string, vm: VmQueryResponse): number | null {
  const samples = vm.data?.result ?? [];
  const value = (s: (typeof samples)[number]): number => Number(s.value[1]);
  const pairs = seriesPairs(promql);
  const [host] = selectorValues(promql, "host");
  const [service] = selectorValues(promql, "service");
  let picked: number[];
  if (pairs.size > 0) {
    picked = samples
      .filter((s) => pairs.has(`${s.metric.job ?? ""}\u0000${s.metric.instance ?? ""}`))
      .map(value);
    return picked.length > 0 ? Math.min(...picked) : null;
  }
  if (service !== undefined) {
    picked = samples
      .filter((s) => s.metric.service === service && (host === undefined || host === "" || s.metric.host === host))
      .map(value);
    return picked.length > 0 ? Math.max(...picked) : null;
  }
  picked = samples
    .filter((s) => ["up", "pulse_agent_up", "pulse_deep_health_up"].includes(s.metric.__name__ ?? ""))
    .map(value);
  return picked.length > 0 ? Math.min(...picked) : null;
}

/**
 * The `query_range` body for `promql` over `window`, derived from the scenario's current VM and
 * Alertmanager bodies (already re-based onto the scenario start).
 */
export function mockRangeBody(
  promql: string,
  window: RangeWindow,
  current: { readonly vm: VmQueryResponse; readonly alertmanager: AmAlertsResponse },
  nowMs: number,
): VmRangeBody {
  const body = (result: VmRangeBody["data"]["result"]): VmRangeBody => ({
    status: "success",
    data: { resultType: "matrix", result },
  });
  if (promql.includes("ALERTS{")) return body(alertSeries(current.alertmanager, window, nowMs));
  if (promql.includes("or vector(0/0)")) {
    const value = livenessValue(promql, current.vm);
    if (value === null || !Number.isFinite(value)) return body([]);
    return body([{ metric: {}, values: instants(window).map((t): [number, string] => [t, String(value)]) }]);
  }
  const band = BANDS.find(([metric]) => promql.includes(metric))?.[1];
  if (band === undefined) return body([]);
  // A host metric draws only when it selects a `job`/`instance` series the scenario actually
  // stores, so a binder that drifts from the scrape relabel contract shows "no data" here too.
  const pairs = seriesPairs(promql);
  if (pairs.size > 0 && !(current.vm.data?.result ?? []).some((s) => pairs.has(`${s.metric.job ?? ""}\u0000${s.metric.instance ?? ""}`))) {
    return body([]);
  }
  const phase = (hash(promql) % 360) * (Math.PI / 180);
  const values = instants(window).map((t): [number, string] => {
    const wave = 0.5 + 0.5 * Math.sin((2 * Math.PI * t) / band.period + phase);
    const value = band.lo + (band.hi - band.lo) * wave;
    return [t, String(Math.round(value * 1000) / 1000)];
  });
  return body([{ metric: {}, values }]);
}

/**
 * The Gatus `/api/v1/endpoints/{key}/statuses` body: the endpoint row that key designates, or null
 * (Gatus answers an unknown key with a 404). Gatus derives the key as `<group>_<name>`, sanitized
 * (`gatusEndpointKey`); the history service builds it from the estate model's group, which a
 * fixture's `group` need not match (the DNS checks sit in group `estate` but the model gives them
 * none), so the row is found by its sanitized name, falling back to the fixture's own `key`.
 */
export function mockEndpointHistory(
  gatus: GatusStatusesResponse,
  key: string,
): GatusStatusesResponse[number] | null {
  const name = key.slice(key.indexOf("_") + 1);
  return gatus.find((ep) => gatusEndpointKey("", ep.name) === `_${name}`)
    ?? gatus.find((ep) => ep.key === key)
    ?? null;
}
