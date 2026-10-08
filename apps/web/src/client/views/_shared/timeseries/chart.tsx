// One lazy uPlot time-series chart on the shared time axis (06 §6; REQ-CHART-03, REQ-CAP-02,
// REQ-ZOOM-03). Estate-zone data, a PlotOverlay measured onto uPlot's `.u-over`, and readout
// registration. It never fetches (REQ-CHART-04). The only signal read in render is axis.view.
import type { ReactElement } from "react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { HistoryPayload, RangeId } from "@pulse/web-data/wire";
import { EmptyState, Skeleton, TimeSeriesChart } from "@/ui";
import type { TimeSeriesSeries } from "@/ui";
import { TZ_FALLBACK_MARKER } from "../../../format.js";
import type { EstateClock } from "../../../format.js";
import type { TimeAxis } from "./axis.js";
import { formatStepLabel } from "./axis.js";
import type { ClientQueryMeta } from "./query-meta.js";
import { chartFractionMap, formatAxisTicks, sameChartData, toChartData } from "./chart-data.js";
import type { ChartData } from "./chart-data.js";
import { PlotOverlay } from "./overlay.js";
import type { OverlayPlacement, OverlayRect } from "./overlay-gesture.js";
import { CursorReadout, createReadoutRegistry } from "./readout.js";
import type { ReadoutRegistry } from "./readout.js";
import { createChartReadoutSource } from "./readout-model.js";
import { useSignals } from "@preact/signals-react/runtime";

/** How a chart's cursor readout is presented. */
export type ChartReadoutMode =
  /** Page-synced (timeline detail): register with the page registry; the overlay describes itself with the page summary. */
  | { readonly mode: "page"; readonly registry: ReadoutRegistry; readonly summaryId: string; readonly order?: number }
  /** Stand-alone (engine trends): a private registry and an inline CursorReadout under the chart. */
  | { readonly mode: "local" };

/** Props for SyncedChart (tech-spec §3.7, tech-spec §3.9, tech-spec §3.2 "Trends"). */
export interface SyncedChartProps {
  /** Stable chart id (e.g. `${targetKey}|${queryId}`); the readout source id and the data-chart-id attribute. */
  chartId: string;
  /** Chart title, e.g. "CPU utilization" (plain text). */
  title: string;
  /** Display unit (CLIENT_QUERY_META[id].unit). */
  unit: ClientQueryMeta["unit"];
  /** Range shown in the caption (REQ-CAP-02: labelled with range and unit). */
  range: RangeId;
  /** Data to plot: the `data` argument of HistoryRegion's render-prop; null = still loading with nothing to show. */
  payload: HistoryPayload | null;
  /** Page axis (timeline) or per-chart axis (engine). */
  axis: TimeAxis;
  /** Estate clock: zone for the data shift, labels and readout time. */
  clock: EstateClock;
  /** Plot height in px, forwarded to TimeSeriesChart. Default 200. */
  height?: number;
  /** False in kiosk: the overlay becomes a passive shield and no readout is rendered. */
  interactive: boolean;
  /** Readout presentation. */
  readout: ChartReadoutMode;
  /**
   * Unit wording for the caption and the plot's accessible name, when the caller words the unit
   * more precisely than the display unit kind (e.g. "rows per second" for a `count` rate). Default
   * UNIT_LABEL[unit].
   */
  unitLabel?: string;
  /**
   * Where the figure's name and description come from. `"visible"` (default) renders the
   * figcaption with title, range, unit and zone. `{ labelledBy, describedBy }` is for a caller that
   * already shows those as a heading and meta line: the figure is labelled by those elements
   * (aria-labelledby/aria-describedby) and only the facts they lack (resolution, zone fallback) are
   * shown, so nothing is printed twice.
   */
  caption?: "visible" | { readonly labelledBy: string; readonly describedBy?: string };
}

/** How long .u-over may be absent after the chart container exists before the loud failure fires, ms. */
export const UOVER_GRACE_MS = 1_000;

/** Measured overlay state, mirrored to data-overlay-state on the timeseries-plot slot (test hook). */
type OverlayState = "pending" | "measured" | "missing-u-over" | "empty";

/** Display unit labels for the caption and aria-label. */
const UNIT_LABEL: Readonly<Record<ClientQueryMeta["unit"], string>> = {
  count: "count",
  bytes: "bytes",
  seconds: "seconds",
  percent: "%",
  scalar: "value",
  milliseconds: "ms",
  state: "state",
};

/** Stable empty arrays, so an empty chart never gets a new data identity (no uPlot churn). */
const EMPTY_NUMBERS: readonly number[] = Object.freeze([]);
const EMPTY_SERIES: readonly TimeSeriesSeries[] = Object.freeze([]);

const INERT: OverlayPlacement = { kind: "inert" };

const MISSING_U_OVER_TEXT = "[timeline] uPlot .u-over not found — chart overlay disabled (uPlot DOM changed?)";

