// The alert-history swimlane (07 §7; REQ-SWIM-01..05, REQ-LANE-07, REQ-HISTERR-04): one row per
// severity of vmalert firing intervals, packed into at most MAX_SUBLANES sub-lanes (05 §6), drawn
// with the unmodified StatusTimeline plus view-owned decorations (unmatched outlines, "+k" badge,
// keyboard-active interval). Hover goes through the page cursor readout (source "swimlane"); keyboard
// users move between intervals on each focusable track and press Enter to open /alerts. Identity is
// SwimInterval.laneId, never an Alertmanager fingerprint (CON-07). Every upstream string renders as
// a JSX text child (REQ-SEC-02). Kiosk (interactive=false): no tab stops, tooltip, overlay or list.
import type { ReactElement, KeyboardEvent as ReactKeyboardEvent } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSignal } from "@preact/signals-react";
import type { IntervalHistoryPayload, TargetStatus } from "@pulse/web-data/wire";
import { ALERT_SEVERITY, EmptyState, Section, StatusBadge, StatusTimeline, Tooltip, TooltipContent, TooltipTrigger } from "@/ui";
import type { StatusBadgeMapProps, TimelineLane } from "@/ui";
import { announce } from "../../a11y/index.js";
import type { EstateClock } from "../../format.js";
import type { TimeAxis, TimeWindow } from "../_shared/timeseries/axis.js";
import type { HistoryRegionState } from "../_shared/timeseries/history/client.js";
import { HistoryRegion } from "../_shared/timeseries/history/region.js";
import { PlotOverlay } from "../_shared/timeseries/overlay.js";
import type { LaneReadout } from "../_shared/timeseries/readout-model.js";
import { SWIM_ROW_STATUS } from "../../status/target-status.js";
import type { ReadoutRegistry } from "../_shared/timeseries/readout.js";
import { buildSeverityRows, overflowText, UNMATCHED_TARGET_TEXT } from "./swimlane-pack.js";
import type { SeverityRow, SwimInterval, SwimSeverity } from "./swimlane-pack.js";
import type { LaneTree as LaneTreeModel } from "./model.js";
import { LaneDecorations } from "./decorations.js";
import type { DecorationMark } from "./decorations.js";
import { DEFAULT_ROW_PX, LANE_GAP_PX, MIN_PLOT_WIDTH_PX, isoOf } from "./lanes-model.js";
import { LANES_GRID_CLASS, PLOT_BLOCK_CLASS, PLOT_COL_CLASS } from "./lanes.js";
import { SWIMLANE_READOUT_ORDER, SWIM_ROW_TEXT, swimIntervalHref, swimIntervalText } from "./swimlane-model.js";
import { useSignals } from "@preact/signals-react/runtime";

// ---------------------------------------------------------------------------
// Constants (07 §7.3, §7.4)
// ---------------------------------------------------------------------------

const HELP_ID = "timeline-swim-help";
const HELP_TEXT =
  "Use Left and Right arrows to move between alert intervals, Home and End for the first and last, and Enter to open the alert in Alerts.";
const NO_INTERVALS_TEXT = "No intervals in view";
const NONE_FIRING_TEXT = "none firing";
/** Intervals named per row in the readout before "+N more". */
const READOUT_MAX_INTERVALS = 2;
/** Readout summary group of a firing row whose fill status would otherwise read as "no data". */
const READOUT_GROUP: Readonly<Partial<Record<SwimSeverity, string>>> = { info: "info", unknown: "unknown severity" };
/** Muted head annotations (count, overflow, unmatched). */
const HEAD_NOTE_CLASS = "text-xs text-muted-foreground";

// ---------------------------------------------------------------------------
// Pure helpers (07 §7.4, §7.5)
// ---------------------------------------------------------------------------

/** Intervals of a row that overlap the visible window, in traversal order (start, end, laneId). */
function visibleIntervals(row: SeverityRow, view: TimeWindow): readonly SwimInterval[] {
  return row.ordered.filter((i) => i.end > view.start && i.start < view.end);
}

/** Sub-lane index holding `interval` (by identity), or -1. */
function subLaneOf(row: SeverityRow, interval: SwimInterval): number {
  for (const sub of row.subLanes) if (sub.intervals.includes(interval)) return sub.index;
  return -1;
}

function countText(n: number): string {
  return n === 1 ? "1 interval" : `${n} intervals`;
}

/** Severity badge props: the row text plus a `data-status` hook naming the severity (the badge spreads extra attributes). */
function headBadgeProps(severity: SwimSeverity): StatusBadgeMapProps {
  const props = { label: SWIM_ROW_TEXT[severity], variant: "dot" as const, "data-status": severity };
  return props;
}

