// src/client/views/engine/labels.ts — engine display copy, health→status mapping, component and
// deadman presentation, number formatters and the engine board link.
//
// Pure and total: no export throws on any wire value, and formatters never read the clock (the
// caller passes `EstateClock.format`). Locale-independent ("en-US"). Zero formats as zero — only
// null / non-finite / negative sizes read "not reported".

import type {
  AvailabilityState,
  DataAvailability,
  DeadmanState,
  EngineComponent,
  EnginePayload,
  HealthState,
  SourceId,
  TargetStatus,
} from "@pulse/web-data/wire";
import { HEALTH_STATUS } from "../../status/target-status.js";
import type { IconName } from "@/ui";
import type { CapacityTileId, TileValue } from "./model.js";

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

/** Closed engine component id (payload order is authoritative, REQ-COMP-01). */
export type ComponentId = EngineComponent["id"];

/** Presentation kinds for one component card (REQ-COMP-02/04, REQ-EFRESH-02). */
export type ComponentPresentationKind = "not-configured" | "healthy" | "stale" | "unreachable" | "unknown";

/** Derived, render-ready presentation of one `EngineComponent`. */
export interface ComponentPresentation {
  /** Presentation kind (four visibly distinct health states plus stale-healthy). */ readonly kind: ComponentPresentationKind;
  /** Status carried by the badge; "not-configured" maps to "unknown" (told apart by its icon and word). */ readonly status: TargetStatus;
  /** Status word shown next to the glyph, e.g. "Healthy", "Unreachable", "Not configured". */ readonly text: string;
  /** Governing source last-good time (UTC ISO), or null. */ readonly lastGoodAt: string | null;
  /** True when version/uptime must be shown as "last known" (availability not current, REQ-COMP-04). */ readonly qualifyValues: boolean;
}

/** Engine-local mapping of `HealthState` to the viz/ui `TargetStatus` vocabulary. */
export type HealthToStatus = (h: HealthState) => TargetStatus;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The single "not reported" copy (REQ-COMP-03, REQ-NOTIFY-01, REQ-CAP-01). */
export const NOT_REPORTED = "not reported" as const;

/** Display names per component id, in no particular order (payload order drives rendering). */
export const COMPONENT_LABEL: Readonly<Record<ComponentId, string>> = {
  victoriametrics: "VictoriaMetrics", vmalert: "vmalert", alertmanager: "Alertmanager",
  gatus: "Gatus", grafana: "Grafana", web: "Pulse web app",
};

/** Contributors shown inline in the banner before "and N more". */
export const VERDICT_INLINE_CONTRIBUTORS = 3;

/** Grafana board uid for the engine board (REQ-ELINK-01, CON-06; no bound variable). */
export const ENGINE_BOARD_UID = "pulse-engine" as const;

/** Copy for a value whose source is not current (REQ-NOTIFY-01, REQ-CAP-01, REQ-DEGRADE-01). */
export const UNAVAILABLE = "unavailable" as const;

/** Screen-reader description of an absent stat-tile value, per TileValue kind (#15). */
export const ABSENT_TILE_DESCRIPTION: Readonly<Record<"not-reported" | "unavailable", string>> = {
  "not-reported": "the source did not include this metric",
  unavailable: "source not current, so no value is shown",
};

/** Copy used when a source has never had a successful read (no last-good time). */
export const NO_LAST_GOOD = "no successful read yet" as const;

/** Capacity tile labels (REQ-CAP-01). */
export const CAPACITY_TILE_LABEL: Readonly<Record<CapacityTileId, string>> = {
  "ingestion-rate": "Ingestion rate",
  "active-series": "Active series",
  "data-size": "TSDB data size",
  "free-disk": "Free disk",
};

/** Source display names for source-named degraded states (REQ-DEGRADE-01). */
export const SOURCE_LABEL: Readonly<Record<SourceId | "rendered-estate", string>> = {
  "victoriametrics-signals": "VictoriaMetrics metrics",
  "victoriametrics-targets": "VictoriaMetrics target discovery",
  "victoriametrics-buildinfo": "VictoriaMetrics build info",
  "alertmanager-alerts": "Alertmanager",
  "alertmanager-silences": "Alertmanager silences",
  "alertmanager-status": "Alertmanager status",
  "alertmanager-receivers": "Alertmanager receivers",
  "vmalert-rules": "vmalert",
  "gatus-statuses": "Gatus",
  "grafana-health": "Grafana",
  "rendered-estate": "Rendered estate",
};

/** Availability words for degraded text. */
export const AVAILABILITY_WORD: Readonly<Record<AvailabilityState, string>> = {
  current: "current", stale: "stale", unavailable: "unavailable", "not-configured": "not configured",
};

// ---------------------------------------------------------------------------
// Health → status (REQ-COMP-02, REQ-A11Y-01)
// ---------------------------------------------------------------------------

