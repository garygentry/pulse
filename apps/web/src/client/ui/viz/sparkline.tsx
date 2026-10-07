import type { TargetStatus } from "@pulse/web-data/wire";
import { cn } from "@/ui/lib/utils";
import { MARK_DASH, TONE_FILL, TONE_STROKE, vizStatusMark } from "@/ui/viz/status-marks";

/** One timestamped sample. A null value is an explicit gap and is never bridged. */
export interface SparklineSample {
  readonly at: number;
  readonly value: number | null;
}

/** A compact, dependency-free SVG trend line, coloured by status tone. */
export interface SparklineProps {
  /** Values ordered oldest → newest. Do not combine with `samples`. */
  values?: readonly number[];
  /** Timestamped input with explicit gaps. Do not combine with `values`. */
  samples?: readonly SparklineSample[];
  width?: number;
  height?: number;
  min?: number;
  max?: number;
  strokeWidth?: number;
  /** Colours the line with the status tone; suppressed draws dashed. */
  status?: TargetStatus;
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

/** Geometry for timestamped samples, split into finite runs. */
export interface SparkSampleGeometry {
  /** Contiguous finite runs in timestamp order. */
  readonly runs: readonly (readonly SparkPoint[])[];
  /** SVG paths for runs of at least two points. */
  readonly paths: readonly string[];
  /** Point markers for isolated one-sample runs. */
  readonly markers: readonly SparkPoint[];
  /** The point when the whole input has exactly one finite sample. */
  readonly singlePoint: SparkPoint | null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Geometry for plain values: evenly spaced, y inverted; null below two finite points. */
export function sparklineGeometry(
  values: readonly number[],
  opts: SparkGeometryOpts,
): { points: readonly SparkPoint[]; path: string } | null {
  const finite = values.filter((v) => Number.isFinite(v));
  const n = finite.length;
  if (n < 2) return null;
  const domainMin = opts.min ?? Math.min(...finite);
  const domainMax = opts.max ?? Math.max(...finite);
  const range = domainMax - domainMin || 1;
  const points: SparkPoint[] = finite.map((v, i) => ({
    x: round2((i / (n - 1)) * opts.width),
    y: round2(opts.height - ((v - domainMin) / range) * opts.height),
  }));
  return {
    points,
    path: points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x},${p.y}`).join(" "),
  };
}

/** Timestamp-aware runs that never join across null or non-finite samples. */
export function sparklineSampleGeometry(
  input: readonly SparklineSample[],
  opts: SparkGeometryOpts,
): SparkSampleGeometry {
  const byTime = new Map<number, number | null>();
  for (const sample of input) {
    if (!Number.isFinite(sample.at)) continue;
    byTime.set(
      sample.at,
      sample.value !== null && Number.isFinite(sample.value) ? sample.value : null,
    );
  }
  const samples = [...byTime].sort((a, b) => a[0] - b[0]);
  const finiteValues = samples.flatMap(([, value]) => (value === null ? [] : [value]));
  if (samples.length === 0 || finiteValues.length === 0) {
    return { runs: [], paths: [], markers: [], singlePoint: null };
  }

  const firstAt = samples[0]![0];
  const lastAt = samples[samples.length - 1]![0];
  const timeRange = lastAt - firstAt || 1;
  const domainMin = opts.min ?? Math.min(...finiteValues);
  const domainMax = opts.max ?? Math.max(...finiteValues);
  const valueRange = domainMax - domainMin || 1;
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
      y: round2(opts.height - ((value - domainMin) / valueRange) * opts.height),
    });
  }
  if (current.length > 0) runs.push(current);
  const points = runs.flat();
  return {
    runs,
    paths: runs
      .filter((run) => run.length >= 2)
      .map((run) =>
        run.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x},${point.y}`).join(" "),
      ),
    markers: runs.filter((run) => run.length === 1).map((run) => run[0]!),
    singlePoint: points.length === 1 ? points[0]! : null,
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
  const mark = status !== undefined ? vizStatusMark(status) : null;
  const dash = mark !== null ? MARK_DASH[mark.pattern] : null;
  const opts: SparkGeometryOpts = {
    width,
    height,
    ...(min !== undefined ? { min } : {}),
    ...(max !== undefined ? { max } : {}),
  };
  const sampled = samples !== undefined ? sparklineSampleGeometry(samples, opts) : null;
  const plain = sampled === null ? sparklineGeometry(values ?? [], opts) : null;
  const paths = sampled !== null ? sampled.paths : plain !== null ? [plain.path] : [];

  return (
    <svg
      data-slot="sparkline"
      data-status={status}
      data-tone={mark?.tone}
      data-mark={mark?.pattern}
      role="img"
      aria-label={ariaLabel}
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      className={cn(
        "overflow-visible",
        mark !== null ? TONE_STROKE[mark.tone] : "stroke-muted-foreground",
        className,
      )}
    >
      {paths.map((d, index) => (
        <path
          key={index}
          d={d}
          fill="none"
          strokeWidth={strokeWidth}
          strokeDasharray={dash?.join(" ")}
        />
      ))}
      {sampled?.markers.map((point, index) => (
        <circle
          key={index}
          data-spark-point="single"
          cx={point.x}
          cy={point.y}
          r={Math.max(strokeWidth, 1.5)}
          strokeWidth={dash !== null ? 1 : 0}
          className={
            dash !== null
              ? "fill-none"
              : mark !== null
                ? TONE_FILL[mark.tone]
                : "fill-muted-foreground"
          }
        />
      ))}
    </svg>
  );
}
