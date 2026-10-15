// apps/web/src/client/views/alerts/degraded-model.ts — per-source availability views and headline
// text for the <SourceStatus> indicators. Pure; keys off DataAvailability.state, never array length.
import type { AlertsPayload, AvailabilityState, DataAvailability } from "@pulse/web-data/wire";
import { TZ_FALLBACK_MARKER } from "../../format.js";
import type { EstateClock } from "../../format.js";

/** A named per-source availability the <SourceStatus> indicator renders. `label` is the
 *  operator-facing source name ("Alertmanager", "vmalert"); `availability` is the frozen wire
 *  DataAvailability taken verbatim from AlertsPayload.alertmanager / .vmalert. */
export interface SourceStatusView {
  readonly label: string;
  readonly availability: DataAvailability;
}

/**
 * Format a source's last-good time for a degraded indicator, in the estate zone.
 *
 * @param lastGoodAt - UTC ISO-8601 string from DataAvailability.lastGoodAt, or null when the source
 *   has never reported a good read.
 * @param clock - The estate clock (the time always carries its zone).
 * @returns The estate-zone time (with ` (TZ_FALLBACK_MARKER)` when the zone fell back to UTC);
 *   "time unknown" when null or unparseable (never throws).
 */
export function formatLastGood(lastGoodAt: string | null, clock: EstateClock): string {
  if (lastGoodAt === null) return "time unknown";
  if (Number.isNaN(Date.parse(lastGoodAt))) return "time unknown";
  const at = clock.format(lastGoodAt);
  return clock.tzFallback ? `${at} (${TZ_FALLBACK_MARKER})` : at;
}

/**
 * Compose the source-named headline for a non-current source. Total over the closed
 * AvailabilityState union; the `current` arm is unreachable (the caller guards it) but is
 * present so the switch is exhaustive.
 */
export function sourceStatusHeadline(source: SourceStatusView, clock: EstateClock): string {
  const { label, availability } = source;
  const at = formatLastGood(availability.lastGoodAt, clock);
  const state: AvailabilityState = availability.state;
  switch (state) {
    case "stale":
      return `${label} data is stale — last updated ${at}`;
    case "unavailable":
      return `${label} unreachable — showing data as of ${at}`;
    case "not-configured":
      return `${label} is not configured`;
    case "current":
      return `${label} data is current`;
  }
}

/** Build the two named source views from the payload, in a stable order.
 *  Alertmanager governs alerts/silences; vmalert governs rules. */
export function sourceStatusViews(payload: AlertsPayload): readonly SourceStatusView[] {
  return [
    { label: "Alertmanager", availability: payload.alertmanager },
    { label: "vmalert", availability: payload.vmalert },
  ];
}
