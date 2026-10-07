// src/client/views/timeline/evidence.ts — per-lane status evidence: alert attribution, check
// evidence, coverage-probe no-data spans, the segment sweep and its memo (05 §5).
// Pure and DOM-free; never throws on wire data (00 §8.1). Time is epoch seconds.

import type {
  AlertHistoryLane,
  EndpointHistoryPayload,
  HistoryPayload,
  HistorySeries,
  TargetStatus,
  TimelinePayload,
} from "@pulse/web-data/wire";
import type { TimelineSegment } from "@/ui";
import type { TimeWindow } from "../_shared/timeseries/axis.js";
import type { HistoryRegionState } from "../_shared/timeseries/history/client.js";
import { targetKey } from "./model.js";
import type { LaneNode, LaneTree, TargetKey } from "./model.js";

// ---------------------------------------------------------------------------
// Types (00 §5.4) and constants (00 §6.3)
// ---------------------------------------------------------------------------

/** Why a lane carries the partial-evidence marker (REQ-LANE-04; tech-spec §3.5 reasons). */
export type PartialReason = "not-loaded" | "loading" | "evidence-unavailable" | "coverage-limited";

/** The state of one endpoint's check evidence for a lane. */
export type CheckEvidence =
  | { readonly endpoint: string; readonly state: "not-loaded" | "loading" | "unavailable" | "error" }
  | { readonly endpoint: string; readonly state: "ready"; readonly payload: EndpointHistoryPayload };

/** Inputs to `deriveLaneSegments` for one lane. */
export interface LaneEvidenceInput {
  /** Evaluation window, epoch seconds. */ readonly window: TimeWindow;
  /** Alert lanes attributed to this lane (collapsed host: own + all services'); null = alerts not loaded. */ readonly alerts: readonly AlertHistoryLane[] | null;
  /** Check evidence per contributing endpoint. Empty for hosts with no endpoints of their own. */ readonly checks: readonly CheckEvidence[];
  /** True when contributing check evidence exists but is not attached (a collapsed host, REQ-LANE-04). */ readonly checksNotLoaded: boolean;
  /** No-data spans from the coverage probe, or null when the probe is not loaded (whole window = no data). */ readonly noData: readonly TimeWindow[] | null;
  /**
   * True for domain lanes, which have no alert evidence: each ready endpoint's span before its check
   * coverage starts counts as a check gap (no data), never OK. It ranks like any check gap, so a
   * check failure on another endpoint still wins in the Domains header.
   */
  readonly preCoverageIsNoData?: boolean;
}

/** Why a segment has its status (drives readout/legend text; REQ-LANE-03, REQ-A11Y-01). */
export type SegmentCause = "ok" | "alert" | "check" | "no-data";

/** A lane segment: a viz TimelineSegment plus its cause and contributing alert names. */
export interface LaneSegment extends TimelineSegment {
  /** Why this segment has its status. */ readonly cause: SegmentCause;
  /** Distinct alert names firing in this segment (incl. info-severity, which does not change status). */ readonly alertnames: readonly string[];
}

/** Result of deriving one lane's segments. */
export interface LaneEvidenceResult {
  /** Ordered, non-overlapping segments covering the window exactly. */ readonly segments: readonly LaneSegment[];
  /** Partial-evidence reason, or null when evidence is complete for the window. */ readonly partial: PartialReason | null;
  /** When `partial === "coverage-limited"`: epoch seconds of the earliest covered check result; else null. */ readonly coverageSince: number | null;
}

/** Status rank for worst-of merging: critical > warning > ok (REQ-LANE-02). */
export type RankedStatus = Extract<TargetStatus, "ok" | "warning" | "critical">;

/** A Gatus result gap longer than this multiple of the median spacing is "no data" (tech-spec §3.5). */
export const CHECK_GAP_FACTOR = 3;

// ---------------------------------------------------------------------------
// Copy constants (05 §5.1)
// ---------------------------------------------------------------------------

/**
 * Readout/legend reason text per partial reason (TS §3.5). "{t}" is replaced by the formatted
 * coverage start in estate time (partialReasonText).
 */
