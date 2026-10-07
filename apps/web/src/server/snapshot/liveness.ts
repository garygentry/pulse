// src/server/snapshot/liveness.ts — the affirmative-liveness precondition
// (REQ-STATE-05, folds A-001). Pure, side-effect-free.
//
// The one metric-derived input permitted to gate colour: green requires an affirmative
// "monitored & alive" signal. `false` ⇒ no such signal (down, absent, stale, or failing) → never
// green. `null` ⇒ the governing source is unreachable → still not green, and distinguished so the
// client can attribute the gap (absence-never-OK).

import type { CollectionClass } from "@pulse/core";
import type { WebEstateHost, WebEstateService } from "@pulse/renderer";

import type { LiveSeries, RawCheckStatus } from "../sources/types.js";
import type { SourceData, BuildConfig } from "./build.js";

/** True iff any series with `name` carries `host=<host>` and value `1` (§5.1). */
function hasLive(series: LiveSeries[], name: string, host: string): boolean {
  return series.some((s) => s.name === name && s.labels.host === host && s.value === 1);
}

/** True when `iso` is within `staleSeconds` of `now`. `iso===""`/unparseable ⇒ not fresh (§5.3). */
export function isFresh(iso: string, now: Date, staleSeconds: number): boolean {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return false;
  return (now.getTime() - t) / 1000 <= staleSeconds;
}

/** Endpoint is monitored & alive: latest exists, is fresh, and succeeded (§5.3). */
export function gatusAlive(
  endpoints: RawCheckStatus[],
  name: string,
  now: Date,
  cfg: BuildConfig,
): boolean {
  const ep = endpoints.find((e) => e.name === name);
  if (!ep || ep.latest === null) return false; // undeclared here / never evaluated
  return ep.latest.success && isFresh(ep.latest.timestamp, now, cfg.gatusStaleSeconds);
}

/**
 * Affirmative-liveness signal for a host (§5.2). `null` when the governing source is unreachable.
 *
 * @returns `true` = monitored & alive; `false` = down/absent/stale/failing; `null` = source unreachable.
 */
export function evaluateHostLiveness(
  host: WebEstateHost,
  data: SourceData,
  now: Date,
  cfg: BuildConfig,
): boolean | null {
  const cls: CollectionClass = host.collectionClass;
  if (cls === "managed-linux") {
    if (!data.liveness.health.ok) return null;
    return (
      hasLive(data.liveness.series, "pulse_agent_up", host.name) ||
      hasLive(data.liveness.series, "up", host.name) // fallback (§5.2)
    );
  }
  if (cls === "hypervisor-api" || cls === "nas-api") {
    if (!data.liveness.health.ok) return null;
    return hasLive(data.liveness.series, "up", host.name); // relabel-through caveat (§5.2)
  }
  if (cls === "probe-only") {
    if (!data.checks.health.ok) return null;
    return gatusAlive(data.checks.endpoints, `host:${host.name}`, now, cfg);
  }
  return null; // "excluded" (or any future class) — no signal by design.
}

/**
 * Affirmative-liveness signal for a service (§5.2). Deep-health takes precedence over ingress
 * freshness when both are declared (the stronger signal).
 */
export function evaluateServiceLiveness(
  service: WebEstateService,
  data: SourceData,
  now: Date,
  cfg: BuildConfig,
): boolean | null {
  if (service.deepHealth) {
    if (!data.liveness.health.ok) return null;
    return data.liveness.series.some(
      (s) =>
        s.name === "pulse_deep_health_up" &&
        s.labels.host === service.host &&
        s.labels.service === service.name &&
        s.value === 1,
    );
  }
  if (service.ingressUrl !== undefined) {
    if (!data.checks.health.ok) return null;
    return gatusAlive(data.checks.endpoints, `${service.host}/${service.name}`, now, cfg);
  }
  // Neither signal declared → no affirmative signal exists → `unknown` by design (REQ-STATE-05).
  // `false` (not `null`): the absence is structural, not a source outage, so it must render
  // `unknown` even when every source is healthy ("declared but never monitored", REQ-STATE-03).
  return false;
}
