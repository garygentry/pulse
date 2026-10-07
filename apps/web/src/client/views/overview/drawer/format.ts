// apps/web/src/client/views/overview/drawer/format.ts — pure copy and value formatters for the
// drawer's live-signal rows. A null (or non-finite) value formats to null so the row renders
// "Unavailable" — never 0 or false.

import type { DataAvailability, LiveSignal, Unit } from "@pulse/web-data/wire";
import type { EstateClock } from "../../../format.js";
import { formatInstant } from "../stats/format.js";

/** Visible value copy for a signal without a validated value. */
export const SIGNAL_UNAVAILABLE_TEXT = "Unavailable";
/** Copy for evidence that has never succeeded. */
export const NO_SUCCESSFUL_OBSERVATION_TEXT = "No successful observation.";
/** Empty-section copy. */
export const NO_SIGNALS_TEXT = "No live signals attributed to this target.";

/** Human label for each availability state. */
export const AVAILABILITY_LABEL: Readonly<Record<DataAvailability["state"], string>> = {
  current: "Current",
  stale: "Stale",
  unavailable: "Unavailable",
  "not-configured": "Not configured",
};

/** Displayed unit suffix; empty for dimensionless units (no inferred conversion). */
export const UNIT_SUFFIX: Readonly<Record<Unit, string>> = {
  state: "",
  percent: "%",
  count: "count",
  seconds: "s",
  milliseconds: "ms",
  bytes: "bytes",
  scalar: "",
};

/** Formatted value and unit for one signal, or null when the value is unavailable. */
export function formatSignalValue(signal: Pick<LiveSignal, "value" | "unit">): { readonly value: string; readonly unit: string } | null {
  const { value, unit } = signal;
  const suffix = UNIT_SUFFIX[unit] ?? "";
  if (typeof value === "boolean") return { value: value ? "Yes" : "No", unit: "" };
  if (typeof value === "number") return Number.isFinite(value) ? { value: String(value), unit: suffix } : null;
  if (typeof value === "string") return { value, unit: suffix };
  return null;
}

/** "Last good <estate time>" or the explicit never-succeeded copy. */
export function evidenceLastGood(clock: EstateClock, availability: DataAvailability): string {
  const text = formatInstant(clock, availability.lastGoodAt);
  return text === null ? NO_SUCCESSFUL_OBSERVATION_TEXT : `Last good ${text}`;
}
