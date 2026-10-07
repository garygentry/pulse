// Pure cursor-readout model: entry types, lane/chart source factories, cursor-time formatting and
// the spoken readout summary text.
import type { TargetStatus } from "@pulse/web-data/wire";
import { STATUS_LABEL } from "../../../a11y/status-labels.js";
import { TZ_FALLBACK_MARKER } from "../../../format.js";
import type { EstateClock } from "../../../format.js";
import type { LaneEvidenceResult } from "../../timeline/evidence.js";
import { NO_DATA_TEXT, partialReasonText, segmentAt } from "../../timeline/evidence.js";
import type { ChartData } from "./chart-data.js";
import { formatChartValue, nearestSample } from "./chart-data.js";
import type { ClientQueryMeta } from "./query-meta.js";

/** One lane's state at the cursor time. */
export interface LaneReadout {
  /** Lane label. */ readonly label: string;
  /** Status at cursor (unknown for no data). */ readonly status: TargetStatus;
  /** Text: STATUS_LABEL[status], or "no data". */ readonly text: string;
  /** Partial-evidence reason text, or null. */ readonly partial: string | null;
  /** Summary group name overriding the status group (e.g. "info"); absent → grouped by status. */ readonly group?: string;
}

/** One chart's value at the cursor time. */
export interface ChartReadout {
  /** Chart title. */ readonly title: string;
  /** Formatted nearest value(s) with unit, or "no value". */ readonly values: readonly { readonly label: string; readonly text: string }[];
}

/** A readout source a lane group or chart registers with the page (readout registry). */
export interface ReadoutSource {
  /** Stable source id (lane group id or chart id). */ readonly id: string;
  /** Compute entries at cursor time t (epoch seconds). Must be O(log n) per lane. */ read(t: number): readonly (LaneReadout | ChartReadout)[];
}

/** Debounce for the aria-live readout summary, ms. */
export const READOUT_ANNOUNCE_DEBOUNCE_MS = 250;
/** Maximum non-OK lane rows shown in the compact panel before "+N more". */
export const READOUT_MAX_LANE_ROWS = 24;
/** Maximum lane names per status group in the spoken summary before "and N more". */
export const READOUT_SUMMARY_MAX_NAMES = 10;

/** Chart readout text when no sample lies within one step of the cursor. */
const NO_VALUE_TEXT = "no value";

/** Registered sources' entries at one instant, split by kind. */
export interface ReadoutEntries {
  /** Lane entries in registration order. */ readonly lanes: readonly LaneReadout[];
  /** Chart entries in registration order. */ readonly charts: readonly ChartReadout[];
}

/** Type guard: a ChartReadout has `values`; a LaneReadout has `status`. */
export function isChartReadout(e: LaneReadout | ChartReadout): e is ChartReadout {
  return "values" in e;
}

// ---------------------------------------------------------------------------
// Source factories
// ---------------------------------------------------------------------------

/** One lane as the readout needs it. */
export interface LaneReadoutInput {
  /** Lane label (plain text). */ readonly label: string;
  /** Memoised evidence result for the lane (deriveLaneSegments). */ readonly result: LaneEvidenceResult;
}

/** Format epoch seconds as estate time; "—" for a non-representable instant. */
function formatEpoch(sec: number, clock: EstateClock): string {
  const d = new Date(Math.round(sec * 1000));
  if (Number.isNaN(d.getTime())) return "—";
  return clock.format(d.toISOString());
}

/**
 * Readout source for one lane group (the page registers one per rendered StatusTimeline group).
 * `getLanes` is called at read time, so it always sees fresh evidence.
 */
export function createLaneReadoutSource(id: string, getLanes: () => readonly LaneReadoutInput[], clock: EstateClock): ReadoutSource {
  const formatSec = (s: number): string => formatEpoch(s, clock);
  return {
    id,
    read(t: number): readonly LaneReadout[] {
      return getLanes().map((lane) => {
        const seg = segmentAt(lane.result.segments, t);
        const status: TargetStatus = seg?.status ?? "unknown";
        const text = seg === null || seg.cause === "no-data" ? NO_DATA_TEXT : STATUS_LABEL[seg.status];
        return { label: lane.label, status, text, partial: partialReasonText(lane.result, formatSec) };
      });
    },
  };
}

/**
 * Readout source for one chart: per series the nearest sample within one step, formatted with the
 * unit, or "no value". Returns [] when getData() is null or has no series.
 */