// ---------------------------------------------------------------------------
// AlertSwimlane (07 §7.1, §7.2)
// ---------------------------------------------------------------------------

/** Props for AlertSwimlane. */
export interface AlertSwimlaneProps {
  /** Alerts region state (the same useHistory result the lanes use). */ readonly state: HistoryRegionState<IntervalHistoryPayload>;
  /** Manual retry for the alerts request. */ readonly onRetry: () => void;
  /** Next shorter range, or null at 1h (too-many). */ readonly onShorterRange: (() => void) | null;
  /** Lane tree, for target labels and unmatched detection; null before the snapshot (05 then decides unmatched by attribution only). */ readonly tree: LaneTreeModel | null;
  /** Page axis. */ readonly axis: TimeAxis;
  /** Page readout registry. */ readonly readouts: ReadoutRegistry;
  /** Estate clock. */ readonly clock: EstateClock;
  /** false in kiosk: no overlay, no focusable tracks, no tooltip, no pinned list. */ readonly interactive: boolean;
  /** CursorReadout summaryId (READOUT_ID), passed as PlotOverlay describedBy. */ readonly readoutId: string;
  /** Navigate in-app (router.navigate); used for Enter activation. */ readonly onNavigate: (href: string) => void;
}

/** The alert-history swimlane: one row per severity of vmalert firing intervals. */
export function AlertSwimlane(props: AlertSwimlaneProps): ReactElement {
  return (
    <Section
      title="Alert history"
      headingId="timeline-swim-title"
      data-slot="timeline-swimlane"
      actions={
        <span data-slot="timeline-provenance" className="text-sm font-medium text-muted-foreground">
          Alerts (vmalert)
        </span>
      }
    >
      <HistoryRegion
        state={props.state}
        label="alert history"
        onRetry={props.onRetry}
        onShorterRange={props.onShorterRange}
      >
        {(payload: IntervalHistoryPayload) => <SwimRows payload={payload} props={props} />}
      </HistoryRegion>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Private: rows, tracks, pinned list (07 §7.3–§7.5)
// ---------------------------------------------------------------------------

interface SwimRowsProps {
  readonly payload: IntervalHistoryPayload;
  readonly props: AlertSwimlaneProps;
}

/** Loaded alerts: the "No alerts in range" empty state, or the heads grid plus one track per row. */
function SwimRows(p: SwimRowsProps): ReactElement {
  useSignals();
  const { payload } = p;
  const { tree, axis, readouts, clock, interactive } = p.props;
  const view = axis.view.value;
  const rows = useMemo(() => buildSeverityRows(payload, tree, view), [payload, tree, view.start, view.end]);
  const active = useSignal<Readonly<Partial<Record<SwimSeverity, number>>>>({});
  const plotColRef = useRef<HTMLDivElement>(null);
  const stackRef = useRef<HTMLDivElement>(null);
  const headsRef = useRef<HTMLDivElement>(null);
  const [rowPx, setRowPx] = useState(DEFAULT_ROW_PX);
  const [plotWidth, setPlotWidth] = useState(MIN_PLOT_WIDTH_PX);

  // Hover goes through the page cursor readout, not a bespoke tooltip (07 §7.4).
  useEffect(() => {
    const read = (t: number): readonly LaneReadout[] =>
      rows.map((row) => {
        const firing = row.ordered.filter((i) => i.start <= t && t < i.end);
        const named = firing.slice(0, READOUT_MAX_INTERVALS).map((i) => swimIntervalText(i, tree, clock));
        const more = firing.length - named.length;
        const text = firing.length === 0 ? NONE_FIRING_TEXT : named.join("; ") + (more > 0 ? ` +${more} more` : "");
        const status: TargetStatus = firing.length === 0 ? "ok" : SWIM_ROW_STATUS[row.severity];
        const group = firing.length === 0 ? undefined : READOUT_GROUP[row.severity];
        return { label: `${SWIM_ROW_TEXT[row.severity]} alerts`, status, text, partial: null, ...(group !== undefined ? { group } : {}) };
      });
    return readouts.register({ id: "swimlane", read }, SWIMLANE_READOUT_ORDER);
  }, [rows, tree, clock, readouts]);

  // Sub-lane pitch and plot width: measured when ResizeObserver exists; defaults otherwise. The pitch
  // comes from a severity head (sub-lane count × the lane pitch), so each track matches its head.
  const rowsKey = rows.map((r) => `${r.severity}:${r.subLanes.length}`).join("|");
  useEffect(() => {
    const measure = (): void => {
      const head = headsRef.current?.querySelector<HTMLElement>("[data-slot=timeline-swim-head]");
      const lanes = Number(head?.getAttribute("data-sublanes") ?? "0");
      const h = head !== null && head !== undefined && lanes > 0 ? head.getBoundingClientRect().height / lanes : 0;
      setRowPx(Number.isFinite(h) && h > LANE_GAP_PX ? h : DEFAULT_ROW_PX);
      const w = plotColRef.current?.clientWidth ?? 0;
      setPlotWidth(Math.max(MIN_PLOT_WIDTH_PX, Number.isFinite(w) ? Math.floor(w) : 0));
    };
    const RO = (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
    if (typeof RO !== "function") return undefined;
    measure();
    let ro: ResizeObserver | null = null;
    try {
      ro = new RO(() => measure());
      if (plotColRef.current !== null) ro.observe(plotColRef.current);
      if (headsRef.current !== null) ro.observe(headsRef.current);
    } catch {
      ro = null;
    }
    return () => ro?.disconnect();
  }, [rowsKey]);

  if (rows.length === 0) {
    return (
      <EmptyState
        icon="circle-check"
        title="No alerts in range"
        description={`vmalert recorded no firing intervals between ${clock.format(isoOf(view.start))} and ${clock.format(isoOf(view.end))}.`}
      />
    );
  }

  const laneHeight = rowPx - LANE_GAP_PX;

  /** The keyboard-active interval of a row (clamped), or null when none is in view. */
  const activeOf = (row: SeverityRow): { readonly interval: SwimInterval; readonly index: number; readonly list: readonly SwimInterval[] } | null => {
    const list = visibleIntervals(row, view);
    if (list.length === 0) return null;
    const index = Math.min(Math.max(active.value[row.severity] ?? 0, 0), list.length - 1);
    return { interval: list[index]!, index, list };
  };

  const setActive = (sev: SwimSeverity, index: number): void => {
    active.value = { ...active.value, [sev]: index };
  };

  const onKeyDown = (row: SeverityRow, e: ReactKeyboardEvent): void => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const cur = activeOf(row);
    if (cur === null) return;
    const last = cur.list.length - 1;
    let next: number;
    switch (e.key) {
      case "ArrowRight": next = Math.min(cur.index + 1, last); break;
      case "ArrowLeft": next = Math.max(cur.index - 1, 0); break;
      case "Home": next = 0; break;
      case "End": next = last; break;
      case "Enter":
        e.preventDefault();
        p.props.onNavigate(swimIntervalHref(cur.interval));
        return;
      default:
        return;
    }
    e.preventDefault();
    const iv = cur.list[next]!;
    setActive(row.severity, next);
    // Follow with the page cursor and readout, without pinning (live follow keeps running).
    axis.cursor.value = Math.max(iv.start, axis.view.peek().start);
    announce(swimIntervalText(iv, tree, clock));
  };

  const onFocus = (row: SeverityRow): void => {
    if (active.peek()[row.severity] === undefined && visibleIntervals(row, view).length > 0) setActive(row.severity, 0);
  };

  return (
    <div data-slot="timeline-swim-body" className="flex flex-col gap-2">
      <div data-slot="timeline-swim-grid" className={LANES_GRID_CLASS}>
        <div ref={headsRef} data-slot="timeline-swim-heads" className="flex min-w-0 flex-col">
          {rows.map((row) => {
            const overflow = row.subLanes.reduce((s, sub) => s + sub.overflow, 0);
            const unmatched = row.ordered.filter((i) => i.unmatched).length;
            return (
              <div
                key={row.severity}
                id={`swim-head-${row.severity}`}
                data-slot="timeline-swim-head"
                className="flex min-w-0 flex-wrap items-center gap-1 overflow-hidden text-sm"
                data-severity={row.severity}
                data-sublanes={row.subLanes.length}
                style={{ blockSize: `calc(${row.subLanes.length} * var(--spacing) * 6)` }}
              >
                {StatusBadge.fromMap(ALERT_SEVERITY, row.severity, headBadgeProps(row.severity))}
                <span data-slot="timeline-swim-count" className={HEAD_NOTE_CLASS}>
                  {countText(row.ordered.length)}
                </span>
                {overflow > 0 ? (
                  <span data-slot="timeline-swim-overflow" className={HEAD_NOTE_CLASS}>
                    {overflowText(overflow)}
                  </span>
                ) : null}
                {unmatched > 0 ? (
                  <span data-slot="timeline-swim-unmatched" className={HEAD_NOTE_CLASS}>{`${unmatched} ${UNMATCHED_TARGET_TEXT}`}</span>
                ) : null}
              </div>
            );
          })}
        </div>
        <div ref={plotColRef} data-slot="timeline-plot-col" className={PLOT_COL_CLASS}>
          <div ref={stackRef} data-slot="timeline-plot-stack" className={`flex flex-col ${PLOT_BLOCK_CLASS}`}>
            {rows.map((row) => {
              const cur = interactive ? activeOf(row) : null;
              const marks: DecorationMark[] = [];
              for (const sub of row.subLanes) {
                for (const iv of sub.intervals) {
                  if (iv.unmatched) marks.push({ kind: "unmatched-interval", lane: sub.index, start: iv.start, end: iv.end });
                }
                if (sub.overflow > 0) marks.push({ kind: "overflow-badge", lane: sub.index, count: sub.overflow });
              }
              if (cur !== null && active.value[row.severity] !== undefined) {
                const lane = subLaneOf(row, cur.interval);
                if (lane >= 0) marks.push({ kind: "active-interval", lane, start: cur.interval.start, end: cur.interval.end });
              }
              const lanes: TimelineLane[] = row.subLanes.map((sub) => ({
                id: `${row.severity}-${sub.index}`,
                label: `${SWIM_ROW_TEXT[row.severity]} sub-lane ${sub.index + 1}`,
                segments: sub.intervals.map((i) => ({
                  status: SWIM_ROW_STATUS[row.severity],
                  tone: ALERT_SEVERITY[row.severity].tone,
                  start: i.start,
                  end: i.end,
                })),
              }));
              const track = (
                <div
                  className="relative block"
                  data-swim-track=""
                  role="group"
                  aria-labelledby={`swim-head-${row.severity}`}
                  data-severity={row.severity}
                  data-sublanes={row.subLanes.length}
                  {...(interactive
                    ? {
                        tabIndex: 0,
                        "aria-describedby": HELP_ID,
                        onKeyDown: (e: ReactKeyboardEvent) => onKeyDown(row, e),
                        onFocus: () => onFocus(row),
                      }
                    : {})}
                >
                  <StatusTimeline
                    className="block max-w-none"
                    lanes={lanes}
                    domainStart={view.start}
                    domainEnd={view.end}
                    width={plotWidth}
                    laneHeight={laneHeight}
                    laneGap={LANE_GAP_PX}
                    ariaLabel={`${SWIM_ROW_TEXT[row.severity]} alert intervals`}
                  />
                  <LaneDecorations
                    marks={marks}
                    laneCount={row.subLanes.length}
                    domainStart={view.start}
                    domainEnd={view.end}
                    width={plotWidth}
                    laneHeight={laneHeight}
                    laneGap={LANE_GAP_PX}
                  />
                </div>
              );
              if (!interactive) {
                return (
                  <div key={row.severity}>{track}</div>
                );
              }
              const tip = cur === null ? NO_INTERVALS_TEXT : swimIntervalText(cur.interval, tree, clock);
              return (
                <Tooltip key={row.severity}>
                  <TooltipTrigger asChild>
                    <div>{track}</div>
                  </TooltipTrigger>
                  <TooltipContent>{tip}</TooltipContent>
                </Tooltip>
              );
            })}
            {interactive ? (
              <PlotOverlay
                axis={axis}
                label="Alerts swimlane"
                placement={{ kind: "fill" }}
                interactive
                describedBy={p.props.readoutId}
              />
            ) : null}
          </div>
        </div>
      </div>
      {interactive ? (
        <p id={HELP_ID} className="sr-only">
          {HELP_TEXT}
        </p>
      ) : null}
      {interactive ? <PinnedIntervals rows={rows} props={p.props} /> : null}
    </div>
  );
}

interface PinnedIntervalsProps {
  readonly rows: readonly SeverityRow[];
  readonly props: AlertSwimlaneProps;
}

/**
 * Pointer activation (07 §7.4): while the cursor is pinned, list the intervals containing the pinned
 * time with "Open in Alerts" links. The cursor is read only while pinned, so an unpinned cursor move
 * never re-renders this component (REQ-PERF-05).
 */
function PinnedIntervals(p: PinnedIntervalsProps): ReactElement | null {
  useSignals();
  const { axis, tree, clock } = p.props;
  if (!axis.pinned.value) return null;
  const t = axis.cursor.value;
  if (t === null) return null;
  const hits = p.rows.flatMap((row) => row.ordered.filter((i) => i.start <= t && t < i.end));
  return (
    <ul
      data-slot="timeline-swim-pinned"
      className="m-0 flex list-none flex-col gap-1 p-0 text-sm"
      aria-label="Alert intervals at the pinned time"
    >
      {hits.length === 0 ? <li>No alert intervals at the pinned time</li> : null}
      {hits.map((i) => (
        <li key={`${i.laneId}@${i.start}`}>
          <span>{swimIntervalText(i, tree, clock)}</span>{" "}
          <a className="text-foreground underline underline-offset-4" href={swimIntervalHref(i)}>
            Open in Alerts
          </a>
        </li>
      ))}
    </ul>
  );
}
