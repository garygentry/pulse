// View-owned SVG marks over one StatusTimeline (07 §6; tech-spec §3.5/§3.6, REQ-LANE-04,
// REQ-SWIM-02/03). The unmodified StatusTimeline draws only fills; every outline, badge and
// highlight comes from this aria-hidden layer with the same width, height and viewBox. Geometry comes
// only from StatusTimeline's timelineSegmentRect; colours come from token classes and dash patterns
// from the constants below. Text elsewhere carries every meaning (REQ-A11Y-01).
import type { ReactElement } from "react";
import { timelineHeight, timelineSegmentRect, type TimelineLayoutOpts, type TimelineRect, type TimelineSegment } from "@/ui";

/** One view-owned mark. Lane indexes are 0-based within the StatusTimeline it overlays. */
export type DecorationMark =
  | { /** Dashed lane outline: partial evidence (REQ-LANE-04). */ readonly kind: "partial-lane"; /** Lane index. */ readonly lane: number }
  | { /** Solid strong lane outline: the selected lane. */ readonly kind: "selected-lane"; /** Lane index. */ readonly lane: number }
  | {
      /** Dashed interval outline: unmatched alert interval (REQ-SWIM-03). */ readonly kind: "unmatched-interval";
      /** Sub-lane index. */ readonly lane: number;
      /** Interval start, epoch seconds. */ readonly start: number;
      /** Interval end (exclusive), epoch seconds. */ readonly end: number;
    }
  | {
      /** Keyboard-active swimlane interval (07 §7.5). */ readonly kind: "active-interval";
      /** Sub-lane index. */ readonly lane: number;
      /** Interval start, epoch seconds. */ readonly start: number;
      /** Interval end (exclusive), epoch seconds. */ readonly end: number;
    }
  | {
      /** "+k" badge on the 4th (overflow) sub-lane (REQ-SWIM-02). */ readonly kind: "overflow-badge";
      /** Sub-lane index (MAX_SUBLANES − 1). */ readonly lane: number;
      /** Number of folded overlapping intervals (SubLane.overflow). */ readonly count: number;
    };

/** Props for LaneDecorations: the exact layout of the StatusTimeline beneath. */
export interface LaneDecorationsProps {
  /** Marks to draw. */ readonly marks: readonly DecorationMark[];
  /** Number of lanes in the StatusTimeline beneath (sets the height). */ readonly laneCount: number;
  /** Same domainStart as the StatusTimeline (the visible window start). */ readonly domainStart: number;
  /** Same domainEnd as the StatusTimeline. */ readonly domainEnd: number;
  /** Same width. */ readonly width: number;
  /** Same laneHeight. */ readonly laneHeight: number;
  /** Same laneGap. */ readonly laneGap: number;
}

/** Outline inset, SVG px on every side, so a 1px stroke stays inside the lane box. */
const INSET = 0.5;
/** Overflow badge background width, in lane heights (fits "+99" at the lane's font size). */
const BADGE_WIDTH_LANES = 2;

/** Dash pattern (SVG px) for partial-evidence lane outlines. */
export const PARTIAL_DASH = "4 4";
/** Dash pattern (SVG px) for unmatched alert-interval outlines. */
export const UNMATCHED_DASH = "6 4";

/** Per-outline hook, token classes and dash pattern. */
const OUTLINE = {
  "partial-lane": { deco: "partial", className: "fill-none stroke-border stroke-1", dash: PARTIAL_DASH },
  "selected-lane": { deco: "selected", className: "fill-none stroke-foreground stroke-1", dash: undefined },
  "unmatched-interval": { deco: "unmatched", className: "fill-none stroke-foreground stroke-1", dash: UNMATCHED_DASH },
  "active-interval": { deco: "active", className: "fill-none stroke-foreground stroke-0 outline outline-foreground", dash: undefined },
} as const;

function inset(r: TimelineRect): TimelineRect {
  return {
    x: r.x + INSET,
    y: r.y + INSET,
    width: Math.max(0, r.width - 2 * INSET),
    height: Math.max(0, r.height - 2 * INSET),
  };
}

/**
 * aria-hidden SVG over one StatusTimeline. Text elsewhere carries every meaning (lane label,
 * tooltip, readout); these marks are the non-colour visual reinforcement (REQ-A11Y-01).
 * Returns null when there are no marks.
 */
export function LaneDecorations(props: LaneDecorationsProps): ReactElement | null {
  if (props.marks.length === 0) return null;
  const { width, laneHeight, laneGap, domainStart, domainEnd } = props;
  const height = timelineHeight(props.laneCount, laneHeight, laneGap);
  const opts: TimelineLayoutOpts = { domainStart, domainEnd, width, laneHeight, laneGap };
  const wholeLane: TimelineSegment = { status: "unknown", start: domainStart, end: domainEnd };

  const children = props.marks.map((mark, i): ReactElement | null => {
    const seg: TimelineSegment =
      mark.kind === "unmatched-interval" || mark.kind === "active-interval"
        ? { status: "unknown", start: mark.start, end: mark.end }
        : wholeLane;
    const raw = timelineSegmentRect(seg, mark.lane, opts);
    if (raw === null) return null;
    const r = inset(raw);
    if (mark.kind === "overflow-badge") {
      // A right-aligned background box sized to the lane height.
      const bgWidth = Math.min(r.width, BADGE_WIDTH_LANES * laneHeight);
      return (
        <g key={i} data-mark={mark.kind} data-deco="badge">
          <rect
            data-slot="lane-deco-badge-bg"
            className="fill-muted stroke-border stroke-1"
            vectorEffect="non-scaling-stroke"
            x={r.x + r.width - bgWidth}
            y={r.y}
            width={bgWidth}
            height={r.height}
          />
          <text
            data-slot="lane-deco-badge-text"
            className="fill-foreground text-xs font-bold"
            x={width - 2}
            y={raw.y + raw.height / 2}
            textAnchor="end"
            dominantBaseline="central"
          >
            {`+${mark.count}`}
          </text>
        </g>
      );
    }
    const outline = OUTLINE[mark.kind];
    return (
      <rect
        key={i}
        data-mark={mark.kind}
        data-deco={outline.deco}
        className={outline.className}
        vectorEffect="non-scaling-stroke"
        strokeDasharray={outline.dash}
        x={r.x}
        y={r.y}
        width={r.width}
        height={r.height}
        fill="none"
      />
    );
  });

  return (
    <svg
      data-slot="lane-decorations"
      className="pointer-events-none absolute inset-0 block max-w-none overflow-visible"
      aria-hidden="true"
      focusable="false"
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
    >
      {children}
    </svg>
  );
}
