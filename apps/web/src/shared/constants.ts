// src/shared/constants.ts — frozen identifiers shared by both tiers.
//
// All identifiers a downstream document, route, component, or the Dockerfile depends on are frozen
// here so every file references the SAME literal. Renaming a board UID or bound variable is a
// breaking change to the upstream `drilldown-links` contract (dashboards REQ-LINK-03) — these
// mirror that frozen contract and are never independently edited.

import type { CollectionClass } from "@pulse/core";

import type { TargetStatus } from "./snapshot.js";

/** The fixed listen port. The slot's `expose`, the healthcheck, and the engine
 *  `web` scrape target are all keyed to it; deliberately NOT env-configurable. */
export const LISTEN_PORT = 8080 as const;

/** The five visual status states (REQ-STATE-01). Order is presentation-only; severity ordering for
 *  roll-up lives in status.ts `ROLLUP_ORDER`. */
export const STATUS_STATES = ["ok", "warning", "critical", "unknown", "suppressed"] as const;

/** Redundant, non-colour glyph per state (REQ-A11Y-01) — paired with colour on every cell/indicator
 *  so the status read never depends on colour alone. Rendered alongside the `data-status` attribute
 *  (§3). Exact glyphs are a client-styling detail; these are the committed defaults. */
export const STATUS_GLYPH: Record<TargetStatus, string> = {
  ok: "●",
  warning: "▲",
  critical: "✖",
  unknown: "?",
  suppressed: "—",
} as const;

/** The five frozen Grafana board UIDs (dashboards `drilldown-links` contract).
 *  `pulse-engine` binds no variable and is the fixed link used for engine-source failures. */
export const BOARD_UIDS = [
  "pulse-host",
  "pulse-deephealth",
  "pulse-hypervisor",
  "pulse-nas",
  "pulse-engine",
] as const;
export type BoardUid = (typeof BOARD_UIDS)[number];

/** The URL-bound template variable each board scopes by (dashboards `drilldown-links` §2). `null`
 *  ⇒ the board binds no variable (fixed link). Mirrors the upstream `TARGET_VARS` exactly. */
export const TARGET_VARS: Record<BoardUid, "instance" | "service" | null> = {
  "pulse-host": "instance",
  "pulse-deephealth": "service",
  "pulse-hypervisor": "instance",
  "pulse-nas": "instance",
  "pulse-engine": null,
} as const;

/** The class → board mapping (REQ-DRILL-03). A `CollectionClass` (host) or the sentinel
 *  `"deep-health"` (a service carrying a deepHealth probe) maps to its board UID; a class absent
 *  here has no drill-down board (`probe-only`/`excluded` hosts; services without deep-health) —
 *  the panel states no dashboard exists rather than emitting an unscoped link (REQ-DRILL-02). */
export const CLASS_BOARDS: Partial<Record<CollectionClass | "deep-health", BoardUid>> = {
  "managed-linux": "pulse-host",
  "hypervisor-api": "pulse-hypervisor",
  "nas-api": "pulse-nas",
  "deep-health": "pulse-deephealth",
} as const;

// SUPPORTED_WEB_MODEL_VERSIONS lives in server/estate/versions.ts: it needs a runtime renderer
// import, and this file is imported by the client bundle (it must stay free of runtime package code).

/** Server refresh cadence: one aggregate fetch set per source every 10s (REQ-PERF-03). */
export const REFRESH_INTERVAL_MS = 10_000 as const;
/** Per-source fetch timeout (REQ-LIVE-04). */
export const SOURCE_TIMEOUT_MS = 5_000 as const;
/** Client snapshot poll cadence (REQ-LIVE-01). Worst-case staleness ≈ 20s < 30s. */
export const POLL_INTERVAL_MS = 10_000 as const;
/** Client polls failing for longer than this raise the app-server stale banner (REQ-LIVE-03). */
export const POLL_STALE_MS = 30_000 as const;
/** Default Gatus evaluation-freshness threshold (REQ-STATE-05, §3.5); overridable via env (§6). */
export const GATUS_STALE_SECONDS_DEFAULT = 300 as const;

/** The always-firing DeadMansSwitch alert is excluded from cell matching and from the strip.
 *  Matched by alertname. */
export const DEADMANS_SWITCH_ALERTNAME = "DeadMansSwitch" as const;

/** The app's complete environment-variable contract. Names only; required-ness
 *  and defaults are enforced by `server/index.ts` env parsing. */
export const ENV = {
  VM_URL: "PULSE_VM_URL",
  ALERTMANAGER_URL: "PULSE_ALERTMANAGER_URL",
  GATUS_URL: "PULSE_GATUS_URL",
  VMALERT_URL: "PULSE_VMALERT_URL",
  WEB_ESTATE_MODEL: "PULSE_WEB_ESTATE_MODEL",
  ESTATE_TZ: "PULSE_ESTATE_TZ",
  GRAFANA_URL: "PULSE_GRAFANA_URL",
  GATUS_STALE_SECONDS: "PULSE_GATUS_STALE_SECONDS",
  WEB_AUTH_MODE: "PULSE_WEB_AUTH_MODE",
  WEB_AUTH_HEADER: "PULSE_WEB_AUTH_HEADER",
  WEB_TRUSTED_PROXIES: "PULSE_WEB_TRUSTED_PROXIES",
} as const;
