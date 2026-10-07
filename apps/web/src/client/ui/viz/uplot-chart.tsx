// The only module that imports uPlot. Reached solely through the dynamic import in
// time-series-chart.tsx, so uPlot's JS rides its own lazy chunk. Its stylesheet is imported here, but
// the build folds it into the entry sheet (no chunk stylesheet ships).
import { useEffect, useRef } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";

import { attachChunkStyles } from "@/store/chunk-css";
import { cn } from "@/ui/lib/utils";
import { MARK_DASH, toneFgVar, vizStatusMark } from "@/ui/viz/status-marks";
import {
  TIME_SERIES_DEFAULT_HEIGHT,
  type TimeSeriesChartProps,
  type TimeSeriesSeries,
} from "@/ui/viz/time-series-chart";

/** chunkCss key of this module's stylesheet (its path under src/client, no extension). */
export const UPLOT_CHUNK_CSS_KEY = "ui/viz/uplot-chart";

/** Theme colours resolved for the canvas, which cannot read `var()`. */
export interface ThemeColors {
  axis: string;
  grid: string;
  text: string;
  /** Per-series stroke, index-for-index with the series. */
  strokes: readonly string[];
}

/** Non-status series cycle through the chart palette. */
const CHART_TOKENS = ["--chart-1", "--chart-2", "--chart-3", "--chart-4", "--chart-5"] as const;

/** The CSS custom property a series strokes with. */
export function seriesColorVar(series: TimeSeriesSeries, index: number): string {
  return series.status !== undefined
    ? toneFgVar(vizStatusMark(series.status).tone)
    : CHART_TOKENS[index % CHART_TOKENS.length]!;
}

/**
 * Resolve theme token values from `root`'s computed style. An unresolved token
 * falls back to `currentColor`, so uPlot never gets an empty colour.
 */
export function readThemeColors(
  root: HTMLElement,
  series: readonly TimeSeriesSeries[],
): ThemeColors {
  const cs = root.ownerDocument.defaultView?.getComputedStyle(root) ?? null;
  const read = (name: string): string => {
    const v = cs?.getPropertyValue(name).trim() ?? "";
    return v !== "" ? v : "currentColor";
  };
  return {
    axis: read("--border"),
    grid: read("--border"),
    text: read("--muted-foreground"),
    strokes: series.map((s, i) => read(seriesColorVar(s, i))),
  };
}

/** Minimum px between x (time) ticks: room for a "6:00am"-style label plus a gap, so uPlot steps
 *  to a coarser time increment instead of crowding labels together. */
export const X_TICK_SPACE = 72;

/** Default y-axis width (uPlot's own default), used whenever the labels fit in it. */
const Y_AXIS_MIN_SIZE = 50;

/** Approximate advance of one axis-label character at uPlot's 12px axis font. */
const AXIS_CHAR_PX = 8;

/** Tick length plus gap that uPlot draws between the plot edge and the label. */
const Y_AXIS_GUTTER_PX = 15;

/**
 * Y-axis width that fits its longest tick label, so large values (bytes, counts) are not clipped
 * at uPlot's fixed default width.
 */
export function yAxisSize(values: readonly string[] | null | undefined): number {
  const longest = (values ?? []).reduce((max, v) => Math.max(max, v.length), 0);
  return Math.max(Y_AXIS_MIN_SIZE, Math.ceil(longest * AXIS_CHAR_PX) + Y_AXIS_GUTTER_PX);
}

/** uPlot options from props, the container width and the resolved colours. */
export function buildOptions(
  props: TimeSeriesChartProps,
  width: number,
  colors: ThemeColors,
): uPlot.Options {
  const axis: uPlot.Axis = {
    stroke: colors.text,
    grid: { stroke: colors.grid },
    ticks: { stroke: colors.axis },
  };
  return {
    width: Math.max(1, width),
    height: props.height ?? TIME_SERIES_DEFAULT_HEIGHT,
    series: [
      // The x (time) series has no stroke; uPlot draws it as the time axis.
      {},
      ...props.series.map((s, i) => {
        const dash = s.status !== undefined ? MARK_DASH[vizStatusMark(s.status).pattern] : null;
        return {
          label: s.label,
          stroke: colors.strokes[i] ?? colors.text,
          ...(dash !== null ? { dash: [...dash] } : {}),
        };
      }),
    ],
    axes: [
      { ...axis, space: X_TICK_SPACE },
      { ...axis, size: (_self, values) => yAxisSize(values) },
    ],
    legend: { show: props.series.length > 1 },
  };
}

/** uPlot data `[timestamps, ...series]`, copied (uPlot keeps a reference to its data). */
export function buildData(props: TimeSeriesChartProps): uPlot.AlignedData {
  return [[...props.timestamps], ...props.series.map((s) => [...s.data])] as uPlot.AlignedData;
}

export default function UplotChart(props: TimeSeriesChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const height = props.height ?? TIME_SERIES_DEFAULT_HEIGHT;

  useEffect(() => {
    const el = containerRef.current;
    if (el === null) return;
    const doc = el.ownerDocument;
    const win = doc.defaultView;

    void attachChunkStyles(UPLOT_CHUNK_CSS_KEY, doc);
    if (props.timestamps.length === 0 || props.series.length === 0) return;

    let chart: uPlot | null = null;
    let frame: number | null = null;
    let disposed = false;

    const build = (): void => {
      chart?.destroy();
      const colors = readThemeColors(doc.documentElement, props.series);
      chart = new uPlot(buildOptions(props, el.clientWidth, colors), buildData(props), el);
    };
    build();

    const ro =
      typeof win?.ResizeObserver === "function"
        ? new win.ResizeObserver(() => chart?.setSize({ width: el.clientWidth, height }))
        : null;
    ro?.observe(el);

    // The theme switches by class/attributes on <html>; rebuild with the new token values on
    // the next frame, after the new styles apply.
    const rebuild = (): void => {
      if (disposed) return;
      if (typeof win?.requestAnimationFrame === "function") {
        if (frame !== null) win.cancelAnimationFrame(frame);
        frame = win.requestAnimationFrame(() => {
          frame = null;
          if (!disposed) build();
        });
      } else {
        queueMicrotask(() => {
          if (!disposed) build();
        });
      }
    };
    const mo =
      typeof win?.MutationObserver === "function" ? new win.MutationObserver(rebuild) : null;
    mo?.observe(doc.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style", "data-theme"],
    });

    return () => {
      disposed = true;
      mo?.disconnect();
      ro?.disconnect();
      if (frame !== null) win?.cancelAnimationFrame(frame);
      chart?.destroy();
      chart = null;
    };
  }, [props.timestamps, props.series, height]);

  return (
    <div
      ref={containerRef}
      data-slot="time-series-chart"
      data-state="ready"
      role="img"
      aria-label={props.ariaLabel ?? "time series chart"}
      className={cn("w-full", props.className)}
      style={{ height }}
    />
  );
}