export const PARTIAL_REASON_TEXT: Readonly<Record<PartialReason, string>> = {
  "not-loaded": "not loaded",
  loading: "loading",
  "evidence-unavailable": "evidence unavailable",
  "coverage-limited": "check history covers only since {t}",
};

/** Lane-label suffix for partial lanes (text carrier; the dashed outline is secondary). */
export const PARTIAL_EVIDENCE_TEXT = "partial evidence";

/** Readout/legend word for a no-data span (status "unknown", cause "no-data"). */
export const NO_DATA_TEXT = "no data";

/** Service-lane label when the index lists none of the lane's endpoints (09 §1). */
export const CHECK_HISTORY_UNAVAILABLE_TEXT = "check history not available";

/**
 * Resolve the reason text for a result, or null when evidence is complete.
 * @param result - A derived lane result.
 * @param formatSec - Formats epoch seconds in estate time.
 */
export function partialReasonText(result: LaneEvidenceResult, formatSec: (epochSec: number) => string): string | null {
  if (result.partial === null) return null;
  const text = PARTIAL_REASON_TEXT[result.partial];
  return result.partial === "coverage-limited" && result.coverageSince !== null
    ? text.replace("{t}", formatSec(result.coverageSince))
    : text;
}

// ---------------------------------------------------------------------------
// Gate and severity (05 §5.2, §5.3)
// ---------------------------------------------------------------------------

/** Per-index set of addressable endpoint keys; weakly held so a replaced index is collected. */
const addressableCache = new WeakMap<TimelinePayload, ReadonlySet<string>>();

/**
 * Whether `/api/history/checks/{endpointKey}` (and the service latency chart for it) can be requested
 * (09 §1, REQ-ECR-C1): true iff the key is non-empty and listed in the index's addressable check
 * endpoints. The key's shape does not matter; `historyUrl` encodes a "/" as `%2F`. False for a null
 * index (before the first delivery), so no request is issued then.
 * @param endpointKey - Gatus endpoint key (e.g. "web01/nginx").
 * @param index - The timeline index, or null.
 */
export function checkHistoryReachable(endpointKey: string, index: TimelinePayload | null): boolean {
  if (endpointKey === "" || index === null) return false;
  let listed = addressableCache.get(index);
  if (listed === undefined) {
    listed = new Set(index.checkHistory.endpoints);
    addressableCache.set(index, listed);
  }
  return listed.has(endpointKey);
}

/**
 * Map an alert severity to the lane status it contributes: critical → critical, warning → warning,
 * unknown → warning (conservative), info → null (no status change; listed in readout/tooltip only).
 * An out-of-contract severity is treated like unknown (never throws).
 */