/** Status word for a HealthState (pairs with HEALTH_STATUS/toStatus). */
export const HEALTH_TEXT: Readonly<Record<HealthState, string>> = {
  healthy: "Healthy",
  unhealthy: "Unhealthy",
  unknown: "Unknown",
  "not-configured": "Not configured",
};

const own = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

/**
 * Total version of HEALTH_STATUS for untrusted strings (e.g. RuleState.health): unmapped values →
 * "unknown". Satisfies the HealthToStatus shape.
 * @param h - A health string from the wire.
 */
export function toStatus(h: string): TargetStatus {
  return typeof h === "string" && own(HEALTH_STATUS, h) ? HEALTH_STATUS[h as HealthState] : "unknown";
}

// ---------------------------------------------------------------------------
// Component and deadman presentation (REQ-COMP-01..04, REQ-EFRESH-02, REQ-DEADMAN-01)
// ---------------------------------------------------------------------------

function presentation(
  kind: ComponentPresentationKind,
  status: TargetStatus,
  text: string,
  lastGoodAt: string | null,
  qualifyValues: boolean,
): ComponentPresentation {
  return { kind, status, text, lastGoodAt, qualifyValues };
}

/**
 * Derive a component card's presentation. A not-configured component has status "unknown"; its
 * `minus` icon and "Not configured" word keep it distinct from a real unknown.
 * @param c - The engine component.
 * @param opts.viewNotCurrent - True when the whole engine view is persistently not current. A
 *   "healthy" component then presents as "stale", so live ticks alone never show Healthy
 *   (REQ-EFRESH-02). Default false.
 */
export function componentPresentation(
  c: EngineComponent,
  opts?: { readonly viewNotCurrent?: boolean },
): ComponentPresentation {
  const viewNotCurrent = opts?.viewNotCurrent === true;
  const lastGoodAt = c.availability.lastGoodAt;
  const notCurrent = c.availability.state !== "current" || viewNotCurrent;
  switch (c.state) {
    case "not-configured":
      return presentation("not-configured", "unknown", "Not configured", lastGoodAt, false);
    case "healthy":
      return notCurrent
        ? presentation("stale", "unknown", "Stale", lastGoodAt, true)
        : presentation("healthy", "ok", "Healthy", lastGoodAt, false);
    case "unhealthy":
      return presentation("unreachable", "critical", "Unreachable", lastGoodAt, notCurrent);
    case "unknown":
      return presentation("unknown", "unknown", "Unknown", lastGoodAt, notCurrent);
    default:
      return presentation("unknown", "unknown", "Unknown", lastGoodAt, true);
  }
}

/**
 * Deadman panel presentation (REQ-DEADMAN-01). Not configured has status "unknown" but keeps its own
 * icon (`minus`) and word, so it is distinct from healthy and from a real unknown; an unhealthy
 * deadman reads "Not firing" (the canary must fire continuously).
 * @param d - `engine.deadman`.
 */
export function deadmanPresentation(d: DeadmanState): ComponentPresentation {
  const lastGoodAt = d.availability.lastGoodAt;
  const notCurrent = d.availability.state !== "current";
  if (!d.configured) return presentation("not-configured", "unknown", "Not configured", lastGoodAt, notCurrent);
  switch (d.state) {
    case "healthy":
      return notCurrent
        ? presentation("stale", "unknown", "Stale", lastGoodAt, true)
        : presentation("healthy", "ok", "Healthy", lastGoodAt, false);
    case "unhealthy":
      return presentation("unreachable", "critical", "Not firing", lastGoodAt, notCurrent);
    default:
      return presentation("unknown", "unknown", "Unknown", lastGoodAt, notCurrent);
  }
}

// ---------------------------------------------------------------------------
// Formatters (REQ-COMP-03, REQ-NOTIFY-01, REQ-CAP-01)
// ---------------------------------------------------------------------------

const LOCALE = "en-US";

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

const grouped = (n: number, digits = 0): string =>
  n.toLocaleString(LOCALE, { minimumFractionDigits: digits, maximumFractionDigits: digits });

/** Version string, or NOT_REPORTED for null / empty string. Plain text; never parsed. */
export function formatVersion(version: string | null): string {
  return typeof version === "string" && version !== "" ? version : NOT_REPORTED;
}

/**
 * Uptime from seconds, two largest units: "3d 4h", "5h 12m", "12m 5s", "45s", "0s".
 * @param seconds - EngineComponent.uptimeSeconds.
 */
