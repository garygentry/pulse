import { useId } from "react";
import type { StatusMap, Tone } from "@/ui/lib/status";
import { TONE_SVG_FILL, TONE_SVG_STROKE } from "@/ui/lib/tone";
import { cn } from "@/ui/lib/utils";
import { clamp, round2 } from "@/ui/viz/geometry";
import { statusMapMark, toneSeverity, type VizStatusMark } from "@/ui/viz/status-marks";

/**
 * One status interval within a lane, in the timeline's domain units (e.g. unix seconds). `S` is the
 * status vocabulary: any domain with a `defineStatusMap` map.
 */
export interface TimelineSegment<S extends string = string> {
  /** The segment's status, drawn with its `statusMap` entry's tone and pattern. */
  status: S;
  /** Interval start (inclusive). */
  start: number;
  /** Interval end (exclusive); must be ≥ `start`. Segments are clamped to the domain. */
  end: number;
}

/** One row: a labelled subject and its ordered status intervals. */
export interface TimelineLane<S extends string = string> {
  /** Stable identity (row key and `data-lane`). */
  id: string;
  /** The lane's accessible name. */
  label: string;
  /** Ordered, non-overlapping intervals. */
  segments: readonly TimelineSegment<S>[];
}

/**
 * Lanes of status intervals over a shared time domain. Segments are drawn from `statusMap` (the
 * entry's tone, hatched for an outline entry).
 */
export interface StatusTimelineProps<S extends string> {
  /** Rows, top → bottom. Empty renders an empty chart. */
  lanes: readonly TimelineLane<S>[];
  /** Start of the shared time domain (x = 0). */
  domainStart: number;
  /** End of the shared time domain (x = width); must be ≥ `domainStart`. */
  domainEnd: number;
  /**
   * Formats a domain time for the text alternative (e.g. a clock time), so assistive technology
   * never reads raw epoch numbers.
   */
  formatTime: (t: number) => string;
  /** SVG width in px. Default 320. */
  width?: number;
  /** Per-lane bar height in px. Default 16. */
  laneHeight?: number;
  /** Vertical gap between lanes in px. Default 2. */
  laneGap?: number;
  /** Accessible name of the chart. Default "status timeline". */
  ariaLabel?: string;
  /** The status vocabulary's presentation (a `defineStatusMap` map). */
  statusMap: StatusMap<S>;
  className?: string;
}

/** A resolved segment rectangle in SVG coordinate space. */
export interface TimelineRect {
  x: number;
  y: number;
  width: number;
  height: number;
  /** True when the interval was narrower than the minimum and was widened around its centre. */
  widened: boolean;
}

export interface TimelineLayoutOpts {
  domainStart: number;
  domainEnd: number;
  width: number;
  laneHeight: number;
  laneGap: number;
}

/** The narrowest a visible segment is drawn, in px, so a short outage never disappears. */
export const TIMELINE_MIN_SEGMENT_PX = 2;

/**
 * One segment's rect in lane `laneIndex`, clamped to the domain; null when the clamped interval
 * is empty (outside the domain or zero-length). A shorter interval is widened to
 * `TIMELINE_MIN_SEGMENT_PX` around its centre, kept inside the chart.
 */
export function timelineSegmentRect(
  seg: TimelineSegment<string>,
  laneIndex: number,
  opts: TimelineLayoutOpts,
): TimelineRect | null {
  const span = opts.domainEnd - opts.domainStart;
  if (!(span > 0)) return null;
  const start = clamp(seg.start, opts.domainStart, opts.domainEnd);
  const end = clamp(seg.end, opts.domainStart, opts.domainEnd);
  if (!(end > start)) return null;

  const x = ((start - opts.domainStart) / span) * opts.width;
  const w = ((end - start) / span) * opts.width;
  const shown = Math.min(Math.max(w, TIMELINE_MIN_SEGMENT_PX), opts.width);
  return {
    x: round2(clamp(x + (w - shown) / 2, 0, opts.width - shown)),
    y: round2(laneIndex * (opts.laneHeight + opts.laneGap)),
    width: round2(shown),
    height: opts.laneHeight,
    widened: w < TIMELINE_MIN_SEGMENT_PX,
  };
}

/** Total SVG height for `laneCount` lanes. */
export function timelineHeight(laneCount: number, laneHeight: number, laneGap: number): number {
  return laneCount * (laneHeight + laneGap);
}

export interface LaneItem {
  key: number;
  status: string;
  rect: TimelineRect;
  mark: VizStatusMark & { label: string };
  /** The interval clamped to the domain, for the text alternative. */
  start: number;
  end: number;
  /** Starts exactly where the previous visible segment ends. */
  adjoinsPrevious: boolean;
}

/** A lane's visible segments with their rects and marks, in order. */
function laneItems(lane: TimelineLane<string>, laneIndex: number, opts: TimelineLayoutOpts, map: StatusMap<string>): LaneItem[] {
  const items: LaneItem[] = [];
  lane.segments.forEach((seg, i) => {
    const rect = timelineSegmentRect(seg, laneIndex, opts);
    if (rect === null) return;
    const start = clamp(seg.start, opts.domainStart, opts.domainEnd);
    const previous = items[items.length - 1];
    items.push({
      key: i,
      status: seg.status,
      rect,
      mark: statusMapMark(map, seg.status),
      start,
      end: clamp(seg.end, opts.domainStart, opts.domainEnd),
      adjoinsPrevious: previous !== undefined && previous.end === start,
    });
  });
  return items;
}