export function severityStatus(severity: AlertHistoryLane["severity"]): Exclude<RankedStatus, "ok"> | null {
  switch (severity) {
    case "critical": return "critical";
    case "warning": return "warning";
    case "info": return null;
    default: return "warning";
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** ISO-8601 → epoch seconds, or null when unparseable (never throws). */
function isoToSec(iso: string): number | null {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms / 1000 : null;
}

function validWindow(w: TimeWindow): boolean {
  return Number.isFinite(w.start) && Number.isFinite(w.end) && w.end > w.start;
}

/** Clip [s, e) to the window; null when the result is empty. */
function clip(s: number, e: number, w: TimeWindow): TimeWindow | null {
  const start = Math.max(s, w.start);
  const end = Math.min(e, w.end);
  return end > start ? { start, end } : null;
}

// ---------------------------------------------------------------------------
// alertsForLane (05 §5.4)
// ---------------------------------------------------------------------------

interface NodeAlerts {
  collapsed?: readonly AlertHistoryLane[];
  own?: readonly AlertHistoryLane[];
}
interface LanesIndex {
  readonly byTarget: ReadonlyMap<TargetKey, readonly AlertHistoryLane[]>;
  readonly nodes: WeakMap<LaneNode, NodeAlerts>;
}

const EMPTY_LANES: readonly AlertHistoryLane[] = Object.freeze([]);
const alertIndexCache = new WeakMap<readonly AlertHistoryLane[], LanesIndex>();

function lanesIndex(lanes: readonly AlertHistoryLane[]): LanesIndex {
  const hit = alertIndexCache.get(lanes);
  if (hit !== undefined) return hit;
  const byTarget = new Map<TargetKey, AlertHistoryLane[]>();
  for (const lane of lanes) {
    if (lane.attribution !== "matched" || lane.target === null || lane.target === undefined) continue;
    const key = targetKey(lane.target);
    const list = byTarget.get(key);
    if (list === undefined) byTarget.set(key, [lane]);
    else list.push(lane);
  }
  const index: LanesIndex = { byTarget, nodes: new WeakMap() };
  alertIndexCache.set(lanes, index);
  return index;
}

/**
 * The alert lanes that count toward a lane's status. Collapsed host: own + every child service's
 * matched lanes. Expanded host: own only. Service: own. Unmatched lanes are never attributed.
 * Identity-stable per (lanes, node, expanded).
 *
 * @param lanes - `IntervalHistoryPayload.lanes` of the ready alerts payload, or null when not loaded or failed.
 * @param node - The lane.
 * @param expanded - For hosts, whether the host is expanded. Ignored for services.
 * @returns The attributed lanes, or null when `lanes` is null.
 */
export function alertsForLane(
  lanes: readonly AlertHistoryLane[] | null,
  node: LaneNode,
  expanded: boolean,
): readonly AlertHistoryLane[] | null {
  if (lanes === null) return null;
  const index = lanesIndex(lanes);
  let entry = index.nodes.get(node);
  if (entry === undefined) {
    entry = {};
    index.nodes.set(node, entry);
  }
  const own = (n: LaneNode): readonly AlertHistoryLane[] => index.byTarget.get(targetKey(n.target)) ?? EMPTY_LANES;
  const collapsedHost = node.target.kind === "host" && !expanded;
  if (!collapsedHost) {
    entry.own ??= own(node);
    return entry.own;
  }
  if (entry.collapsed === undefined) {
    const parts = [own(node), ...node.children.map(own)].filter((p) => p.length > 0);
    entry.collapsed = parts.length === 0 ? EMPTY_LANES : parts.length === 1 ? parts[0]! : parts.flat();
  }
  return entry.collapsed;
}

// ---------------------------------------------------------------------------
// Check evidence (05 §5.5)
// ---------------------------------------------------------------------------

/**
 * Build a lane's CheckEvidence list from per-endpoint history region states (05 §5.5 table).
 * @param node - The lane (only service lanes have endpoints).
 * @param lookup - Region state per endpoint.
 * @param reachable - Reachability gate: the view passes `(key) => checkHistoryReachable(key, index)`.
 */
export function checkEvidenceFor(
  node: LaneNode,
  lookup: (endpoint: string) => HistoryRegionState<EndpointHistoryPayload> | undefined,
  reachable: (key: string) => boolean,
): readonly CheckEvidence[] {
  return endpointCheckEvidence(node.endpoints, lookup, reachable);
}

/**
 * CheckEvidence for a list of endpoint keys (the 05 §5.5 table). Shared by service lanes
 * (checkEvidenceFor) and domain lanes (domainEvidenceInput, 09 §3).
 */
export function endpointCheckEvidence(
  endpoints: readonly string[],
  lookup: (endpoint: string) => HistoryRegionState<EndpointHistoryPayload> | undefined,
  reachable: (key: string) => boolean,
): readonly CheckEvidence[] {
  return endpoints.map((endpoint): CheckEvidence => {
    if (!reachable(endpoint)) return { endpoint, state: "unavailable" };
    const region = lookup(endpoint);
    if (region === undefined) return { endpoint, state: "not-loaded" };
    switch (region.phase) {
      case "idle":
        return { endpoint, state: "not-loaded" };
      case "loading":
        return region.previous === null ? { endpoint, state: "loading" } : { endpoint, state: "ready", payload: region.previous };
      case "ready":
        return { endpoint, state: "ready", payload: region.data };
      case "error":
        return region.previous === null ? { endpoint, state: "error" } : { endpoint, state: "ready", payload: region.previous };
      default:
        return { endpoint, state: "unavailable" };
    }
  });
}

/**
 * LaneEvidenceInput for a domain lane, or for the Domains header over all its domain endpoints
 * (09 §3, REQ-ECR-C3). Check evidence only: domain alerts are never attributed to a lane (they stay
 * unmatched in the swimlane), so `alerts` is the empty list once any endpoint has check data, and
 * null (whole window reads no data) until then. Each endpoint's span before its check coverage starts
 * is a check gap (`preCoverageIsNoData`), so a domain lane never looks healthy without evidence.
 * The coverage no-data spans apply as for every lane. Merging several endpoints into one input gives
 * the header the worst of its domain lanes (critical > gap/no data > ok), and a loading or failed
 * endpoint makes it partial.
 */
export function domainEvidenceInput(args: {
  /** Domain endpoint keys (`dns:<domain>`): one for a domain lane, all of them for the header. */ readonly endpoints: readonly string[];
  /** Region state lookup for an endpoint's check history. */ readonly lookup: (endpoint: string) => HistoryRegionState<EndpointHistoryPayload> | undefined;
  /** No-data spans from noDataSpans, or null when the probe is not ready. */ readonly noData: readonly TimeWindow[] | null;
  /** Evaluation window (the axis domain; see §5.12). */ readonly window: TimeWindow;
  /** Check-history gate (09 §1). */ readonly reachable: (key: string) => boolean;
}): LaneEvidenceInput {
  const checks = endpointCheckEvidence(args.endpoints, args.lookup, args.reachable);
  return {
    window: args.window,
    alerts: checks.some((c) => c.state === "ready") ? EMPTY_LANES : null,
    checks,
    checksNotLoaded: false,
    noData: args.noData,
    preCoverageIsNoData: true,
  };
}

/**
 * Assemble the full LaneEvidenceInput for one visible lane, applying the collapse rules (05 §5.5).
 */
export function laneEvidenceInput(args: {
  /** The lane. */ readonly node: LaneNode;
  /** Host expansion state (ignored for services). */ readonly expanded: boolean;
  /** Ready alerts payload lanes, or null when not loaded or failed. */ readonly alertLanes: readonly AlertHistoryLane[] | null;
  /** Region state lookup for an endpoint's check history. */ readonly lookup: (endpoint: string) => HistoryRegionState<EndpointHistoryPayload> | undefined;
  /** No-data spans from noDataSpans, or null when the probe is not ready. */ readonly noData: readonly TimeWindow[] | null;
  /** Evaluation window (the axis domain; see §5.12). */ readonly window: TimeWindow;
  /** Check-history gate (09 §1): `(key) => checkHistoryReachable(key, index)`. */ readonly reachable: (key: string) => boolean;
}): LaneEvidenceInput {
  const { node, expanded, alertLanes, lookup, noData, window, reachable } = args;
  if (node.target.kind === "host") {
    return {
      window,
      alerts: alertsForLane(alertLanes, node, expanded),
      checks: [],
      checksNotLoaded: !expanded && node.children.some((c) => c.endpoints.length > 0),
      noData,
    };
  }
  return {
    window,
    alerts: alertsForLane(alertLanes, node, false),
    checks: checkEvidenceFor(node, lookup, reachable),
    checksNotLoaded: false,
    noData,
  };
}

/**
 * The endpoints whose check history the page should request: endpoints of services under EXPANDED
 * hosts, then every domain endpoint (whether or not the Domains group is expanded, so the collapsed
 * header and kiosk show a real status; 09 §3), each passing `reachable`, deduplicated, in tree order.
 */
export function requiredCheckEndpoints(
  tree: LaneTree,
  expanded: ReadonlySet<TargetKey>,
  reachable: (key: string) => boolean,
): readonly string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const host of tree.hosts) {
    if (!expanded.has(targetKey(host.target))) continue;
    for (const svc of host.children) {
      for (const e of svc.endpoints) {
        if (seen.has(e) || !reachable(e)) continue;
        seen.add(e);
        out.push(e);
      }
    }
  }
  for (const d of tree.domains) {
    if (seen.has(d.endpoint) || !reachable(d.endpoint)) continue;
    seen.add(d.endpoint);
    out.push(d.endpoint);
  }
  return out;
}

