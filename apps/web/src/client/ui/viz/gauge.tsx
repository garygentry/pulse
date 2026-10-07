import type { TargetStatus } from "@pulse/web-data/wire";
import { cn } from "@/ui/lib/utils";
import { TARGET_STATUS } from "@/ui/status/target-status";
import { MARK_DASH, TONE_STROKE, vizStatusMark } from "@/ui/viz/status-marks";
import { STATUS_GLYPH } from "../../../shared/constants.js";

/** A single-value 270° radial gauge. */
export interface GaugeProps {
  /** Current value; clamped to [min, max] for the arc. */
  value: number;
  /** Domain lower bound. Default 0. */
  min?: number;
  /** Domain upper bound. Default 100. */
  max?: number;
  /** Tints the value arc with the status tone, sets `data-status`, and prefixes the label
   *  with the status glyph so the reading never depends on colour. */
  status?: TargetStatus;
  /** Square size in px. Default 96. */
  size?: number;
  /** Arc thickness in px. Default 8. */
  thickness?: number;
  /** Centre label. Default: the rounded value. */
  label?: string;
  /** Accessible label. Default: `label ?? value`, followed by the status label when `status` is set. */
  ariaLabel?: string;
  className?: string;
}

/** The gauge sweeps 270°, from 135° (bottom-left) over the top to 405° (bottom-right). */
export const GAUGE_START_ANGLE = 135;
export const GAUGE_SWEEP = 270;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

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

/** The value arc's end angle; a degenerate domain (max === min) yields the start angle. */
export function gaugeValueAngle(value: number, min: number, max: number): number {
  const fraction = Math.max(0, Math.min((value - min) / (max - min || 1), 1));
  return GAUGE_START_ANGLE + fraction * GAUGE_SWEEP;
}

export function Gauge({
  value,
  min = 0,
  max = 100,
  status,
  size = 96,
  thickness = 8,
  label,
  ariaLabel,
  className,
}: GaugeProps) {
  const text = label ?? String(Math.round(value));
  const mark = status !== undefined ? vizStatusMark(status) : null;
  const dash = mark !== null ? MARK_DASH[mark.pattern] : null;

  const cx = size / 2;
  const cy = size / 2;
  const r = (size - thickness) / 2;
  const trackPath = arcPath(cx, cy, r, GAUGE_START_ANGLE, GAUGE_START_ANGLE + GAUGE_SWEEP);
  const valuePath = arcPath(cx, cy, r, GAUGE_START_ANGLE, gaugeValueAngle(value, min, max));

  return (
    <svg
      data-slot="gauge"
      data-status={status}
      role="img"
      aria-label={ariaLabel ?? (status !== undefined ? `${label ?? value}, ${TARGET_STATUS[status].label}` : String(label ?? value))}
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
      <path
        data-slot="gauge-value"
        data-tone={mark?.tone}
        data-mark={mark?.pattern}
        d={valuePath}
        fill="none"
        strokeWidth={thickness}
        strokeLinecap={dash !== null ? "butt" : "round"}
        strokeDasharray={dash?.join(" ")}
        className={mark !== null ? TONE_STROKE[mark.tone] : "stroke-foreground"}
      />
      <text
        data-slot="gauge-label"
        x={cx}
        y={cy}
        textAnchor="middle"
        dominantBaseline="middle"
        className="fill-foreground text-sm tabular-nums"
      >
        {status !== undefined ? `${STATUS_GLYPH[status]} ${text}` : text}
      </text>
    </svg>
  );
}
