import { lazy, Suspense } from "react";
import type { TargetStatus } from "@pulse/web-data/wire";
import { LoadingState } from "@/ui/patterns/loading-state";
import { cn } from "@/ui/lib/utils";

/** One plotted series aligned to the chart's `timestamps`. */
export interface TimeSeriesSeries {
  /** Legend label. */
  label: string;
  /** y-values aligned index-for-index with `timestamps`; null is a gap. */
  data: readonly (number | null)[];
  /** Strokes the series with the status tone (suppressed dashed); otherwise `--chart-N` by index. */
  status?: TargetStatus;
}

/** A canvas time-series chart (uPlot), loaded on first render. */
export interface TimeSeriesChartProps {
  /** Shared x-axis, unix seconds ascending. Empty renders an empty chart. */
  timestamps: readonly number[];
  /** One or more y-series aligned to `timestamps`. Empty renders an empty chart. */
  series: readonly TimeSeriesSeries[];
  /** Height in px; width follows the container. Default 240. */
  height?: number;
  /** Accessible label. Default "time series chart". */
  ariaLabel?: string;
  /**
   * Y-axis tick labels, one per tick value (e.g. unit-aware `5.6 GiB`). Default: uPlot's own
   * number formatting. Pass a stable function: the chart reads it when it builds.
   */
  formatYTicks?: (splits: readonly number[]) => string[];
  /**
   * Y-axis tick positions for a scale range, at most `maxTicks` of them (e.g. steps that are round
   * in the display unit: 0.5 GiB, 15 min). Default: uPlot's decimal increments. Pass a stable function.
   */
  splitYTicks?: (min: number, max: number, maxTicks: number) => number[];
  className?: string;
}

export const TIME_SERIES_DEFAULT_HEIGHT = 240;

// uPlot lives only behind this dynamic import, so it never lands in an entry chunk. `@__PURE__` lets
// the bundler drop this module (and the uPlot chunk) from any build that never renders the chart.
const UplotChart = /* @__PURE__ */ lazy(() => import("./uplot-chart"));

/**
 * The placeholder shown while the uPlot chunk loads: a skeleton of the chart's height. Exported for
 * tests (not from the barrel): once the chunk has loaded in a process, `React.lazy` renders the chart
 * synchronously and this never shows again.
 */
export function TimeSeriesChartFallback({ height, className }: { height: number; className?: string | undefined }) {
  return (
    <div
      data-slot="time-series-chart"
      data-state="loading"
      className={cn("w-full overflow-hidden", className)}
      style={{ height }}
    >
      <LoadingState label="Loading chart…" hideLabel rows={1} className="h-full" />
    </div>
  );
}

/** The chart, with a skeleton of the same height while the uPlot chunk loads. */
export function TimeSeriesChart(props: TimeSeriesChartProps) {
  const height = props.height ?? TIME_SERIES_DEFAULT_HEIGHT;
  return (
    <Suspense fallback={<TimeSeriesChartFallback height={height} className={props.className} />}>
      <UplotChart {...props} />
    </Suspense>
  );
}