// ---------------------------------------------------------------------------
// noDataSpans (05 §5.7)
// ---------------------------------------------------------------------------

const noDataMemo = new WeakMap<HistoryPayload, { readonly key: string; readonly result: readonly TimeWindow[] }>();

/**
 * Spans inside `window` with no evidence: the complement, within `window`, of (coverage-probe
 * coverage ∩ (−∞, dataEnd)), where dataEnd = min(probe.fetchedAt, alertsFetchedAt). Each non-null
 * point covers [t, t + min(gap to next point, 2 × step)). Memoized per probe identity, so repeated
 * calls with the same (payload, alertsFetchedAt, window) return the same array.
 *
 * @param probe - The ready (or previous, while refreshing) coverage-probe payload.
 * @param window - The evaluation window (the axis domain).
 * @param alertsFetchedAt - `fetchedAt` of the alerts payload, or null when alerts are not loaded.
 * @returns Sorted, non-overlapping, non-empty spans clipped to `window`.
 */
export function noDataSpans(
  probe: HistoryPayload,
  window: TimeWindow,
  alertsFetchedAt: string | null,
): readonly TimeWindow[] {
  const key = `${alertsFetchedAt ?? ""}|${window.start}|${window.end}`;
  const hit = noDataMemo.get(probe);
  if (hit !== undefined && hit.key === key) return hit.result;
  const result = computeNoData(probe, window, alertsFetchedAt);
  noDataMemo.set(probe, { key, result });
  return result;
}

