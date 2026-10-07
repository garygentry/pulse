// apps/web/src/client/views/overview/stats/format.ts — pure copy and estate-clock formatters for
// the stat header and the drawer/ribbon timestamps. Missing or unparseable instants format to null
// so callers render explicit unavailable copy instead of a fabricated time.

import type { DataAvailability } from "@pulse/web-data/wire";
import type { EstateClock } from "../../../format.js";

/** Visible copy for an aggregate that is missing or malformed. */
export const STAT_UNAVAILABLE_TEXT = "Unavailable";
/** Visible copy when a last-good instant is missing or unparseable. */
export const LAST_GOOD_UNAVAILABLE_TEXT = "Last good time unavailable";

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function countText(value: number): string {
  return isCount(value) ? String(value) : STAT_UNAVAILABLE_TEXT;
}

/** Estate-clock absolute time, or null when the instant is missing or unparseable. */
export function formatInstant(clock: EstateClock, iso: string | null): string | null {
  if (iso === null || !Number.isFinite(Date.parse(iso))) return null;
  const text = clock.format(iso);
  return text === "—" ? null : text;
}

/** "Last good <time>" in the estate clock, or the explicit unavailable copy. */
export function lastGoodLabel(clock: EstateClock, iso: string | null): string {
  const text = formatInstant(clock, iso);
  return text === null ? LAST_GOOD_UNAVAILABLE_TEXT : `Last good ${text}`;
}

export function epochIso(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms)) return null;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Qualifier for retained non-current evidence, e.g. "Stale — Last good …". */
export function evidenceQualifier(clock: EstateClock, availability: DataAvailability): string {
  const state = availability.state === "stale" ? "Stale" : "Not current";
  return `${state} — ${lastGoodLabel(clock, availability.lastGoodAt)}`;
}