/** Run `cb` on the next animation frame; microtask fallback when rAF is missing or throws. */
function requestFrame(cb: () => void): () => void {
  let cancelled = false;
  const run = (): void => {
    if (!cancelled) cb();
  };
  const raf = (globalThis as { requestAnimationFrame?: (cb: FrameRequestCallback) => number }).requestAnimationFrame;
  let scheduled = false;
  if (typeof raf === "function") {
    try {
      raf(() => run());
      scheduled = true;
    } catch {
      /* fall through to the microtask fallback */
    }
  }
  if (!scheduled) queueMicrotask(run);
  return () => {
    cancelled = true;
  };
}

function sameRect(a: OverlayRect | null, b: OverlayRect): boolean {
  return a !== null && a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height;
}

/**
 * One uPlot time-series chart that shares the page time axis (REQ-CHART-03): lazy chart, estate-zone
 * data, a measured interaction overlay and readout registration. It does not fetch (REQ-CHART-04).
 * The caller wraps it in 02's RegionErrorBoundary and HistoryRegion (error, not-applicable and
 * stale states).
 */
export function SyncedChart(props: SyncedChartProps): ReactElement {
  useSignals();
  const { chartId, title, unit, range, payload, axis, clock, interactive, readout } = props;
  const height = props.height ?? 200;
  const unitLabel = props.unitLabel ?? UNIT_LABEL[unit];
  const caption = props.caption ?? "visible";
  const formatYTicks = useMemo(() => (splits: readonly number[]) => formatAxisTicks(splits, unit), [unit]);
  const detailId = useId();

  const view = axis.view.value; // the only signal read in render
  const fresh = payload === null ? null : toChartData(payload, view, clock.timezone);
  const prevRef = useRef<ChartData | null>(null);
  const data = sameChartData(prevRef.current, fresh) ? prevRef.current : fresh; // §4.4 content guard
  prevRef.current = data;
  const dataRef = useRef<ChartData | null>(data);
  dataRef.current = data;
  const ts: readonly number[] = data?.timestamps ?? EMPTY_NUMBERS;
  const series: readonly TimeSeriesSeries[] = data?.series ?? EMPTY_SERIES;
  const xMap = useMemo(() => (data === null ? null : chartFractionMap(data)), [data]);

  // --- .u-over measurement (§6.4) ---
  const plotRef = useRef<HTMLDivElement>(null);
  const [overlayState, setOverlayState] = useState<OverlayState>("pending");
  const [rect, setRect] = useState<OverlayRect | null>(null);
  const m = useRef<{ cancelFrame: (() => void) | null; grace: ReturnType<typeof setTimeout> | null; logged: boolean; alive: boolean }>({
    cancelFrame: null,
    grace: null,
    logged: false,
    alive: true,
  });

  const clearGraceTimer = (): void => {
    if (m.current.grace !== null) clearTimeout(m.current.grace);
    m.current.grace = null;
  };

  const measure = (): void => {
    const plot = plotRef.current;
    if (plot === null || !m.current.alive) return;
    const d = dataRef.current;
    if (d === null || d.series.length === 0 || d.timestamps.length === 0) {
      clearGraceTimer();
      setOverlayState("empty");
      return;
    }
    const over = plot.querySelector<HTMLElement>(".u-over");
    if (over === null) {
      // Container not yet built, or uPlot not yet created: stay pending and arm the grace timer.
      // The chart's own loading fallback shares the slot, so it does not count as the container.
      if (plot.querySelector('[data-slot="time-series-chart"]:not([data-state="loading"])') !== null && m.current.grace === null) {
        m.current.grace = setTimeout(() => {
          m.current.grace = null;
          const p = plotRef.current;
          if (p === null || !m.current.alive) return;
          if (p.querySelector(".u-over") !== null) {
            measure();
            return;
          }
          setOverlayState("missing-u-over");
          if (!m.current.logged) {
            m.current.logged = true;
            console.error(MISSING_U_OVER_TEXT);
          }
        }, UOVER_GRACE_MS);
      }
      return;
    }
    clearGraceTimer();
    const p = plot.getBoundingClientRect();
    const o = over.getBoundingClientRect();
    if (!(o.width > 0) || !(o.height > 0)) return; // not laid out yet; the next trigger retries
    const next: OverlayRect = { left: o.left - p.left, top: o.top - p.top, width: o.width, height: o.height };
    setRect((prev) => (sameRect(prev, next) ? prev : next));
    setOverlayState("measured");
  };
  const measureRef = useRef(measure);
  measureRef.current = measure;

  const scheduleMeasure = (): void => {
    if (m.current.cancelFrame !== null) return; // coalesced to one frame
    m.current.cancelFrame = requestFrame(() => {
      m.current.cancelFrame = null;
      measureRef.current();
    });
  };

  // Mount: observers for DOM replacement (lazy resolve, uPlot rebuilds, theme) and resizes.
  useEffect(() => {
    m.current.alive = true;
    const plot = plotRef.current;
    const MO = (globalThis as { MutationObserver?: typeof MutationObserver }).MutationObserver;
    const RO = (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
    let mo: MutationObserver | null = null;
    let ro: ResizeObserver | null = null;
    if (plot !== null && typeof MO === "function") {
      try {
        mo = new MO(() => scheduleMeasure());
        mo.observe(plot, { childList: true, subtree: true });
      } catch {
        mo = null;
      }
    }
    if (plot !== null && typeof RO === "function") {
      try {
        ro = new RO(() => scheduleMeasure());
        ro.observe(plot);
      } catch {
        ro = null;
      }
    }
    scheduleMeasure();
    return () => {
      m.current.alive = false;
      mo?.disconnect();
      ro?.disconnect();
      m.current.cancelFrame?.();
      m.current.cancelFrame = null;
      clearGraceTimer();
    };
  }, []);

  // Data identity change (tech-spec §3.7): re-measure; the previous rect stays in use meanwhile.
  useEffect(() => {
    scheduleMeasure();
  }, [data]);

  // --- Readout registration (§6.5) ---
  const localRegistry = useMemo(() => createReadoutRegistry(), []);
  const localSummaryId = useId();
  const registry = readout.mode === "page" ? readout.registry : localRegistry;
  const order = readout.mode === "page" ? readout.order : undefined;
  useEffect(
    () => registry.register(createChartReadoutSource(chartId, title, unit, () => dataRef.current), order),
    [registry, chartId, title, unit, order],
  );
  const firstData = useRef(true);
  useEffect(() => {
    if (firstData.current) {
      firstData.current = false;
      return;
    }
    registry.invalidate(); // a pinned cursor's readout refreshes
  }, [data, registry]);
  const describedBy = readout.mode === "page" ? readout.summaryId : localSummaryId;

  const placement = useMemo<OverlayPlacement>(() => (rect === null ? INERT : { kind: "rect", rect }), [rect]);
  const tzFallback = clock.tzFallback || data?.tzFallback === true;

  return (
    <figure
      data-slot="synced-chart"
      data-chart-id={chartId}
      className="m-0 flex min-w-0 flex-col gap-1"
      {...(caption === "visible"
        ? {}
        : {
            "aria-labelledby": caption.labelledBy,
            "aria-describedby": [caption.describedBy, detailId].filter((id) => id !== undefined).join(" "),
          })}
    >
      {caption === "visible" ? (
        <figcaption className="flex flex-wrap gap-x-3 gap-y-1 text-sm break-words text-muted-foreground">
          <span className="font-medium text-foreground">{title}</span>
          <span>{`${range} · ${unitLabel}`}</span>
          {data !== null ? <span>{`resolution: ${formatStepLabel(data.stepSeconds)}`}</span> : null}
          <span>
            {`Times in ${clock.timezone}`}
            {tzFallback ? ` — ${TZ_FALLBACK_MARKER}` : null}
          </span>
        </figcaption>
      ) : (
        <p id={detailId} data-slot="synced-chart-detail" className="m-0 text-xs break-words text-muted-foreground">
          {data !== null ? `resolution: ${formatStepLabel(data.stepSeconds)}` : null}
          {tzFallback ? `${data !== null ? " · " : ""}${TZ_FALLBACK_MARKER}` : null}
        </p>
      )}
      <div ref={plotRef} data-slot="timeseries-plot" data-overlay-state={overlayState} className="relative">
        <TimeSeriesChart
          timestamps={ts}
          series={series}
          height={height}
          ariaLabel={`${title}, ${range}, ${unitLabel}`}
          formatYTicks={formatYTicks}
        />
        {payload === null ? (
          <div data-slot="timeseries-plot-loading" className="absolute inset-0" aria-hidden="true">
            <Skeleton className="size-full" />
          </div>
        ) : null}
        {data !== null && data.series.length > 0 ? (
          <PlotOverlay
            axis={axis}
            label={`${title} chart`}
            placement={placement}
            interactive={interactive}
            zoomable={readout.mode === "page"}
            xMap={xMap}
            describedBy={describedBy}
          />
        ) : null}
      </div>
      {data !== null && data.series.length === 0 ? (
        <EmptyState title="No data" description="No series returned for this range." />
      ) : null}
      {data !== null && data.series.length > 0 && !data.hasData ? (
        <p className="m-0 text-sm text-muted-foreground">No data in this window</p>
      ) : null}
      {readout.mode === "local" && interactive && data !== null ? (
        <CursorReadout axis={axis} registry={localRegistry} clock={clock} summaryId={localSummaryId} variant="inline" />
      ) : null}
    </figure>
  );
}

/**
 * Starts the lazy uPlot chunk download without showing anything: a `hidden` wrapper around the lazy
 * chart with empty arrays, whose empty guard creates no uPlot. Callers render it as soon as a chart
 * region is requested, next to the HistoryRegion that is still loading (§6.3).
 */
export function ChartChunkPrefetch(): ReactElement {
  return (
    <div data-slot="chart-prefetch" hidden>
      <TimeSeriesChart timestamps={EMPTY_NUMBERS} series={EMPTY_SERIES} height={1} />
    </div>
  );
}
