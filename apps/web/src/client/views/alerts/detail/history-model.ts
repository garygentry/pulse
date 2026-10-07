// src/client/views/alerts/detail/history-model.ts — per-alert firing-history view state, lane
// attribution and domain math. Pure and framework-free; History.tsx renders from it.
//
// Attribution is by the canonical alert-identity tuple + TargetIdentity only, never by the
// Alertmanager fingerprint.
import type {
  ActiveAlert,
  AlertHistoryLane,
  IntervalHistoryPayload,
  RangeId,
  StatusInterval,
  TargetIdentity,
} from "@pulse/web-data/wire";
import type { TimelineLane, TimelineSegment } from "@/ui";
import { INTERVAL_STATUS } from "../../../status/target-status.js";

/** Discriminated union — the ONLY history states the strip renders. No throws. */
export type HistoryViewState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly payload: IntervalHistoryPayload }
  | { readonly kind: "error"; readonly code: string }
  | { readonly kind: "no-ref" };

// ---------------------------------------------------------------------------
// Attribution — canonical aggregation tuple
// ---------------------------------------------------------------------------

/** The canonical alert-identity tuple. Mirrors AlertHistoryLane.labels' key set exactly. */
type CanonicalTuple = Readonly<Record<"alertname" | "severity" | "host" | "service" | "instance", string | null>>;

/** Derive the canonical tuple from an ActiveAlert. alert.name is the authoritative alertname; the
 *  remaining keys read from alert.labels. Absent labels are null (matching the lane's null convention). */
function alertTuple(alert: ActiveAlert): CanonicalTuple {
  const l = alert.labels;
  return {
    alertname: alert.name,
    severity: alert.severity,
    host: l["host"] ?? null,
    service: l["service"] ?? null,
    instance: l["instance"] ?? null,
  };
}

/** Exact TargetIdentity equality on the closed {kind,id} union. Two nulls are NOT equal. */
function targetsEqual(a: TargetIdentity | null, b: TargetIdentity | null): boolean {
  if (a === null || b === null) return false;
  return a.kind === b.kind && a.id === b.id;
}

/**
 * True when `lane` is the selected alert's OWN lane, decided by the canonical aggregation tuple
 * — never the AM fingerprint. When BOTH sides carry a resolved TargetIdentity (the alert via
 * historyRef.target, the lane via lane.target), that identity must also agree, which disambiguates
 * lanes that share labels across targets. Pure/total.
 */
export function isAlertOwnLane(alert: ActiveAlert, lane: AlertHistoryLane): boolean {
  const t = alertTuple(alert);
  const l = lane.labels;
  const tupleMatch =
    t.alertname === l.alertname &&
    t.severity === l.severity &&
    t.host === l.host &&
    t.service === l.service &&
    t.instance === l.instance;
  if (!tupleMatch) return false;

  const refTarget = alert.historyRef?.target ?? null;
  if (refTarget !== null && lane.target !== null) return targetsEqual(refTarget, lane.target);
  return true; // tuple match is sufficient when either side has no resolved target
}

// ---------------------------------------------------------------------------
// Lanes → StatusTimeline mapping
// ---------------------------------------------------------------------------

/** Map one wire StatusInterval to a viz TimelineSegment: ISO bounds → epoch ms, state → TargetStatus. */
function toSegment(iv: StatusInterval): TimelineSegment {
  return {
    status: INTERVAL_STATUS[iv.state],
    start: Date.parse(iv.start),
    end: Date.parse(iv.end),
  };
}

/** Milliseconds spanned by each closed RangeId. The source of record is
 *  packages/web-data/src/queries/ranges.ts; alerts-range-drift.test.ts pins this client-local mirror. */
export const RANGE_MS: Readonly<Record<RangeId, number>> = {
  "1h": 60 * 60_000,
  "6h": 6 * 60 * 60_000,
  "24h": 24 * 60 * 60_000,
  "7d": 7 * 24 * 60 * 60_000,
};

export interface Domain {
  readonly domainStart: number;
  readonly domainEnd: number;
}

/** Fallback domain from the min start / max end across every interval of every lane; a degenerate
 *  [0,1] window when there are no parseable intervals (StatusTimeline treats span 0 as 1). */
function domainFromLanes(lanes: readonly AlertHistoryLane[]): Domain {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const lane of lanes) {
    for (const iv of lane.intervals) {
      const s = Date.parse(iv.start);
      const e = Date.parse(iv.end);
      if (Number.isFinite(s)) min = Math.min(min, s);
      if (Number.isFinite(e)) max = Math.max(max, e);
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return { domainStart: 0, domainEnd: 1 };
  return { domainStart: min, domainEnd: max };
}

/** Prefer the requested range window anchored at payload.fetchedAt; fall back to the lanes' bounds. */
export function deriveDomain(payload: IntervalHistoryPayload): Domain {
  const endMs = Date.parse(payload.fetchedAt);
  const span = RANGE_MS[payload.range] as number | undefined;
  if (Number.isFinite(endMs) && span !== undefined) return { domainStart: endMs - span, domainEnd: endMs };
  return domainFromLanes(payload.lanes);
}

/** Accessible lane label marking the selected alert's own lane and any unmatched lane. */
function laneLabel(lane: AlertHistoryLane, own: boolean): string {
  const base = lane.alertname || lane.labels.alertname || "alert";
  const markers: string[] = [];
  if (own) markers.push("this alert");
  if (lane.attribution === "unmatched") markers.push("unmatched");
  return markers.length > 0 ? `${base} (${markers.join(", ")})` : base;
}

function toTimelineLane(lane: AlertHistoryLane, alert: ActiveAlert): TimelineLane {
  return {
    id: lane.id, // HashId — stable, never the AM fingerprint
    label: laneLabel(lane, isAlertOwnLane(alert, lane)),
    segments: lane.intervals.map(toSegment),
  };
}

/** Order lanes own → matched → unmatched, stable within each group, including EVERY lane (no
 *  truncation). */
export function buildLanes(payload: IntervalHistoryPayload, alert: ActiveAlert): readonly TimelineLane[] {
  const rank = (lane: AlertHistoryLane): number =>
    isAlertOwnLane(alert, lane) ? 0 : lane.attribution === "matched" ? 1 : 2;
  return payload.lanes
    .map((lane, i) => ({ lane, i }))
    .sort((a, b) => rank(a.lane) - rank(b.lane) || a.i - b.i)
    .map(({ lane }) => toTimelineLane(lane, alert));
}
