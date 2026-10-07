// Pure status-lane model: block/row partitioning, per-row evidence composition, the "worst in view"
// row summary, estate-time axis ticks and the row presentation helpers used by lanes.tsx. No JSX.
import type { AlertHistoryLane, EndpointHistoryPayload, TargetStatus, TimelineDomain } from "@pulse/web-data/wire";
import { STATUS_LABEL } from "../../a11y/status-labels.js";
import type { EstateClock } from "../../format.js";
import type { TimeWindow } from "../_shared/timeseries/axis.js";
import type { HistoryRegionState } from "../_shared/timeseries/history/client.js";
import type { LaneNode, TargetKey } from "./model.js";
import { targetKey } from "./model.js";
import { zoneOffsetSeconds } from "../_shared/timeseries/tz-shift.js";
import { CHECK_HISTORY_UNAVAILABLE_TEXT, NO_DATA_TEXT, PARTIAL_EVIDENCE_TEXT, domainEvidenceInput, laneEvidenceInput } from "./evidence.js";
import type { LaneEvidenceCache, LaneEvidenceResult, LaneSegment } from "./evidence.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Gap between lanes in SVG px (the StatusTimeline default). */
export const LANE_GAP_PX = 2;
/** Row height used before measurement: StatusTimeline's default laneHeight (16) + gap (2). */
export const DEFAULT_ROW_PX = 18;
/** Smallest SVG plot width; below this the plot column scrolls horizontally. Equals the StatusTimeline default width. */
export const MIN_PLOT_WIDTH_PX = 320;
/** Readout order of the first lane block; block i registers at LANE_READOUT_ORDER + i (lanes read first). */
export const LANE_READOUT_ORDER = 0;

// ---------------------------------------------------------------------------
// Blocks and rows
// ---------------------------------------------------------------------------

/** One row of the lane tree; every row is exactly one lane in one block. */
export type LaneRow =
  | {
      /** Host lane. */ readonly kind: "host";
      /** `targetKey(node.target)`. */ readonly key: TargetKey;
      /** The host node. */ readonly node: LaneNode;
      /** Tree level. */ readonly level: 1;
      /** True when the host has at least one service. */ readonly expandable: boolean;
      /** True when expanded. */ readonly expanded: boolean;
      /** 1-based position among level-1 rows. */ readonly posInSet: number;
      /** Number of level-1 rows (hosts + Domains). */ readonly setSize: number;
    }
  | {
      /** Service lane under an expanded host. */ readonly kind: "service";
      /** `targetKey(node.target)`. */ readonly key: TargetKey;
      /** The service node. */ readonly node: LaneNode;
      /** Parent host key (for ← focus-to-parent). */ readonly parentKey: TargetKey;
      /** Tree level. */ readonly level: 2;
      /** 1-based position among its siblings. */ readonly posInSet: number;
      /** Number of siblings. */ readonly setSize: number;
    }
  | {
      /** Estate-level Domains group header (only when domains exist). */ readonly kind: "domains";
      /** Fixed key. */ readonly key: "domains";
      /** The group's domains (LaneTree.domains); the header aggregates their evidence. */ readonly domains: readonly TimelineDomain[];
      /** Tree level. */ readonly level: 1;
      /** True when expanded. */ readonly expanded: boolean;
      /** 1-based position among level-1 rows (always last). */ readonly posInSet: number;
      /** Number of level-1 rows. */ readonly setSize: number;
    }
  | {
      /** One domain's DNS-check lane under an expanded Domains group (not selectable). */ readonly kind: "domain";
      /** `"endpoint:" + endpoint`. */ readonly key: TargetKey;
      /** The declared domain (the row name). */ readonly domain: string;
      /** Its Gatus endpoint key (`dns:<domain>`). */ readonly endpoint: string;
      /** Tree level. */ readonly level: 2;
      /** 1-based position among the domain rows. */ readonly posInSet: number;
      /** Number of domain rows. */ readonly setSize: number;
    };

/** A run of rows drawn by one StatusTimeline + LaneDecorations (+ PlotOverlay in desk mode). */
export interface LaneBlock {
  /** Stable id: "hosts-{n}", "services-{hostKey}" or "domains"; also the readout source id. */ readonly id: string;
  /** Plain-text name for the plot's aria-label and the overlay label. */ readonly label: string;
  /** Rows in display order. */ readonly rows: readonly LaneRow[];
}

/**
 * Partition ordered hosts into blocks: a run of consecutive host rows ending at (and including) an
 * expanded host; the service rows of that expanded host; the Domains header (only when `domains` is
 * non-empty), followed by one row per domain when expanded. Pure.
 * @param hosts - Hosts in display order (the view's createHostOrder result).
 * @param expanded - Expanded host keys (always empty in kiosk).
 * @param domains - LaneTree.domains; empty hides the group.
 * @param domainsExpanded - Whether the Domains group is expanded (false in kiosk).
 * @returns Blocks in display order; empty when there are no hosts and no Domains group.
 */