function computeNoData(probe: HistoryPayload, window: TimeWindow, alertsFetchedAt: string | null): readonly TimeWindow[] {
  if (!validWindow(window)) return [];
  const dataEnd = Math.min(
    isoToSec(probe.fetchedAt) ?? Infinity,
    alertsFetchedAt === null ? Infinity : isoToSec(alertsFetchedAt) ?? Infinity,
  );
  const rawStep = probe.effectiveStepSeconds;
  const step = Number.isFinite(rawStep) && rawStep > 0 ? rawStep : 60;
  const tolerance = 2 * step;

  const covered: TimeWindow[] = [];
  const series = Array.isArray(probe.series) ? probe.series : [];
  for (const s of series) {
    const raw: HistorySeries["points"] = Array.isArray(s.points) ? s.points : [];
    const pts = raw.filter((p) => Number.isFinite(p[0]));
    for (let i = 0; i < pts.length; i++) {
      const [ms, value] = pts[i]!;
      if (value === null) continue;
      const t = ms / 1000;
      const next = pts[i + 1];
      const span = next === undefined ? tolerance : Math.min(next[0] / 1000 - t, tolerance);
      const end = Math.min(t + span, dataEnd);
      if (end > t) covered.push({ start: t, end });
    }
  }
  if (series.length > 1) covered.sort((a, b) => a.start - b.start);

  const out: TimeWindow[] = [];
  let cursor = window.start;
  for (const c of covered) {
    if (c.start > cursor) {
      const gap = clip(cursor, c.start, window);
      if (gap !== null) out.push(gap);
    }
    if (c.end > cursor) cursor = c.end;
    if (cursor >= window.end) break;
  }
  if (cursor < window.end) out.push({ start: Math.max(cursor, window.start), end: window.end });
  return out;
}

// ---------------------------------------------------------------------------
// checkSpans (05 §5.8, private)
// ---------------------------------------------------------------------------

