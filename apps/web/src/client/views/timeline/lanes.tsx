// The status-lane tree (07 §5; REQ-LANE-01..07, REQ-A11Y-01/02, REQ-KIOSK-03): one ARIA tree of
// label rows beside a stack of StatusTimelines (one per block), the view-owned decorations, one
// PlotOverlay per block (desk only), the lane legend, the estate-time axis and the evidence status
// line. Evidence rules live in evidence.ts; this module only gathers inputs (including the Domains
// header and its per-domain DNS-check rows, 09 §3) and summarises results for the row labels. Every upstream label renders as a JSX
// text child (REQ-SEC-02). The cursor signal is never read during render (REQ-PERF-05).
import type { ReactElement, HTMLAttributes, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from "react";
import { useEffect, useRef, useState } from "react";
import type { TargetStatus } from "@pulse/web-data/wire";
import { Button, Icon, Section, StatusBadge, StatusTimeline, TARGET_STATUS } from "@/ui";
import type { StatusBadgeMapProps, TimelineLane } from "@/ui";
import { rovingTabindex, STATUS_LABEL } from "../../a11y/index.js";
import type { RovingController } from "../../a11y/index.js";
import type { EstateClock } from "../../format.js";
import type { TimeAxis, TimeWindow } from "../_shared/timeseries/axis.js";
import { FAILURE_COPY, REGION_TEXT } from "../_shared/timeseries/history/region.js";
import type { LaneNode, TargetKey } from "./model.js";
import { PlotOverlay } from "../_shared/timeseries/overlay.js";
import type { LaneReadout } from "../_shared/timeseries/readout-model.js";
import type { ReadoutRegistry } from "../_shared/timeseries/readout.js";
import { CHECK_HISTORY_UNAVAILABLE_TEXT, NO_DATA_TEXT, PARTIAL_EVIDENCE_TEXT, partialReasonText, segmentAt } from "./evidence.js";
import type { LaneEvidenceResult } from "./evidence.js";
import { LaneDecorations } from "./decorations.js";
import type { DecorationMark } from "./decorations.js";
import {
  AXIS_LABEL_MIN_PX,
  DEFAULT_ROW_PX,
  EMPTY_RESULT,
  LANE_GAP_PX,
  LANE_READOUT_ORDER,
  MIN_PLOT_WIDTH_PX,
  computeAxisTicks,
  isExpandable,
  isExpanded,
  isoOf,
  laneAccessibleLabel,
  rowAccessibleName,
  rowTitle,
  rowView,
} from "./lanes-model.js";
import type { EvidenceSource, LaneBlock, LaneRow, RowView } from "./lanes-model.js";
import { useSignals } from "@preact/signals-react/runtime";

/** Label rows, the axis spacer and plot lanes share this pitch (the measured row height drives the plots). */
const ROW_HEIGHT_CLASS = "h-6";
/** Two columns: tree labels beside the plots. */
export const LANES_GRID_CLASS = "grid grid-cols-[minmax(0,2fr)_minmax(0,5fr)] gap-x-2 [@media(max-width:30rem)]:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]";
/** The ONLY horizontal scroller: the plots keep MIN_PLOT_WIDTH_PX and scroll inside their column. */
export const PLOT_COL_CLASS = "min-w-0 overflow-x-auto overscroll-x-contain";
/** A block sizes to its plot (and its fill overlay with it). */
export const PLOT_BLOCK_CLASS = "relative w-max min-w-full";
/** Tree label row: one plot-lane pitch high; kiosk rows are not clickable. */
const ROW_CLASS = `flex min-w-0 items-center gap-1 truncate text-sm cursor-pointer ${ROW_HEIGHT_CLASS} aria-[level=2]:pl-4 aria-selected:bg-accent aria-selected:font-semibold in-data-[kiosk=true]:cursor-default`;

/** Legend statuses with their legend text. */
const LEGEND_STATUSES: readonly (readonly [TargetStatus, string])[] = [
  ["ok", "OK"],
  ["warning", "warning"],
  ["critical", "critical"],
  ["unknown", NO_DATA_TEXT],
];

/** Status badge props: the worded status plus a `data-status` hook (the badge spreads extra attributes). */
function badgeProps(status: TargetStatus, label: string): StatusBadgeMapProps {
  const props = { label, variant: "dot" as const, "data-status": status };
  return props;
}

/** A muted "· text" suffix after the lane name. */
function LaneSuffix(props: { readonly children: string }): ReactElement {
  return (
    <span data-slot="timeline-lane-suffix" className="min-w-0 shrink-[100] truncate text-xs text-muted-foreground">
      {"· "}
      {props.children}
    </span>
  );
}

// ---------------------------------------------------------------------------
// LaneEvidenceStatus (07 §5.5)
// ---------------------------------------------------------------------------

/** Props for LaneEvidenceStatus. */
export interface LaneEvidenceStatusProps {
  /** Alerts and coverage, in that order. */ readonly sources: readonly EvidenceSource[];
  /** Estate clock (stale timestamps). */ readonly clock: EstateClock;
  /** Select the next shorter range, or null at 1h (too-many). */ readonly onShorterRange: (() => void) | null;
}

interface StatusLine {
  readonly phase: string;
  readonly text: string;
  readonly retry: (() => void) | null;
  readonly shorter: (() => void) | null;
}

function statusLine(src: EvidenceSource, clock: EstateClock, onShorterRange: (() => void) | null): StatusLine | null {
  const s = src.state;
  const name = src.source;
  switch (s.phase) {
    case "idle":
      return { phase: s.phase, text: `${name}: waiting for the timeline index.`, retry: null, shorter: null };
    case "not-applicable":
      return { phase: s.phase, text: `${name}: ${s.reason}`, retry: null, shorter: null };
    case "loading":
      return s.previous !== null ? null : { phase: s.phase, text: `${name}: loading…`, retry: null, shorter: null };
    case "ready":
      return s.data.stale ? { phase: s.phase, text: `${name}: ${REGION_TEXT.staleCache}`, retry: null, shorter: null } : null;
    case "error": {
      const { failure, previous } = s;
      const retry = failure.retryable ? src.onRetry : null;
      if (previous !== null) {
        return {
          phase: s.phase,
          text: `${name}: ${FAILURE_COPY[failure.kind]} ${REGION_TEXT.stalePrevious} Last loaded ${clock.format(previous.fetchedAt)}.`,
          retry,
          shorter: null,
        };
      }
      const tooMany = failure.kind === "too-many";
      const copy = tooMany && onShorterRange === null ? REGION_TEXT.tooManyNoShorter : FAILURE_COPY[failure.kind];
      return {
        phase: s.phase,
        text: `${name}: ${copy} Lanes show no data for this evidence.`,
        retry,
        shorter: tooMany ? onShorterRange : null,
      };
    }
    default:
      return null;
  }
}

/** One line per source that is not ready; renders nothing when every source is ready and fresh. */
export function LaneEvidenceStatus(props: LaneEvidenceStatusProps): ReactElement | null {
  const lines = props.sources
    .map((src) => ({ src, line: statusLine(src, props.clock, props.onShorterRange) }))
    .filter((x): x is { src: EvidenceSource; line: StatusLine } => x.line !== null);
  if (lines.length === 0) return null;
  return (
    <ul data-slot="timeline-evidence-status" className="m-0 flex list-none flex-col gap-1 p-0 text-sm" role="status" aria-label="Lane evidence status">
      {lines.map(({ src, line }) => (
        // role="none": the ul's role="status" (07 §5.6) replaces its list semantics, so a plain li
        // would be an orphaned listitem (axe "listitem", WCAG 1.3.1).
        <li key={src.source} className="flex flex-wrap items-center gap-2" data-source-phase={line.phase} role="none">
          {line.text}
          {line.retry !== null ? (
            <Button type="button" variant="outline" size="sm" onClick={line.retry}>
              {REGION_TEXT.retry}
            </Button>
          ) : null}
          {line.shorter !== null ? (
            <Button type="button" variant="outline" size="sm" onClick={line.shorter}>
              {REGION_TEXT.shorterRange}
            </Button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// LaneTree (07 §5.2)
// ---------------------------------------------------------------------------

/** Props for LaneTree. */
export interface LaneTreeProps {
  /** Blocks from buildLaneBlocks. */ readonly blocks: readonly LaneBlock[];
  /** Evidence per row key, derived over the axis domain through 05's LaneEvidenceCache (§5.3). */ readonly evidence: ReadonlyMap<string, LaneEvidenceResult>;
  /** Selected lane key, or null. */ readonly selected: TargetKey | null;
  /** The page axis. */ readonly axis: TimeAxis;
  /** The page readout registry. */ readonly readouts: ReadoutRegistry;
  /** Estate clock (axis ticks, readout text). */ readonly clock: EstateClock;
  /** While following live: the no-data tail at the live edge that "worst in view" ignores (history cache age); 0 otherwise. */ readonly liveTailSeconds?: number;
  /** false in kiosk: list semantics, no focus, no overlay, no expand/select. */ readonly interactive: boolean;
  /** CursorReadout summaryId, passed as PlotOverlay describedBy. */ readonly readoutId: string;
  /** Evidence status line (§5.5), rendered under the heading; null when all evidence is ready. */ readonly status: ReactElement | null;
  /** Expand/collapse a host or the Domains group. */ readonly onToggle: (key: TargetKey | "domains") => void;
  /** Select a host or service lane (writes sel). Domain rows are never selectable. */ readonly onSelect: (node: LaneNode) => void;
  /** Check-history gate (09 §1): a service, domain or Domains header whose endpoints all fail it reads "check history not available". */ readonly reachable: (key: string) => boolean;
}

/** The status-lane region: heading, legend, evidence status, axis, tree labels and one plot per block. */
export function LaneTree(props: LaneTreeProps): ReactElement {
  useSignals();
  const { blocks, evidence, interactive } = props;
  const view = props.axis.view.value;
  const treeRef = useRef<HTMLDivElement>(null);
  const plotColRef = useRef<HTMLDivElement>(null);
  const rovingRef = useRef<RovingController | null>(null);
  const [rowPx, setRowPx] = useState(DEFAULT_ROW_PX);
  const [plotWidth, setPlotWidth] = useState(MIN_PLOT_WIDTH_PX);

  const rows = blocks.flatMap((b) => b.rows);
  const views = new Map(rows.map((row) => [row.key, rowView(row, evidence, view, props.reachable, props.liveTailSeconds ?? 0)] as const));
  const rowKeys = rows.map((r) => r.key).join("|");

  // Callbacks are read through a ref so the key handler never goes stale.
  const live = useRef({ rows, onToggle: props.onToggle, onSelect: props.onSelect });
  live.current = { rows, onToggle: props.onToggle, onSelect: props.onSelect };

  // Row height and plot width: measured on mount and on ResizeObserver callbacks; defaults otherwise.
  useEffect(() => {
    const measure = (): void => {
      const rowEl = treeRef.current?.querySelector<HTMLElement>("[data-tree-row]");
      const h = rowEl?.getBoundingClientRect().height ?? 0;
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
      if (treeRef.current !== null) ro.observe(treeRef.current);
      if (plotColRef.current !== null) ro.observe(plotColRef.current);
    } catch {
      ro = null;
    }
    return () => ro?.disconnect();
  }, []);

  // Roving tabindex: ↑/↓/Home/End and the single tab stop (desk only).
  useEffect(() => {
    const tree = treeRef.current;
    if (!interactive || tree === null) return undefined;
    const selectedIndex = live.current.rows.findIndex((r) => r.key === props.selected);
    const roving = rovingTabindex(tree, {
      itemSelector: '[role="treeitem"]',
      orientation: "vertical",
      wrap: false,
      initialIndex: selectedIndex < 0 ? 0 : selectedIndex,
    });
    rovingRef.current = roving;
    return () => {
      roving.release();
      rovingRef.current = null;
    };
  }, [interactive]);

  useEffect(() => {
    rovingRef.current?.refresh();
  }, [rowKeys]);

  const indexOfKey = (key: string): number => live.current.rows.findIndex((r) => r.key === key);

  const onKeyDown = (e: ReactKeyboardEvent): void => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const target = e.target as Element | null;
    const key = target?.closest?.("[data-lane-key]")?.getAttribute("data-lane-key");
    if (key === null || key === undefined) return;
    const { rows: current, onToggle, onSelect } = live.current;
    const i = current.findIndex((r) => r.key === key);
    const row = current[i];
    if (row === undefined) return;
    let handled = false;
    if (e.key === "ArrowRight") {
      if (isExpandable(row) && !isExpanded(row)) {
        onToggle(row.kind === "domains" ? "domains" : (row.key as TargetKey));
        handled = true;
      } else if (isExpandable(row) && isExpanded(row)) {
        rovingRef.current?.setActive(i + 1);
        handled = true;
      }
    } else if (e.key === "ArrowLeft") {
      if (isExpandable(row) && isExpanded(row)) {
        onToggle(row.kind === "domains" ? "domains" : (row.key as TargetKey));
        handled = true;
      } else if (row.kind === "service" || row.kind === "domain") {
        const parent = indexOfKey(row.kind === "service" ? row.parentKey : "domains");
        if (parent >= 0) rovingRef.current?.setActive(parent);
        handled = true;
      }
    } else if (e.key === "Enter") {
      if (row.kind === "host" || row.kind === "service") {
        onSelect(row.node);
        handled = true;
      } else if (row.kind === "domains") {
        onToggle("domains");
        handled = true;
      }
    }
    if (handled) e.preventDefault();
  };

  const onRowClick = (row: LaneRow): void => {
    const i = indexOfKey(row.key);
    if (row.kind === "host" || row.kind === "service") {
      props.onSelect(row.node);
      if (i >= 0) rovingRef.current?.setActive(i);
    } else if (row.kind === "domains") {
      props.onToggle("domains");
      if (i >= 0) rovingRef.current?.setActive(i);
    }
  };

  const renderRow = (row: LaneRow): ReactElement => {
    const v = views.get(row.key)!;
    const expandable = isExpandable(row);
    const selectable = row.kind === "host" || row.kind === "service";
    const treeAttrs: HTMLAttributes<HTMLDivElement> = interactive
      ? {
          role: "treeitem",
          "aria-level": row.level,
          "aria-setsize": row.setSize,
          "aria-posinset": row.posInSet,
          ...(expandable ? { "aria-expanded": isExpanded(row) ? "true" : "false" } : {}),
          ...(selectable ? { "aria-selected": row.key === props.selected ? "true" : "false" } : {}),
          onClick: () => onRowClick(row),
        }
      : { role: "listitem" };
    return (
      <div
        key={row.key}
        className={ROW_CLASS}
        data-tree-row=""
        data-roving-item={interactive ? "" : undefined}
        data-lane-key={row.key}
        data-level={row.level}
        data-status={v.worst.status}
        data-partial={v.partial ? "true" : undefined}
        title={rowTitle(v)}
        {...treeAttrs}
      >
        {interactive ? (
          <span
            data-slot="timeline-lane-twisty"
            className="inline-flex w-4 flex-none items-center"
            aria-hidden="true"
            onClick={
              expandable
                ? (e: ReactMouseEvent) => {
                    e.stopPropagation();
                    props.onToggle(row.kind === "domains" ? "domains" : (row.key as TargetKey));
                  }
                : undefined
            }
          >
            {expandable ? <Icon name={isExpanded(row) ? "chevron-down" : "chevron-right"} size={14} /> : null}
          </span>
        ) : null}
        <span data-slot="timeline-lane-name" className="min-w-0 truncate">
          {v.name}
        </span>
        {row.kind === "domain" ? <span className="sr-only"> DNS check</span> : null}
        <span className="sr-only">worst in view:</span>
        {StatusBadge.fromMap(TARGET_STATUS, v.worst.status, badgeProps(v.worst.status, v.worst.text))}
        {v.partial ? <LaneSuffix>{PARTIAL_EVIDENCE_TEXT}</LaneSuffix> : null}
        {v.unavailable ? <LaneSuffix>{CHECK_HISTORY_UNAVAILABLE_TEXT}</LaneSuffix> : null}
      </div>
    );
  };

  return (
    <Section title="Status lanes" headingId="timeline-lanes-title" data-slot="timeline-lanes" actions={<LanesLegend />}>
      {props.status}
      <div data-slot="timeline-lanes-grid" className={LANES_GRID_CLASS}>
        <div data-slot="timeline-lane-labels" className="min-w-0">
          <div data-slot="timeline-axis-spacer" className={ROW_HEIGHT_CLASS} aria-hidden="true" />
          <div
            id="timeline-lane-tree"
            ref={treeRef}
            className="flex flex-col"
            role={interactive ? "tree" : "list"}
            aria-label="Status lanes by host"
            onKeyDown={interactive ? onKeyDown : undefined}
          >
            {rows.map(renderRow)}
          </div>
        </div>
        <div ref={plotColRef} data-slot="timeline-plot-col" className={PLOT_COL_CLASS}>
          <LaneAxis view={view} clock={props.clock} width={plotWidth} height={rowPx} />
          {blocks.map((block, blockIndex) => (
            <PlotBlock
              key={block.id}
              block={block}
              blockIndex={blockIndex}
              views={views}
              view={view}
              width={plotWidth}
              rowPx={rowPx}
              props={props}
            />
          ))}
        </div>
      </div>
    </Section>
  );
}

interface PlotBlockProps {
  readonly block: LaneBlock;
  readonly blockIndex: number;
  readonly views: ReadonlyMap<string, RowView>;
  readonly view: TimeWindow;
  readonly width: number;
  readonly rowPx: number;
  readonly props: LaneTreeProps;
}

/** Decoration marks for one block: dashed outlines on partial rows, a solid outline on the selected row. */
function blockMarks(block: LaneBlock, views: ReadonlyMap<string, RowView>, selected: TargetKey | null): DecorationMark[] {
  const marks: DecorationMark[] = [];
  block.rows.forEach((row, lane) => {
    if (views.get(row.key)?.partial === true) marks.push({ kind: "partial-lane", lane });
    if (selected !== null && row.key === selected) marks.push({ kind: "selected-lane", lane });
  });
  return marks;
}

/** One StatusTimeline + decorations (+ overlay in desk mode), with its readout source. */
function PlotBlock(p: PlotBlockProps): ReactElement {
  const { block, blockIndex, views, view, width, rowPx } = p;
  const { readouts, clock, evidence } = p.props;
  const laneHeight = rowPx - LANE_GAP_PX;

  useEffect(() => {
    const formatSec = (s: number): string => clock.format(isoOf(s));
    const read = (t: number): readonly LaneReadout[] =>
      block.rows.map((row) => {
        const result = evidence.get(row.key) ?? EMPTY_RESULT;
        const seg = segmentAt(result.segments, t);
        const status: TargetStatus = seg?.status ?? "unknown";
        let text = seg === null || seg.cause === "no-data" ? NO_DATA_TEXT : STATUS_LABEL[seg.status];
        if (seg !== null && seg.alertnames.length > 0) text += ` — ${seg.alertnames.join(", ")}`;
        return { label: rowAccessibleName(row), status, text, partial: partialReasonText(result, formatSec) };
      });
    return readouts.register({ id: block.id, read }, LANE_READOUT_ORDER + blockIndex);
  }, [block, blockIndex, evidence, readouts, clock]);

  const lanes: TimelineLane[] = block.rows.map((row) => {
    const v = views.get(row.key)!;
    return { id: row.key, label: laneAccessibleLabel(v), segments: v.result.segments };
  });

  return (
    <div data-slot="timeline-plot-block" className={PLOT_BLOCK_CLASS} data-block={block.id}>
      <StatusTimeline
        className="block max-w-none"
        lanes={lanes}
        domainStart={view.start}
        domainEnd={view.end}
        width={width}
        laneHeight={laneHeight}
        laneGap={LANE_GAP_PX}
        ariaLabel={`${block.label}: status over the visible window`}
      />
      <LaneDecorations
        marks={blockMarks(block, views, p.props.selected)}
        laneCount={block.rows.length}
        domainStart={view.start}
        domainEnd={view.end}
        width={width}
        laneHeight={laneHeight}
        laneGap={LANE_GAP_PX}
      />
      {p.props.interactive ? (
        <PlotOverlay axis={p.props.axis} label={block.label} placement={{ kind: "fill" }} interactive describedBy={p.props.readoutId} />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Private: legend and axis (07 §5.6, §5.7)
// ---------------------------------------------------------------------------

/** Status lane legend: the four statuses in words, the partial swatch and the provenance note. */
function LanesLegend(): ReactElement {
  return (
    <ul
      data-slot="timeline-lanes-legend"
      className="m-0 flex list-none flex-wrap items-center gap-x-3 gap-y-1 p-0 text-sm text-muted-foreground"
      aria-label="Status lane legend"
    >
      {LEGEND_STATUSES.map(([status, label]) => (
        <li key={status} className="flex items-center">
          {StatusBadge.fromMap(TARGET_STATUS, status, badgeProps(status, label))}
        </li>
      ))}
      <li className="flex items-center gap-1">
        <span data-slot="timeline-legend-partial" className="inline-block h-2 w-4 border border-dashed border-border" aria-hidden="true" />
        {PARTIAL_EVIDENCE_TEXT}
      </li>
      <li>
        <span data-slot="timeline-provenance" className="font-medium">
          Checks (Gatus)
        </span>
      </li>
      <li>{" Lane status is the worst of attributed alerts and Gatus check failures."}</li>
    </ul>
  );
}

interface LaneAxisProps {
  readonly view: TimeWindow;
  readonly clock: EstateClock;
  readonly width: number;
  readonly height: number;
}

/** Decorative estate-time axis, one row high; exact times come from the cursor readout. */
function LaneAxis(props: LaneAxisProps): ReactElement {
  const { width, height } = props;
  const ticks = computeAxisTicks(props.view, props.clock, Math.max(2, Math.floor(width / AXIS_LABEL_MIN_PX)));
  return (
    <svg
      data-slot="timeline-axis"
      className="block max-w-none"
      aria-hidden="true"
      focusable="false"
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
    >
      {ticks.map((tick) => {
        const x = tick.fraction * width;
        const nearEnd = tick.fraction > 0.9;
        return (
          <g key={tick.t}>
            <line className="stroke-border stroke-1" x1={x} x2={x} y1={0} y2={height} />
            <text
              className="fill-muted-foreground text-xs"
              x={nearEnd ? x - 2 : x + 2}
              y={height / 2}
              textAnchor={nearEnd ? "end" : "start"}
              dominantBaseline="central"
            >
              {tick.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
