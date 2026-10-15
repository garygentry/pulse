import type { StatusMap, StatusPresentation, Tone } from "@/ui/lib/status";

/**
 * How a mark is drawn, on top of its tone. Two states can share a tone (e.g. suppressed and
 * unknown, both neutral), so the one shown as an outline badge gets its own shape (a hatched
 * area, a dashed line) instead of a second shade of the same tone.
 */
export type VizMarkPattern = "solid" | "hatched";

export interface VizStatusMark {
  tone: Tone;
  pattern: VizMarkPattern;
}

/** What a mark is drawn from: a status-map entry, or just a tone (and badge variant). */
export type VizMarkSource = Pick<StatusPresentation, "tone" | "variant">;

/**
 * The mark for a status-map entry: its tone, hatched/dashed when the entry is shown as an
 * outline badge, solid otherwise.
 */
export function presentationMark(source: VizMarkSource): VizStatusMark {
  return { tone: source.tone, pattern: source.variant === "outline" ? "hatched" : "solid" };
}

/**
 * The mark and label for `status` in `map`. A status the map does not cover (a retired state in
 * old history) falls back to a solid neutral mark labelled with the raw status, never a throw.
 */
export function statusMapMark(map: StatusMap<string>, status: string): VizStatusMark & { label: string } {
  const entry = Object.hasOwn(map, status) ? map[status] : undefined;
  return entry !== undefined
    ? { ...presentationMark(entry), label: entry.label }
    : { tone: "neutral", pattern: "solid", label: status };
}

/** Line dash for a pattern (SVG `stroke-dasharray`). */
export const MARK_DASH: Readonly<Record<VizMarkPattern, readonly number[] | null>> = {
  solid: null,
  hatched: [4, 3],
};

/** Tones from least to most severe: where marks collide, the most severe one is drawn. */
const TONE_SEVERITY: readonly Tone[] = ["ok", "neutral", "info", "pending", "warn", "danger"];

/** A tone's rank in `TONE_SEVERITY` (higher is more severe). */
export function toneSeverity(tone: Tone): number {
  return TONE_SEVERITY.indexOf(tone);
}
