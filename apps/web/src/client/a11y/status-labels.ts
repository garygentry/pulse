// src/client/a11y/status-labels.ts — screen-reader labels carried from views/overview/a11y.ts (REQ-A11Y-03).
// Every accessible name is built from the SAME resolved fields the visual read uses
// (`data-status` + glyph + colour), so the SR string and the visual state never diverge. This module
// computes NO status — it only phrases the already-resolved `HostStatus`/`ServiceStatus`.

import type { HostStatus, ServiceStatus, TargetStatus } from "../../shared/snapshot.js";

/** Human-readable status word for SR labels (paired with, not replacing, the visual glyph/colour). */
export const STATUS_LABEL: Record<TargetStatus, string> = {
  ok: "OK",
  warning: "warning",
  critical: "critical",
  unknown: "unknown",
  suppressed: "suppressed",
} as const;

/** Accessible name for a host cell: name + roll-up status, plus a service-severity hint when the
 *  roll-up is driven by a service (REQ-A11Y-02, REQ-GRID-03) and a suppression rationale when the
 *  host itself is suppressed (charter invariant 6). Examples:
 *    "Host web-01, OK"
 *    "Host nas-01, critical — 1 of 3 services critical"
 *    "Host old-box, suppressed — excluded: decommissioned" */
export function cellLabel(host: HostStatus): string {
  const base = `Host ${host.name}, ${STATUS_LABEL[host.rollup]}`;

  if (host.suppressed !== null) {
    return `${base} — ${host.suppressed.class}: ${host.suppressed.rationale}`;
  }

  const reason = rollupReason(host);
  return reason === null ? base : `${base} — ${reason}`;
}

/**
 * Why a host's roll-up differs from its own status, e.g. "1 of 7 services unknown", or null when it
 * does not (the roll-up is ok/suppressed, equals the host's own status, or the host is suppressed).
 * The ONE phrasing every surface uses, so a host that reads Unknown on the grid and OK in its drawer
 * always says why (F9/F46).
 */
export function rollupReason(host: HostStatus): string | null {
  if (host.suppressed !== null) return null;
  if (host.rollup === "ok" || host.rollup === "suppressed" || host.status === host.rollup) return null;
  const contributing = host.services.filter((svc) => svc.suppressed === null && svc.status === host.rollup);
  if (contributing.length === 0) return null;
  return `${contributing.length} of ${host.services.length} services ${STATUS_LABEL[host.rollup]}`;
}

/** Accessible name for a service indicator: `"<host> / <service>, <status>"`, with the suppression
 *  rationale appended when the service is suppressed. */
export function serviceLabel(service: ServiceStatus): string {
  const base = `${service.host} / ${service.name}, ${STATUS_LABEL[service.status]}`;
  if (service.suppressed !== null) {
    return `${base} — ${service.suppressed.class}: ${service.suppressed.rationale}`;
  }
  return base;
}