export function formatUptime(seconds: number | null): string {
  if (!isNum(seconds) || seconds < 0) return NOT_REPORTED;
  const total = Math.floor(seconds);
  const d = Math.floor(total / 86_400);
  const h = Math.floor((total % 86_400) / 3_600);
  const m = Math.floor((total % 3_600) / 60);
  const s = total % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

const IEC_UNITS = ["KiB", "MiB", "GiB", "TiB", "PiB"] as const;

/**
 * Bytes in IEC units: < 1024 → "{n} B"; else scaled to KiB…PiB with 1 decimal when the scaled
 * value is < 100, else 0 decimals ("1.5 GiB", "512 MiB", "0 B").
 */
export function formatBytes(bytes: number | null): string {
  if (!isNum(bytes) || bytes < 0) return NOT_REPORTED;
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < IEC_UNITS.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${grouped(v, v < 100 ? 1 : 0)} ${IEC_UNITS[i]}`;
}

/** Integer count with grouping: 1234567 → "1,234,567". */
export function formatCount(n: number | null): string {
  if (!isNum(n)) return NOT_REPORTED;
  return grouped(Math.round(n));
}

/**
 * Per-second rate: "{num} {noun}/s". num: 0 → "0"; |v| ≥ 100 → grouped integer; |v| ≥ 1 → 1
 * decimal; else 3 significant digits ("0.0123").
 * @param perSecond - The rate value.
 * @param noun - "rows" (ingestion), "failures" (notifications).
 */
export function formatRate(perSecond: number | null, noun: string): string {
  if (!isNum(perSecond)) return NOT_REPORTED;
  const a = Math.abs(perSecond);
  const num = perSecond === 0
    ? "0"
    : a >= 100
      ? grouped(Math.round(perSecond))
      : a >= 1
        ? grouped(perSecond, 1)
        : perSecond.toLocaleString(LOCALE, { maximumSignificantDigits: 3 });
  return `${num} ${noun}/s`;
}

/**
 * Latency in seconds: 0 → "0 ms"; < 0.001 → "<1 ms"; < 1 → "{round(ms)} ms"; < 60 →
 * "{s.toFixed(2)} s"; else "{(s/60).toFixed(1)} min".
 */
export function formatSeconds(seconds: number | null): string {
  if (!isNum(seconds) || seconds < 0) return NOT_REPORTED;
  if (seconds === 0) return "0 ms";
  if (seconds < 0.001) return "<1 ms";
  if (seconds < 1) return `${Math.round(seconds * 1000)} ms`;
  if (seconds < 60) return `${seconds.toFixed(2)} s`;
  return `${(seconds / 60).toFixed(1)} min`;
}

/** Format a TileValue: value → fmt(value); not-reported → NOT_REPORTED; unavailable → UNAVAILABLE. */
export function formatTileValue(v: TileValue, fmt: (n: number) => string): string {
  switch (v.kind) {
    case "value":
      return fmt(v.value);
    case "unavailable":
      return UNAVAILABLE;
    default:
      return NOT_REPORTED;
  }
}

// ---------------------------------------------------------------------------
// Degraded and last-good text (REQ-DEGRADE-01, REQ-COMP-04)
// ---------------------------------------------------------------------------

/**
 * "last good {format(iso)}", or NO_LAST_GOOD when iso is null.
 * @param iso - A UTC ISO last-good time.
 * @param format - `EstateClock.format` (keeps this module clock-free).
 */
export function formatLastGood(iso: string | null, format: (isoUtc: string) => string): string {
  return typeof iso === "string" ? `last good ${format(iso)}` : NO_LAST_GOOD;
}

/**
 * Source-named degraded text for a non-current availability, e.g. "Alertmanager unavailable —
 * last good 2026-09-24 10:03:22 CDT" or "vmalert stale — no successful read yet". Null when the
 * availability is current. An unmapped source or state falls back to the raw string.
 */
export function degradedText(a: DataAvailability, format: (isoUtc: string) => string): string | null {
  if (a.state === "current") return null;
  const source = own(SOURCE_LABEL, a.source) ? SOURCE_LABEL[a.source] : String(a.source);
  const word = own(AVAILABILITY_WORD, a.state) ? AVAILABILITY_WORD[a.state] : String(a.state);
  return `${source} ${word} — ${formatLastGood(a.lastGoodAt, format)}`;
}

// ---------------------------------------------------------------------------
// Engine board URL (REQ-ELINK-01, CON-06, REQ-SEC-03)
// ---------------------------------------------------------------------------

/**
 * The `pulse-engine` board link: `${grafanaBase}/d/${ENGINE_BOARD_UID}`, with no variables. Null
 * (link hidden) when the base is null, the payload has no `grafana` component, or that component
 * is not configured. An unhealthy/unknown Grafana still gets a link.
 * @param grafanaBase - From deriveGrafanaBase (already scheme- and credential-checked).
 * @param engine - The current engine payload.
 */
export function engineBoardUrl(grafanaBase: string | null, engine: EnginePayload): string | null {
  if (grafanaBase === null) return null;
  const grafana = engine.components.find((c) => c.id === "grafana");
  if (grafana === undefined || grafana.state === "not-configured") return null;
  return `${grafanaBase}/d/${ENGINE_BOARD_UID}`;
}

/** Icon per presentation kind. Each of the four health states, and stale-healthy, has its own
 *  icon in addition to the status glyph. */
export const PRESENTATION_ICON: Readonly<Record<ComponentPresentationKind, IconName>> = {
  "not-configured": "minus",
  healthy: "circle-check",
  stale: "clock",
  unreachable: "wifi-off",
  unknown: "circle-help",
};