/** Check-derived spans for one endpoint, clipped to the window. */
interface CheckSpans {
  /** Spans where the check failed (critical). */ readonly fail: readonly TimeWindow[];
  /** Spans inside the coverage window with no results (check "no data"). */ readonly gap: readonly TimeWindow[];
  /** Coverage start: the first result time, or fetchedAt when there are no results; null if both are unparseable. */ readonly coveredFrom: number | null;
}

function median(sorted: readonly number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function checkSpans(payload: EndpointHistoryPayload, window: TimeWindow): CheckSpans {
  const parsed: { t: number; ok: boolean }[] = [];
  for (const r of Array.isArray(payload.results) ? payload.results : []) {
    const t = isoToSec(r.timestamp);
    if (t !== null) parsed.push({ t, ok: r.success !== false });
  }
  parsed.sort((a, b) => a.t - b.t);
  // Keep the last entry per duplicate timestamp (stable sort keeps payload order within a tie).
  const results = parsed.filter((r, i) => i === parsed.length - 1 || parsed[i + 1]!.t !== r.t);
  const n = results.length;
  const fetched = isoToSec(payload.fetchedAt) ?? (n > 0 ? results[n - 1]!.t : null);
  if (n === 0) return { fail: [], gap: [], coveredFrom: fetched };

  const gaps: number[] = [];
  for (let i = 1; i < n; i++) gaps.push(results[i]!.t - results[i - 1]!.t);
  gaps.sort((a, b) => a - b);
  const m = n < 2 ? null : median(gaps);
  const limit = m === null ? Infinity : CHECK_GAP_FACTOR * m;

  const fail: TimeWindow[] = [];
  const gap: TimeWindow[] = [];
  const push = (list: TimeWindow[], s: number, e: number): void => {
    const c = clip(s, e, window);
    if (c !== null) list.push(c);
  };
  for (let i = 0; i < n; i++) {
    const { t, ok } = results[i]!;
    const next = i < n - 1 ? results[i + 1]!.t : Math.max(t, fetched ?? t);
    const ce = m !== null && next - t > limit ? t + m : next;
    if (!ok) push(fail, t, ce);
    if (ce < next) push(gap, ce, next);
  }
  for (const inc of Array.isArray(payload.incidents) ? payload.incidents : []) {
    const s = isoToSec(inc.start);
    const e = isoToSec(inc.end);
    if (s === null || e === null || e <= s) continue;
    push(fail, s, fetched === null ? e : Math.min(e, fetched));
  }
  return { fail, gap, coveredFrom: results[0]!.t };
}

// ---------------------------------------------------------------------------
// deriveLaneSegments (05 §5.9)
// ---------------------------------------------------------------------------

type Channel = "alertCrit" | "alertWarn" | "alertInfo" | "checkFail" | "checkGap" | "probe";
interface Delta {
  /** Time of the change, epoch seconds. */ readonly t: number;
  /** Channel whose counter changes. */ readonly ch: Channel;
  /** +1 = the span enters, −1 = the span leaves. */ readonly d: 1 | -1;
  /** Alertname for alert channels, or null. */ readonly name: string | null;
}

const PRECEDENCE: readonly PartialReason[] = ["evidence-unavailable", "loading", "not-loaded", "coverage-limited"];

function partialOf(
  input: LaneEvidenceInput,
  ready: readonly CheckSpans[],
): { partial: PartialReason | null; coverageSince: number | null } {
  const reasons = new Set<PartialReason>();
  if (input.checksNotLoaded) reasons.add("not-loaded");
  for (const c of input.checks) {
    if (c.state === "not-loaded") reasons.add("not-loaded");
    else if (c.state === "loading") reasons.add("loading");
    else if (c.state === "unavailable" || c.state === "error") reasons.add("evidence-unavailable");
  }
  let since: number | null = null;
  if (ready.length > 0) {
    let anyNull = false;
    let max = -Infinity;
    for (const r of ready) {
      if (r.coveredFrom === null) anyNull = true;
      else if (r.coveredFrom > max) max = r.coveredFrom;
    }
    since = anyNull ? null : max;
    if (since === null || since > input.window.start) {
      reasons.add("coverage-limited");
      since ??= input.window.end;
    }
  }
  const partial = PRECEDENCE.find((p) => reasons.has(p)) ?? null;
  return { partial, coverageSince: partial === "coverage-limited" ? since : null };
}

/**
 * Derive one lane's status segments over `input.window`. Pure; never throws. Segments are ordered,
 * contiguous and cover [window.start, window.end) exactly; adjacent equal segments coalesce. An empty
 * or invalid window gives { segments: [], partial: null, coverageSince: null }.
 */
export function deriveLaneSegments(input: LaneEvidenceInput): LaneEvidenceResult {
  const w = input.window;
  if (!validWindow(w)) return { segments: [], partial: null, coverageSince: null };

  const ready: CheckSpans[] = [];
  for (const c of input.checks) if (c.state === "ready") ready.push(checkSpans(c.payload, w));
  const { partial, coverageSince } = partialOf(input, ready);

  if (input.alerts === null || input.noData === null) {
    return {
      segments: [{ start: w.start, end: w.end, status: "unknown", cause: "no-data", alertnames: [] }],
      partial,
      coverageSince,
    };
  }

  const deltas: Delta[] = [];
  const span = (s: number, e: number, ch: Channel, name: string | null): void => {
    const c = clip(s, e, w);
    if (c === null) return;
    deltas.push({ t: c.start, ch, d: 1, name }, { t: c.end, ch, d: -1, name });
  };
  for (const lane of input.alerts) {
    const status = severityStatus(lane.severity);
    const ch: Channel = status === "critical" ? "alertCrit" : status === "warning" ? "alertWarn" : "alertInfo";
    for (const iv of lane.intervals) {
      const s = isoToSec(iv.start);
      const e = isoToSec(iv.end);
      if (s === null || e === null || e <= s) continue;
      span(s, e, ch, lane.alertname);
    }
  }
  for (const r of ready) {
    for (const f of r.fail) span(f.start, f.end, "checkFail", null);
    for (const g of r.gap) span(g.start, g.end, "checkGap", null);
    if (input.preCoverageIsNoData === true) span(w.start, r.coveredFrom ?? w.end, "checkGap", null);
  }
  for (const nd of input.noData) span(nd.start, nd.end, "probe", null);
  deltas.sort((a, b) => a.t - b.t);

  const count: Record<Channel, number> = { alertCrit: 0, alertWarn: 0, alertInfo: 0, checkFail: 0, checkGap: 0, probe: 0 };
  const names = new Map<string, number>();
  const segments: LaneSegment[] = [];
  let prevKey = "";
  let i = 0;
  let cursor = w.start;
  while (cursor < w.end) {
    while (i < deltas.length && deltas[i]!.t <= cursor) {
      const dl = deltas[i++]!;
      count[dl.ch] += dl.d;
      if (dl.name !== null) {
        const n = (names.get(dl.name) ?? 0) + dl.d;
        if (n > 0) names.set(dl.name, n);
        else names.delete(dl.name);
      }
    }
    const next = i < deltas.length ? Math.min(deltas[i]!.t, w.end) : w.end;

    let status: LaneSegment["status"];
    let cause: SegmentCause;
    if (count.probe > 0) {
      status = "unknown";
      cause = "no-data";
    } else {
      const a = count.alertCrit > 0 ? 3 : count.alertWarn > 0 ? 2 : 0;
      const c = count.checkFail > 0 ? 3 : count.checkGap > 0 ? 1 : 0;
      const r = Math.max(a, c);
      if (r === 3) { status = "critical"; cause = a === 3 ? "alert" : "check"; }
      else if (r === 2) { status = "warning"; cause = "alert"; }
      else if (r === 1) { status = "unknown"; cause = "no-data"; }
      else { status = "ok"; cause = "ok"; }
    }
    const alertnames = [...names.keys()].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
    const key = `${status}|${cause}|${alertnames.join("\u0000")}`;
    const last = segments[segments.length - 1];
    if (last !== undefined && key === prevKey) last.end = next;
    else segments.push({ start: cursor, end: next, status, cause, alertnames });
    prevKey = key;
    cursor = next;
  }
  return { segments, partial, coverageSince };
}

// ---------------------------------------------------------------------------
// segmentAt (05 §5.10) and problemHostKeys (05 §5.11)
// ---------------------------------------------------------------------------

/**
 * The segment containing time t (start ≤ t < end), by binary search. O(log n). t equal to the last
 * segment's end returns the last segment. Returns null for an empty list or t outside
 * [first.start, last.end].
 */
export function segmentAt(segments: readonly LaneSegment[], t: number): LaneSegment | null {
  const n = segments.length;
  if (n === 0 || !(t >= segments[0]!.start) || !(t <= segments[n - 1]!.end)) return null;
  if (t === segments[n - 1]!.end) return segments[n - 1]!;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (segments[mid]!.start <= t) lo = mid;
    else hi = mid - 1;
  }
  return segments[lo]!;
}