export function buildLaneBlocks(
  hosts: readonly LaneNode[],
  expanded: ReadonlySet<TargetKey>,
  domains: readonly TimelineDomain[],
  domainsExpanded: boolean,
): readonly LaneBlock[] {
  const hasDomains = domains.length > 0;
  const setSize = hosts.length + (hasDomains ? 1 : 0);
  const blocks: LaneBlock[] = [];
  let run: LaneRow[] = [];
  let runIndex = 0;
  const closeRun = (): void => {
    if (run.length === 0) return;
    blocks.push({ id: `hosts-${runIndex}`, label: "Hosts", rows: run });
    runIndex += 1;
    run = [];
  };

  hosts.forEach((node, i) => {
    const key = targetKey(node.target);
    const expandable = node.children.length > 0;
    const isExpanded = expandable && expanded.has(key);
    run.push({ kind: "host", key, node, level: 1, expandable, expanded: isExpanded, posInSet: i + 1, setSize });
    if (!isExpanded) return;
    closeRun();
    blocks.push({
      id: `services-${key}`,
      label: `Services of ${node.label}`,
      rows: node.children.map((svc, j): LaneRow => ({
        kind: "service",
        key: targetKey(svc.target),
        node: svc,
        parentKey: key,
        level: 2,
        posInSet: j + 1,
        setSize: node.children.length,
      })),
    });
  });
  closeRun();

  if (hasDomains) {
    const rows: LaneRow[] = [{ kind: "domains", key: "domains", domains, level: 1, expanded: domainsExpanded, posInSet: setSize, setSize }];
    if (domainsExpanded) {
      domains.forEach((d, j) => {
        rows.push({
          kind: "domain",
          key: `endpoint:${d.endpoint}`,
          domain: d.domain,
          endpoint: d.endpoint,
          level: 2,
          posInSet: j + 1,
          setSize: domains.length,
        });
      });
    }
    blocks.push({ id: "domains", label: "Domains", rows });
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// Evidence composition
// ---------------------------------------------------------------------------

/** Everything laneEvidence needs, gathered by the view. */
export interface LaneEvidenceContext {
  /** `alertsData?.lanes ?? null` — ready alerts (or retained previous) lanes, or null when not loaded. */ readonly alertLanes: readonly AlertHistoryLane[] | null;
  /** Page-wide no-data spans (noDataSpans), or null when the probe has no data. */ readonly noData: readonly TimeWindow[] | null;
  /** Region state per reachable endpoint (from the view's check loaders). */ readonly lookup: (endpoint: string) => HistoryRegionState<EndpointHistoryPayload> | undefined;
  /** Expanded host keys. */ readonly expanded: ReadonlySet<TargetKey>;
  /** Evaluation window: the axis DOMAIN, not the zoom view. */ readonly window: TimeWindow;
  /** The per-mount evidence cache. */ readonly cache: LaneEvidenceCache;
  /** Check-history gate: `(key) => checkHistoryReachable(key, index)`. */ readonly reachable: (key: string) => boolean;
}

export const EMPTY_RESULT: LaneEvidenceResult = Object.freeze({ segments: Object.freeze([]), partial: null, coverageSince: null });

/**
 * Evidence for one row. Pure apart from the evidence cache.
 * - host / service: `ctx.cache.derive(row.key, laneEvidenceInput(…))` — evidence.ts applies the collapse rules
 *   (a collapsed host counts its own and its services' alerts; an expanded host only its own).
 * - domain: that endpoint's check evidence plus the coverage no-data spans, no alert evidence
 *   (domainEvidenceInput; domain alerts stay unmatched in the swimlane).
 * - domains (header): the same over every domain endpoint, i.e. the worst of its domain lanes, partial
 *   while any is loading or failed.
 */
export function laneEvidence(row: LaneRow, ctx: LaneEvidenceContext): LaneEvidenceResult {
  switch (row.kind) {
    case "host":
    case "service":
      return ctx.cache.derive(
        row.key,
        laneEvidenceInput({
          node: row.node,
          expanded: ctx.expanded.has(row.key),
          alertLanes: ctx.alertLanes,
          lookup: ctx.lookup,
          noData: ctx.noData,
          window: ctx.window,
          reachable: ctx.reachable,
        }),
      );
    case "domain":
    case "domains":
      return ctx.cache.derive(
        row.key,
        domainEvidenceInput({
          endpoints: row.kind === "domain" ? [row.endpoint] : row.domains.map((d) => d.endpoint),
          lookup: ctx.lookup,
          noData: ctx.noData,
          window: ctx.window,
          reachable: ctx.reachable,
        }),
      );
  }
}

/**
 * The data a region can draw: `ready.data`, or `previous` while loading/error (the history client already limits
 * `previous` to the same identity and nulls it for too-many). Otherwise null. Pure.
 */
export function regionData<T>(state: HistoryRegionState<T>): T | null {
  switch (state.phase) {
    case "ready":
      return state.data;
    case "loading":
    case "error":
      return state.previous;
    default:
      return null;
  }
}

/** Rank for worstInView: lower is worse. Anything other than critical/warning/ok reads "no data". */
function worstRank(status: TargetStatus): number {
  if (status === "critical") return 0;
  if (status === "warning") return 1;
  if (status === "ok") return 3;
  return 2;
}

/**
 * Worst status in the visible window for the row label: critical > warning > no data > OK.
 * Only segments that intersect `view` count (segments are derived over the domain).
 * "No data" ranks above OK so a lane with gaps never summarises as healthy.
 * @returns The row label's status and its text ("critical", "warning", NO_DATA_TEXT, "OK").
 */
export function worstInView(
  segments: readonly LaneSegment[],
  view: TimeWindow,
  liveTailSeconds = 0,
): { readonly status: TargetStatus; readonly text: string } {
  // While following live, history payloads can be up to one server cache TTL older than the live
  // window end, so every lane ends in a short no-data tail. Leave that tail out of the summary (the
  // lane still draws it) unless it is all there is.
  let end = view.end;
  if (liveTailSeconds > 0) {
    let last: LaneSegment | undefined;
    for (let i = segments.length - 1; i >= 0 && last === undefined; i--) {
      const seg = segments[i]!;
      if (seg.start < view.end && seg.end > view.start) last = seg;
    }
    if (last !== undefined && last.cause === "no-data" && last.end >= view.end && view.end - last.start <= liveTailSeconds && last.start > view.start) {
      end = last.start;
    }
  }
  let best = 2;
  let seen = false;
  for (const seg of segments) {
    if (!(seg.start < end && seg.end > view.start)) continue;
    const rank = seg.cause === "no-data" ? 2 : worstRank(seg.status);
    if (!seen || rank < best) best = rank;
    seen = true;
    if (best === 0) break;
  }
  if (!seen) best = 2;
  if (best === 0) return { status: "critical", text: STATUS_LABEL.critical };
  if (best === 1) return { status: "warning", text: STATUS_LABEL.warning };
  if (best === 3) return { status: "ok", text: STATUS_LABEL.ok };
  return { status: "unknown", text: NO_DATA_TEXT };
}

// ---------------------------------------------------------------------------
// Axis ticks
// ---------------------------------------------------------------------------

/** One axis tick. */
export interface AxisTick {
  /** Tick time, epoch seconds. */ readonly t: number;
  /** Position as a fraction [0, 1] of the visible window. */ readonly fraction: number;
  /** Label in estate time: "HH:MM", or "MM-DD HH:MM" for steps of 6 h or more. */ readonly label: string;
}

/** Candidate tick steps in seconds, smallest first. */
const TICK_STEPS_S = [60, 300, 900, 1_800, 3_600, 7_200, 10_800, 21_600, 43_200, 86_400] as const;
/** Minimum horizontal space per tick label in CSS px (drives the tick count). */
export const AXIS_LABEL_MIN_PX = 96;
/** Steps at or above this carry the date in the label. */
const DATED_STEP_S = 21_600;
const DAY_S = 86_400;
/** Largest instant Date can represent, in seconds. */
const MAX_DATE_S = 8.64e12;

function firstTick(start: number, step: number, offset: number): number {
  return Math.ceil((start + offset) / step) * step - offset;
}

function tickCount(view: TimeWindow, step: number, offset: number): number {
  const first = firstTick(view.start, step, offset);
  return first > view.end ? 0 : Math.floor((view.end - first) / step) + 1;
}

/**
 * Ticks aligned to round estate-local times. Picks the smallest TICK_STEPS_S entry giving at most
 * `maxTicks` ticks (whole days beyond that), aligns with zoneOffsetSeconds(view.start * 1000,
 * clock.timezone), and labels each tick by slicing clock.format(iso) — "YYYY-MM-DD HH:MM:SS TZ" — to
 * "HH:MM", or "MM-DD HH:MM" when step ≥ 21 600 s. Returns [] for an empty window or maxTicks < 1.
 * Pure. Known limit: the offset is taken at view.start, so ticks inside a DST transition hour can
 * be off by the DST delta.
 */
export function computeAxisTicks(view: TimeWindow, clock: EstateClock, maxTicks: number): readonly AxisTick[] {
  const span = view.end - view.start;
  if (!(span > 0) || !Number.isFinite(span) || !(maxTicks >= 1)) return [];
  if (!(Math.abs(view.start) < MAX_DATE_S && Math.abs(view.end) < MAX_DATE_S)) return [];
  const offset = zoneOffsetSeconds(view.start * 1000, clock.timezone);

  let step: number | null = null;
  for (const s of TICK_STEPS_S) {
    if (tickCount(view, s, offset) <= maxTicks) {
      step = s;
      break;
    }
  }
  if (step === null) {
    let days = Math.max(2, Math.ceil(span / DAY_S / maxTicks));
    while (tickCount(view, days * DAY_S, offset) > maxTicks) days += 1;
    step = days * DAY_S;
  }

  const [from, to] = step >= DATED_STEP_S ? [5, 16] : [11, 16];
  const ticks: AxisTick[] = [];
  for (let t = firstTick(view.start, step, offset); t <= view.end; t += step) {
    const label = clock.format(new Date(t * 1000).toISOString()).slice(from, to);
    ticks.push({ t, fraction: (t - view.start) / span, label });
  }
  return ticks;
}

// ---------------------------------------------------------------------------
// Evidence sources
// ---------------------------------------------------------------------------

/** One history source feeding the lanes. */
export interface EvidenceSource {
  /** Source name, e.g. "Alert history (vmalert)" or "Coverage (VictoriaMetrics)". */ readonly source: string;
  /** Region state from useHistory. */ readonly state: HistoryRegionState<{ readonly fetchedAt: string; readonly stale: boolean }>;
  /** Manual retry. */ readonly onRetry: () => void;
}

// ---------------------------------------------------------------------------
// Row presentation
// ---------------------------------------------------------------------------

/** Row presentation derived once per render. */
export interface RowView {
  readonly row: LaneRow;
  readonly result: LaneEvidenceResult;
  readonly name: string;
  readonly worst: { readonly status: TargetStatus; readonly text: string };
  readonly partial: boolean;
  readonly unavailable: boolean;
}

/** Visible row name: the node label, "Domains", or the domain itself. */
export function rowName(row: LaneRow): string {
  if (row.kind === "host" || row.kind === "service") return row.node.label;
  return row.kind === "domains" ? "Domains" : row.domain;
}

/** Accessible lane name: a domain row reads "<domain> DNS check"; others equal rowName. */
export function rowAccessibleName(row: LaneRow): string {
  return row.kind === "domain" ? `${row.domain} DNS check` : rowName(row);
}

/** "check history not available": service/domain rows (and the Domains header) whose endpoints are all unreachable. */
export function checkHistoryUnavailable(row: LaneRow, reachable: (key: string) => boolean): boolean {
  if (row.kind === "service") return row.node.endpoints.every((e) => !reachable(e));
  if (row.kind === "domain") return !reachable(row.endpoint);
  if (row.kind === "domains") return row.domains.every((d) => !reachable(d.endpoint));
  return false;
}

export function rowView(
  row: LaneRow,
  evidence: ReadonlyMap<string, LaneEvidenceResult>,
  view: TimeWindow,
  reachable: (key: string) => boolean,
  liveTailSeconds: number,
): RowView {
  const result = evidence.get(row.key) ?? EMPTY_RESULT;
  return {
    row,
    result,
    name: rowName(row),
    worst: worstInView(result.segments, view, liveTailSeconds),
    partial: result.partial !== null,
    unavailable: checkHistoryUnavailable(row, reachable),
  };
}

/** The full visible row text (the treeitem title; rows truncate at narrow widths). */
export function rowTitle(v: RowView): string {
  const parts = [rowAccessibleName(v.row), `worst in view: ${v.worst.text}`];
  if (v.partial) parts.push(PARTIAL_EVIDENCE_TEXT);
  if (v.unavailable) parts.push(CHECK_HISTORY_UNAVAILABLE_TEXT);
  return parts.join(", ");
}

/** `TimelineLane.label`, which StatusTimeline puts on each lane's `<g aria-label>`. */
export function laneAccessibleLabel(v: RowView): string {
  let label = `${rowAccessibleName(v.row)}, worst in view ${v.worst.text}`;
  if (v.partial) label += `, ${PARTIAL_EVIDENCE_TEXT}`;
  if (v.unavailable) label += `, ${CHECK_HISTORY_UNAVAILABLE_TEXT}`;
  return label;
}

export function isExpandable(row: LaneRow): boolean {
  return (row.kind === "host" && row.expandable) || row.kind === "domains";
}

export function isExpanded(row: LaneRow): boolean {
  return (row.kind === "host" || row.kind === "domains") && row.expanded;
}

/** ISO string for epoch seconds; "" when not representable (clock.format → "—"). */
export function isoOf(sec: number): string {
  const d = new Date(Math.round(sec * 1000));
  return Number.isFinite(d.getTime()) ? d.toISOString() : "";
}