export function createChartReadoutSource(id: string, title: string, unit: ClientQueryMeta["unit"], getData: () => ChartData | null): ReadoutSource {
  return {
    id,
    read(t: number): readonly ChartReadout[] {
      const data = getData();
      if (data === null || data.series.length === 0) return [];
      const values = data.series.map((s, i) => {
        const samples = data.samples[i];
        const hit = samples === undefined ? null : nearestSample(samples, t, data.stepSeconds);
        return { label: s.label, text: hit === null ? NO_VALUE_TEXT : formatChartValue(hit.v, unit) };
      });
      return [{ title, values }];
    },
  };
}

// ---------------------------------------------------------------------------
// Time and summary text
// ---------------------------------------------------------------------------

/**
 * Cursor time in estate wall-clock time, e.g. "2026-09-24 14:03:22 CDT", plus
 * ` (${TZ_FALLBACK_MARKER})` when clock.tzFallback. Uses TRUE time (never shifted data).
 */
export function formatCursorTime(t: number, clock: EstateClock): string {
  const text = formatEpoch(t, clock);
  return clock.tzFallback ? `${text} (${TZ_FALLBACK_MARKER})` : text;
}

/** Summary group of each non-OK status. */
const STATUS_GROUP: Readonly<Record<Exclude<TargetStatus, "ok">, string>> = {
  critical: "critical",
  warning: "warning",
  unknown: NO_DATA_TEXT,
  suppressed: "suppressed",
};

/** Lane groups for lanes that are not OK, in display and spoken order. */
const LANE_GROUP_ORDER: readonly string[] = ["critical", "warning", "info", "unknown severity", NO_DATA_TEXT, "suppressed"];

/** A lane's summary group name, or null for an OK lane without a `group` override. */
export function laneGroupOf(lane: LaneReadout): string | null {
  if (lane.group !== undefined) return lane.group;
  return lane.status === "ok" ? null : STATUS_GROUP[lane.status];
}

/** Display rank of a summary group (LANE_GROUP_ORDER; unlisted names sort last). */
export function laneGroupRank(group: string): number {
  const i = LANE_GROUP_ORDER.indexOf(group);
  return i < 0 ? LANE_GROUP_ORDER.length : i;
}

function chartSummary(c: ChartReadout): string {
  const only = c.values.length === 1 ? c.values[0] : undefined;
  const values = only !== undefined ? only.text : c.values.map((v) => `${v.label} ${v.text}`).join(", ");
  return `${c.title}: ${values}`;
}

/**
 * Spoken summary, pure. Shape:
 *   "Cursor {time}{, pinned}. {Chart}: {value}; …. {n} critical: a, b, c. {n} warning: …. {n} info: …. {n} no data: …. {n} lanes OK."
 * A lane's `group` overrides its status group; groups follow LANE_GROUP_ORDER.
 * Each lane group lists up to READOUT_SUMMARY_MAX_NAMES labels, then "and N more". Empty groups are
 * omitted. With no entries: "Cursor {time}. Nothing to read at this time."
 */
export function buildReadoutSummary(timeText: string, entries: ReadoutEntries, pinned: boolean): string {
  const head = `Cursor ${timeText}${pinned ? ", pinned" : ""}.`;
  if (entries.lanes.length === 0 && entries.charts.length === 0) return `${head} Nothing to read at this time.`;
  const parts: string[] = [head];
  if (entries.charts.length > 0) parts.push(`${entries.charts.map(chartSummary).join("; ")}.`);
  const groups = new Map<string, string[]>();
  let ok = 0;
  for (const l of entries.lanes) {
    const g = laneGroupOf(l);
    if (g === null) {
      ok++;
      continue;
    }
    const names = groups.get(g);
    if (names === undefined) groups.set(g, [l.label]);
    else names.push(l.label);
  }
  const ordered = [...groups.entries()].sort((a, b) => laneGroupRank(a[0]) - laneGroupRank(b[0]));
  for (const [name, names] of ordered) {
    const shown = names.slice(0, READOUT_SUMMARY_MAX_NAMES).join(", ");
    const more = names.length - READOUT_SUMMARY_MAX_NAMES;
    parts.push(`${names.length} ${name}: ${shown}${more > 0 ? `, and ${more} more` : ""}.`);
  }
  if (entries.lanes.length > 0) parts.push(`${ok} lanes OK.`);
  return parts.join(" ");
}
