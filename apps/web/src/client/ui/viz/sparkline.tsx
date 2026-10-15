import { TONE_SVG_FILL, TONE_SVG_STROKE } from "@/ui/lib/tone";
import { cn } from "@/ui/lib/utils";
import { clamp, round2 } from "@/ui/viz/geometry";
import { MARK_DASH, presentationMark, type VizMarkSource } from "@/ui/viz/status-marks";

/** One timestamped sample. A null value is an explicit gap and is never bridged. */
export interface SparklineSample {
  readonly at: number;
  readonly value: number | null;
}

/** A compact, dependency-free SVG trend line, coloured by status tone. */
export interface SparklineProps {
  /**
   * Values ordered oldest → newest, one per evenly spaced slot. A non-finite value is a gap, as
   * a null sample is. Do not combine with `samples`.
   */
  values?: readonly number[];
  /** Timestamped input with explicit gaps. Do not combine with `values`. */
  samples?: readonly SparklineSample[];
  width?: number;
  height?: number;
  /** Domain lower bound; lower values are drawn on the bottom edge. Default: the data minimum. */
  min?: number;
  /** Domain upper bound; higher values are drawn on the top edge. Default: the data maximum. */
  max?: number;
  strokeWidth?: number;
  /**
   * Colours the line with a status-map entry's tone (`MAP[state]`); an outline entry draws
   * dashed. The line is decorative next to the state's text: say the state in `ariaLabel` or
   * beside the chart, never by colour alone.
   */
  status?: VizMarkSource;
  ariaLabel?: string;
  className?: string;
}

/** One plotted point in SVG coordinate space. */
export interface SparkPoint {
  x: number;
  y: number;
}

export interface SparkGeometryOpts {
  width: number;
  height: number;
  min?: number;
  max?: number;
}

/** Geometry split into finite runs. */
export interface SparkGeometry {
  /** Contiguous finite runs in timestamp order. */
  readonly runs: readonly (readonly SparkPoint[])[];
  /** SVG paths for runs of at least two points. */
  readonly paths: readonly string[];
  /** Point markers for isolated one-sample runs. */
  readonly markers: readonly SparkPoint[];
}

/** Plain values as samples at their index; a non-finite value becomes a gap. */
export function valuesToSamples(values: readonly number[]): SparklineSample[] {
  return values.map((value, at) => ({ at, value: Number.isFinite(value) ? value : null }));
}

/**
 * Timestamp-aware runs that never join across null or non-finite samples. y is inverted and
 * clamped to [0, height], so a value outside an explicit min/max stays on the chart's edge.
 */
export function sparklineGeometry(input: readonly SparklineSample[], opts: SparkGeometryOpts): SparkGeometry {
  const byTime = new Map<number, number | null>();
  for (const sample of input) {
    if (!Number.isFinite(sample.at)) continue;
    byTime.set(sample.at, sample.value !== null && Number.isFinite(sample.value) ? sample.value : null);
  }
  const samples = [...byTime].sort((a, b) => a[0] - b[0]);
  const finiteValues = samples.flatMap(([, value]) => (value === null ? [] : [value]));
  if (finiteValues.length === 0) return { runs: [], paths: [], markers: [] };

  const firstAt = samples[0]![0];
  const timeRange = samples[samples.length - 1]![0] - firstAt || 1;
  const domainMin = opts.min ?? Math.min(...finiteValues);
  const valueRange = (opts.max ?? Math.max(...finiteValues)) - domainMin || 1;
  const runs: SparkPoint[][] = [];
  let current: SparkPoint[] = [];
  for (const [at, value] of samples) {
    if (value === null) {
      if (current.length > 0) runs.push(current);
      current = [];
      continue;
    }
    current.push({
      x: round2(((at - firstAt) / timeRange) * opts.width),
      y: round2(clamp(opts.height - ((value - domainMin) / valueRange) * opts.height, 0, opts.height)),
    });
  }
  if (current.length > 0) runs.push(current);
  return {
    runs,
    paths: runs
      .filter((run) => run.length >= 2)
      .map((run) => run.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x},${point.y}`).join(" ")),
    markers: runs.filter((run) => run.length === 1).map((run) => run[0]!),
  };
}

export function Sparkline({
  values,
  samples,
  width = 120,
  height = 32,
  min,
  max,
  strokeWidth = 1.5,
  status,
  ariaLabel = "sparkline",
  className,
}: SparklineProps) {
  const mark = status !== undefined ? presentationMark(status) : null;
  const dash = mark !== null ? MARK_DASH[mark.pattern] : null;
  const geometry = sparklineGeometry(samples ?? valuesToSamples(values ?? []), {
    width,
    height,
    ...(min !== undefined ? { min } : {}),
    ...(max !== undefined ? { max } : {}),
  });
  const markerFill = dash !== null ? "fill-none" : mark !== null ? TONE_SVG_FILL[mark.tone] : "fill-muted-foreground";

  return (
    <svg
      data-slot="sparkline"
      data-tone={mark?.tone}
      data-mark={mark?.pattern}
      role="img"
      aria-label={ariaLabel}
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      className={cn(
        "overflow-visible",
        mark !== null ? TONE_SVG_STROKE[mark.tone] : "stroke-muted-foreground",
        className,
      )}
    >
      {geometry.paths.map((d, index) => (
        <path key={index} d={d} fill="none" strokeWidth={strokeWidth} strokeDasharray={dash?.join(" ")} />
      ))}
      {geometry.markers.map((point, index) => (
        <circle
          key={index}
          data-spark-point="single"
          cx={point.x}
          cy={point.y}
          r={Math.max(strokeWidth, 1.5)}
          strokeWidth={dash !== null ? 1 : 0}
          className={markerFill}
        />
      ))}
    </svg>
  );
}
