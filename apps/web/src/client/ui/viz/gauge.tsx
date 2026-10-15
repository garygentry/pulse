import type { StatusPresentation } from "@/ui/lib/status";
import { TONE_SVG_STROKE } from "@/ui/lib/tone";
import { cn } from "@/ui/lib/utils";
import { clamp, round2 } from "@/ui/viz/geometry";
import { MARK_DASH, presentationMark, type VizMarkSource } from "@/ui/viz/status-marks";

/** A single-value 270° radial gauge, exposed as a `meter`. */
export interface GaugeProps {
  /** Names what is measured (the meter's accessible name), e.g. "Disk usage". */
  ariaLabel: string;
  /** Current value; clamped to [min, max] for the arc. A non-finite value shows as unavailable. */
  value: number;
  /** Domain lower bound. Default 0. */
  min?: number;
  /** Domain upper bound. Default 100. A bound ≤ `min` is a degenerate domain: no arc. */
  max?: number;
  /**
   * A status-map entry (`MAP[state]`): tints the value arc with its tone (dashed for an outline
   * entry) and shows its label under the value, so the reading never depends on colour.
   */
  status?: VizMarkSource & Pick<StatusPresentation, "label">;
  /** Square size in px. Default 96. */
  size?: number;
  /** Arc thickness in px. Default 8. */
  thickness?: number;
  /** Centre label. Default: the rounded value. */
  label?: string;
  className?: string;
}

/** The gauge sweeps 270°, from 135° (bottom-left) over the top to 405° (bottom-right). */
export const GAUGE_START_ANGLE = 135;
export const GAUGE_SWEEP = 270;

/** Shown in place of the value when it is not a finite number. */
export const GAUGE_UNAVAILABLE = "–";

/** Point on a circle; `angleDeg` clockwise from +x, SVG y-down. */
export function polarToCartesian(
  cx: number,
  cy: number,
  r: number,
  angleDeg: number,
): { x: number; y: number } {
  const rad = (angleDeg * Math.PI) / 180;
  return { x: round2(cx + r * Math.cos(rad)), y: round2(cy + r * Math.sin(rad)) };
}

/** Clockwise SVG arc path from `startAngle` to `endAngle` (degrees). */
export function arcPath(
  cx: number,
  cy: number,
  r: number,
  startAngle: number,
  endAngle: number,
): string {
  const start = polarToCartesian(cx, cy, r, startAngle);
  const end = polarToCartesian(cx, cy, r, endAngle);
  const largeArcFlag = endAngle - startAngle > 180 ? 1 : 0;
  return `M ${start.x},${start.y} A ${r} ${r} 0 ${largeArcFlag} 1 ${end.x},${end.y}`;
}

/** The filled share of the sweep, in [0, 1]; 0 for a degenerate domain (max ≤ min). */
export function gaugeFraction(value: number, min: number, max: number): number {
  if (!(max > min)) return 0;
  return clamp((value - min) / (max - min), 0, 1);
}

/** The value arc's end angle; a degenerate domain (max ≤ min) yields the start angle. */
export function gaugeValueAngle(value: number, min: number, max: number): number {
  return GAUGE_START_ANGLE + gaugeFraction(value, min, max) * GAUGE_SWEEP;
}

/**
 * `aria-valuetext`: the shown value ("unavailable" for a non-finite one), the status label, and
 * a note when the arc is clamped, so a reading over the maximum is not announced as in range. A
 * degenerate domain (max ≤ min) has no range to be outside of, so it gets no note.
 */
function gaugeValueText(text: string, value: number, min: number, max: number, statusLabel?: string): string {
  if (!Number.isFinite(value)) return statusLabel !== undefined ? `unavailable, ${statusLabel}` : "unavailable";
  const parts = statusLabel !== undefined ? [text, statusLabel] : [text];
  if (max > min && value > max) parts.push(`above the maximum of ${max}`);
  else if (max > min && value < min) parts.push(`below the minimum of ${min}`);
  return parts.join(", ");
}

export function Gauge({
  ariaLabel,
  value,
  min = 0,
  max = 100,
  status,
  size = 96,
  thickness = 8,
  label,
  className,
}: GaugeProps) {
  const available = Number.isFinite(value);
  // max ≤ min: no arc, and ARIA reports the single point `min` (never valuemin > valuemax).
  const degenerate = !(max > min);
  const text = !available ? GAUGE_UNAVAILABLE : (label ?? String(Math.round(value)));
  const mark = status !== undefined ? presentationMark(status) : null;
  const dash = mark !== null ? MARK_DASH[mark.pattern] : null;
  const fraction = available ? gaugeFraction(value, min, max) : 0;

  const cx = size / 2;
  const cy = size / 2;
  const r = (size - thickness) / 2;
  const trackPath = arcPath(cx, cy, r, GAUGE_START_ANGLE, GAUGE_START_ANGLE + GAUGE_SWEEP);

  return (
    <svg
      data-slot="gauge"
      role="meter"
      aria-label={ariaLabel}
      aria-valuemin={min}
      aria-valuemax={degenerate ? min : max}
      aria-valuenow={available && !degenerate ? clamp(value, min, max) : min}
      aria-valuetext={gaugeValueText(text, value, min, max, status?.label)}
      viewBox={`0 0 ${size} ${size}`}
      width={size}
      height={size}
      className={cn("overflow-visible", className)}
    >
      <path
        data-slot="gauge-track"
        d={trackPath}
        fill="none"
        strokeWidth={thickness}
        strokeLinecap="round"
        className="stroke-muted"
      />
      {fraction > 0 ? (
        <path
          data-slot="gauge-value"
          data-tone={mark?.tone}
          data-mark={mark?.pattern}
          d={arcPath(cx, cy, r, GAUGE_START_ANGLE, GAUGE_START_ANGLE + fraction * GAUGE_SWEEP)}
          fill="none"
          strokeWidth={thickness}
          strokeLinecap={dash !== null ? "butt" : "round"}
          strokeDasharray={dash?.join(" ")}
          className={mark !== null ? TONE_SVG_STROKE[mark.tone] : "stroke-foreground"}
        />
      ) : null}
      <text
        data-slot="gauge-label"
        x={cx}
        y={status !== undefined ? cy - 6 : cy}
        textAnchor="middle"
        dominantBaseline="middle"
        className="fill-foreground text-sm tabular-nums"
      >
        {text}
      </text>
      {status !== undefined ? (
        <text
          data-slot="gauge-status"
          x={cx}
          y={cy + 10}
          textAnchor="middle"
          dominantBaseline="middle"
          className="fill-muted-foreground text-[10px]"
        >
          {status.label}
        </text>
      ) : null}
    </svg>
  );
}
