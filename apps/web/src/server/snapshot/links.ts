// src/server/snapshot/links.ts — Grafana deep-link construction from OBSERVED live-series labels
// (REQ-DRILL-02/03, CON-04). Pure, side-effect-free.
//
// The board per class is fixed (CLASS_BOARDS); the variable VALUE is the OBSERVED live-series label
// the snapshot already holds — never the model's `drilldownId` (which is app-internal, §6.1).
//   - `null`  ⇒ no board for the class, or no observed series for the target (nothing to link to).
//   - `url:""`⇒ board + observed series exist but `cfg.grafanaOrigin` is unset (disabled link, CON-04).

import { CLASS_BOARDS, TARGET_VARS } from "../../shared/constants.js";
import type { LiveSeries } from "../sources/types.js";
import type { BuildConfig } from "./build.js";
import type { WebEstateHost, WebEstateService } from "@pulse/renderer";

/**
 * Build the resolved Grafana link for a host, or `null` when no board maps to its class or no
 * observed series exists (§6.3). `url` is `""` when a board+series exist but `cfg.grafanaOrigin`
 * is unset.
 */
export function hostGrafanaLink(
  host: WebEstateHost,
  series: LiveSeries[],
  cfg: BuildConfig,
): { boardUid: string; url: string } | null {
  const boardUid = CLASS_BOARDS[host.collectionClass];
  if (boardUid === undefined) return null; // probe-only / excluded → no board
  const variable = TARGET_VARS[boardUid]; // "instance" for host boards
  const observed = series.find(
    (s) => s.name === "up" && s.labels.host === host.name,
  )?.labels.instance;
  if (observed === undefined || variable === null) return null; // no observed series → no link
  return { boardUid, url: buildUrl(cfg.grafanaOrigin, boardUid, variable, observed) };
}

/**
 * Build the resolved Grafana link for a service. Only deep-health services have a board
 * (`pulse-deephealth`); all others → `null` (REQ-DRILL-02).
 */
export function serviceGrafanaLink(
  service: WebEstateService,
  series: LiveSeries[],
  cfg: BuildConfig,
): { boardUid: string; url: string } | null {
  if (!service.deepHealth) return null; // no board for non-deep-health
  const boardUid = CLASS_BOARDS["deep-health"]; // "pulse-deephealth"
  if (boardUid === undefined) return null;
  const variable = TARGET_VARS[boardUid]; // "service"
  const observed = series.find(
    (s) =>
      s.name === "pulse_deep_health_up" &&
      s.labels.host === service.host &&
      s.labels.service === service.name,
  )?.labels.service;
  if (observed === undefined || variable === null) return null;
  return { boardUid, url: buildUrl(cfg.grafanaOrigin, boardUid, variable, observed) };
}

/** `""` when origin is unset (disabled); else `<origin>/d/<uid>?var-<var>=<enc>` (origin de-trailing-slashed). */
function buildUrl(origin: string | null, uid: string, variable: string, value: string): string {
  if (origin === null) return "";
  const base = origin.replace(/\/+$/, "");
  return `${base}/d/${uid}?var-${variable}=${encodeURIComponent(value)}`;
}
