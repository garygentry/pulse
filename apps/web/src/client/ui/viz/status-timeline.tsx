import { useId } from "react";
import type { TargetStatus } from "@pulse/web-data/wire";
import type { StatusMap } from "@/ui/lib/status";
import { cn } from "@/ui/lib/utils";
import { TARGET_STATUS } from "@/ui/status/target-status";
import { TONE_FILL, TONE_STROKE, presentationMark } from "@/ui/viz/status-marks";

/**
 * One status interval within a lane, in the timeline's domain units (e.g. unix seconds). `S` is the
 * status vocabulary: `TargetStatus` by default, or any domain with a status map (an alert severity).
 */
export interface TimelineSegment<S extends string = TargetStatus> {
  /** The segment's status, drawn with its `statusMap` entry's tone and pattern. */
  status: S;
  /** Interval start (inclusive). */
  start: number;
  /** Interval end (exclusive); must be ≥ `start`. Segments are clamped to the domain. */
  end: number;
}

/** One row: a labelled subject and its ordered status intervals. */
export interface TimelineLane<S extends string = TargetStatus> {
  /** Stable identity (row key and `data-lane`). */
  id: string;
  /** The lane's accessible name. */
  label: string;
  /** Ordered, non-overlapping intervals. */
  segments: readonly TimelineSegment<S>[];
}

/** Lanes of status intervals over a shared time domain. */
interface StatusTimelineBaseProps<S extends string> {
  /** Rows, top → bottom. Empty renders an empty chart. */
  lanes: readonly TimelineLane<S>[];
  /** Start of the shared time domain (x = 0). */
  domainStart: number;
  /** End of the shared time domain (x = width); must be ≥ `domainStart`. */
  domainEnd: number;
  /** SVG width in px. Default 320. */
  width?: number;
  /** Per-lane bar height in px. Default 16. */
  laneHeight?: number;
  /** Vertical gap between lanes in px. Default 2. */
  laneGap?: number;
  /** Accessible label. Default "status timeline". */
  ariaLabel?: string;
  className?: string;
}

/**
 * StatusTimeline props. Segments are drawn from `statusMap` (tone, and hatching for an outline
 * entry). It defaults to `TARGET_STATUS` and is required for any other status vocabulary, so a
 * domain such as alert severity passes its own statuses and map (`ALERT_SEVERITY`) instead of
 * squeezing into a target status with a tone override.
 */
export type StatusTimelineProps<S extends string = TargetStatus> = StatusTimelineBaseProps<S> &
  ([S] extends [TargetStatus] ? { statusMap?: StatusMap<S> } : { statusMap: StatusMap<S> });

/** A resolved segment rectangle in SVG coordinate space. */
export interface TimelineRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TimelineLayoutOpts {
  domainStart: number;
  domainEnd: number;
  width: number;
  laneHeight: number;
  laneGap: number;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * One segment's rect in lane `laneIndex`, clamped to the domain; null when the
 * clamped width is ≤ 0 (outside the domain or zero-length).
 */
export function timelineSegmentRect(
  seg: TimelineSegment<string>,
  laneIndex: number,
  opts: TimelineLayoutOpts,
): TimelineRect | null {
  const span = opts.domainEnd - opts.domainStart || 1;
  const clampedStart = Math.max(opts.domainStart, Math.min(seg.start, opts.domainEnd));
  const clampedEnd = Math.max(opts.domainStart, Math.min(seg.end, opts.domainEnd));
  const w = ((clampedEnd - clampedStart) / span) * opts.width;
  if (w <= 0) return null;

  return {
    x: round2(((clampedStart - opts.domainStart) / span) * opts.width),
    y: round2(laneIndex * (opts.laneHeight + opts.laneGap)),
    width: round2(w),
    height: opts.laneHeight,
  };
}

/** Total SVG height for `laneCount` lanes. */
export function timelineHeight(laneCount: number, laneHeight: number, laneGap: number): number {
  return laneCount * (laneHeight + laneGap);
}

export function StatusTimeline<S extends string = TargetStatus>({
  lanes,
  domainStart,
  domainEnd,
  width = 320,
  laneHeight = 16,
  laneGap = 2,
  ariaLabel = "status timeline",
  className,
  statusMap,
}: StatusTimelineProps<S>) {
  // Without a map S is TargetStatus (the props type requires a map otherwise).
  const map = statusMap ?? (TARGET_STATUS as unknown as StatusMap<S>);
  const hatchId = `status-timeline-hatch-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const height = timelineHeight(lanes.length, laneHeight, laneGap);
  const opts: TimelineLayoutOpts = { domainStart, domainEnd, width, laneHeight, laneGap };
  const hasHatched = lanes.some((lane) =>
    lane.segments.some((seg) => presentationMark(map[seg.status]).pattern === "hatched"),
  );

  return (
    <svg
      data-slot="status-timeline"
      role="img"
      aria-label={ariaLabel}
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      className={cn("stroke-background", className)}
    >
      {hasHatched ? (
        <defs>
          <pattern
            id={hatchId}
            width={4}
            height={4}
            patternUnits="userSpaceOnUse"
            patternTransform="rotate(45)"
          >
            <rect width={4} height={4} className="fill-background stroke-none" />
            <line x1={0} y1={0} x2={0} y2={4} strokeWidth={3} className={TONE_STROKE.neutral} />
          </pattern>
        </defs>
      ) : null}
      {lanes.map((lane, laneIndex) => (
        <g key={lane.id} data-lane={lane.id} role="group" aria-label={lane.label}>
          {lane.segments.map((seg, i) => {
            const rect = timelineSegmentRect(seg, laneIndex, opts);
            if (rect === null) return null;
            const mark = presentationMark(map[seg.status]);
            const hatched = mark.pattern === "hatched";
            return (
              <rect
                key={i}
                data-status={seg.status}
                data-tone={mark.tone}
                data-mark={mark.pattern}
                x={rect.x}
                y={rect.y}
                width={rect.width}
                height={rect.height}
                fill={hatched ? `url(#${hatchId})` : undefined}
                strokeWidth={1}
                className={hatched ? TONE_STROKE[mark.tone] : TONE_FILL[mark.tone]}
              />
            );
          })}
        </g>
      ))}
    </svg>
  );
}
