import type { TargetStatus } from "@pulse/web-data/wire";
import type { StatusPresentation, Tone } from "@/ui/lib/status";
import { TARGET_STATUS } from "@/ui/status/target-status";

/**
 * How a mark is drawn, on top of its tone. Suppressed and unknown share the neutral
 * tone, so suppressed gets its own shape (hatched area, dashed line) instead of a
 * second neutral shade that disappears into the page.
 */
export type VizMarkPattern = "solid" | "hatched";

export interface VizStatusMark {
  tone: Tone;
  pattern: VizMarkPattern;
}

/**
 * The mark for any status-map entry: its tone, hatched/dashed when the entry is an outline badge
 * (suppressed in `TARGET_STATUS` and `ALERT_STATE`), solid otherwise.
 */
export function presentationMark(presentation: StatusPresentation): VizStatusMark {
  return { tone: presentation.tone, pattern: presentation.variant === "outline" ? "hatched" : "solid" };
}

/** A status's mark: the tone from `TARGET_STATUS`, hatched/dashed for suppressed. */
export function vizStatusMark(status: TargetStatus): VizStatusMark {
  return presentationMark(TARGET_STATUS[status]);
}

/** Line dash for a pattern (SVG `stroke-dasharray` and uPlot `dash`). */
export const MARK_DASH: Readonly<Record<VizMarkPattern, readonly number[] | null>> = {
  solid: null,
  hatched: [4, 3],
};

/** Tone utility classes, spelled out so Tailwind's source scan finds every one. */
export const TONE_FILL: Readonly<Record<Tone, string>> = {
  ok: "fill-status-ok-fg",
  warn: "fill-status-warn-fg",
  danger: "fill-status-danger-fg",
  info: "fill-status-info-fg",
  pending: "fill-status-pending-fg",
  neutral: "fill-status-neutral-fg",
};

export const TONE_STROKE: Readonly<Record<Tone, string>> = {
  ok: "stroke-status-ok-fg",
  warn: "stroke-status-warn-fg",
  danger: "stroke-status-danger-fg",
  info: "stroke-status-info-fg",
  pending: "stroke-status-pending-fg",
  neutral: "stroke-status-neutral-fg",
};

/** The CSS custom property holding a tone's foreground colour (for canvas reads). */
export function toneFgVar(tone: Tone): string {
  return `--status-${tone}-fg`;
}