/**
 * Keys of hosts whose collapsed-lane alert evidence has any status-changing interval (critical,
 * warning or unknown severity; info excluded) intersecting `window`. Ignores no-data spans.
 */
export function problemHostKeys(tree: LaneTree, lanes: readonly AlertHistoryLane[], window: TimeWindow): ReadonlySet<TargetKey> {
  const out = new Set<TargetKey>();
  for (const host of tree.hosts) {
    const attributed = alertsForLane(lanes, host, false) ?? EMPTY_LANES;
    const problem = attributed.some((lane) =>
      severityStatus(lane.severity) !== null &&
      lane.intervals.some((iv) => {
        const s = isoToSec(iv.start);
        const e = isoToSec(iv.end);
        return s !== null && e !== null && e > s && s < window.end && e > window.start;
      }));
    if (problem) out.add(targetKey(host.target));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Memoization (05 §5.12)
// ---------------------------------------------------------------------------

/** Per-lane memo of deriveLaneSegments results. */
export interface LaneEvidenceCache {
  /**
   * Return the cached result for `key` when the new input is equivalent to the previous one; otherwise
   * derive, store and return. Equivalent means: same `alerts` reference; same `noData` reference;
   * equal `window.start`/`window.end`; equal `checksNotLoaded` and `preCoverageIsNoData`; `checks` of equal length whose
   * elements have equal `endpoint` and `state` and (when ready) the same `payload` reference.
   */
  derive(key: string, input: LaneEvidenceInput): LaneEvidenceResult;
  /** Drop entries whose key is not in `live` (call after a tree change or a collapse). */
  prune(live: ReadonlySet<string>): void;
}

function equivalent(a: LaneEvidenceInput, b: LaneEvidenceInput): boolean {
  if (a.alerts !== b.alerts || a.noData !== b.noData || a.preCoverageIsNoData !== b.preCoverageIsNoData) return false;
  if (a.window.start !== b.window.start || a.window.end !== b.window.end) return false;
  if (a.checksNotLoaded !== b.checksNotLoaded || a.checks.length !== b.checks.length) return false;
  return a.checks.every((x, i) => {
    const y = b.checks[i]!;
    if (x.endpoint !== y.endpoint || x.state !== y.state) return false;
    return x.state !== "ready" || y.state !== "ready" || x.payload === y.payload;
  });
}

/**
 * Create a cache (one per TimelineView mount).
 * @param derive - The derivation; injectable so tests can count calls. Defaults to deriveLaneSegments.
 */
export function createLaneEvidenceCache(
  derive: (input: LaneEvidenceInput) => LaneEvidenceResult = deriveLaneSegments,
): LaneEvidenceCache {
  const entries = new Map<string, { readonly input: LaneEvidenceInput; readonly result: LaneEvidenceResult }>();
  return {
    derive(key, input) {
      const hit = entries.get(key);
      if (hit !== undefined && equivalent(hit.input, input)) return hit.result;
      const result = derive(input);
      entries.set(key, { input, result });
      return result;
    },
    prune(live) {
      for (const key of [...entries.keys()]) if (!live.has(key)) entries.delete(key);
    },
  };
}