/**
 * Widened (short) intervals whose drawn rects overlap or coincide, merged into one rect over their
 * union with the most severe mark, so a short non-ok interval is never painted over by a short ok
 * one (two short intervals near a domain edge can clamp to the same rect). The merged rect's
 * title lists every state it covers; the text alternative still lists each interval.
 */
export function mergeWidened(items: readonly LaneItem[]): LaneItem[] {
  const groups: { item: LaneItem; labels: string[] }[] = [];
  for (const item of [...items].sort((a, b) => a.rect.x - b.rect.x)) {
    const last = groups[groups.length - 1];
    if (last === undefined || item.rect.x >= last.item.rect.x + last.item.rect.width) {
      groups.push({ item, labels: [item.mark.label] });
      continue;
    }
    const { rect } = last.item;
    const right = Math.max(rect.x + rect.width, item.rect.x + item.rect.width);
    const worst = toneSeverity(item.mark.tone) > toneSeverity(last.item.mark.tone) ? item : last.item;
    if (!last.labels.includes(item.mark.label)) last.labels.push(item.mark.label);
    last.item = {
      ...worst,
      key: last.item.key,
      rect: { ...rect, width: round2(right - rect.x) },
      start: Math.min(last.item.start, item.start),
      end: Math.max(last.item.end, item.end),
    };
  }
  return groups.map(({ item, labels }) => ({ ...item, mark: { ...item.mark, label: labels.join(" / ") } }));
}

/**
 * A chart of status intervals: one lane per subject, one rectangle per interval, coloured by
 * the status map's tone (hatched in that tone for an outline entry). The drawing is hidden from
 * assistive technology; a visually hidden list carries the same reading as text (each lane, and
 * each interval's state label and time range), so it never depends on colour or hover.
 */
export function StatusTimeline<S extends string>({
  lanes,
  domainStart,
  domainEnd,
  formatTime,
  width = 320,
  laneHeight = 16,
  laneGap = 2,
  ariaLabel = "status timeline",
  className,
  statusMap,
}: StatusTimelineProps<S>) {
  const baseId = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const hatchId = (tone: Tone) => `status-timeline-hatch-${baseId}-${tone}`;
  const height = timelineHeight(lanes.length, laneHeight, laneGap);
  const opts: TimelineLayoutOpts = { domainStart, domainEnd, width, laneHeight, laneGap };
  const rows = lanes.map((lane, laneIndex) => ({ lane, items: laneItems(lane, laneIndex, opts, statusMap) }));
  const hatchedTones = [
    ...new Set(rows.flatMap(({ items }) => items.filter((it) => it.mark.pattern === "hatched").map((it) => it.mark.tone))),
  ];

  const segmentRect = (item: LaneItem) => {
    const hatched = item.mark.pattern === "hatched";
    return (
      <rect
        key={item.key}
        data-status={item.status}
        data-tone={item.mark.tone}
        data-mark={item.mark.pattern}
        x={item.rect.x}
        y={item.rect.y}
        width={item.rect.width}
        height={item.rect.height}
        fill={hatched ? `url(#${hatchId(item.mark.tone)})` : undefined}
        strokeWidth={hatched ? 1 : undefined}
        className={hatched ? TONE_SVG_STROKE[item.mark.tone] : TONE_SVG_FILL[item.mark.tone]}
      >
        <title>{item.mark.label}</title>
      </rect>
    );
  };

  return (
    <div data-slot="status-timeline" role="group" aria-label={ariaLabel} className={cn("w-fit", className)}>
      <svg aria-hidden="true" viewBox={`0 0 ${width} ${height}`} width={width} height={height} className="block">
        {hatchedTones.length > 0 ? (
          <defs>
            {hatchedTones.map((tone) => (
              <pattern
                key={tone}
                id={hatchId(tone)}
                data-tone={tone}
                width={4}
                height={4}
                patternUnits="userSpaceOnUse"
                patternTransform="rotate(45)"
              >
                <rect width={4} height={4} className="fill-background" />
                <line x1={0} y1={0} x2={0} y2={4} strokeWidth={3} className={TONE_SVG_STROKE[tone]} />
              </pattern>
            ))}
          </defs>
        ) : null}
        {rows.map(({ lane, items }) => (
          <g key={lane.id} data-lane={lane.id}>
            {items.filter((it) => !it.rect.widened).map(segmentRect)}
            {items
              .filter((it, i) => it.adjoinsPrevious && !it.rect.widened && !items[i - 1]!.rect.widened)
              .map((it) => (
                <line
                  key={`sep-${it.key}`}
                  data-separator=""
                  x1={it.rect.x}
                  x2={it.rect.x}
                  y1={it.rect.y}
                  y2={it.rect.y + it.rect.height}
                  strokeWidth={1}
                  className="stroke-background"
                />
              ))}
            {/* Widened (short) intervals last, so a neighbour never covers them. */}
            {mergeWidened(items.filter((it) => it.rect.widened)).map(segmentRect)}
          </g>
        ))}
      </svg>
      <ul data-slot="status-timeline-text" className="sr-only">
        {rows.map(({ lane, items }, laneIndex) => (
          <li key={lane.id}>
            <span id={`${baseId}-lane-${laneIndex}`}>{lane.label}</span>
            <ul aria-labelledby={`${baseId}-lane-${laneIndex}`}>
              {items.length === 0 ? <li>No intervals</li> : null}
              {items.map((it) => (
                <li key={it.key}>
                  {`${it.mark.label}, ${formatTime(it.start)} to ${formatTime(it.end)}`}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </div>
  );
}
