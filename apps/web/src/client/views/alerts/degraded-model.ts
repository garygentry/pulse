// apps/web/src/client/views/alerts/degraded-model.ts — per-source availability views and headline
// text for the <SourceStatus> indicators. Pure; keys off DataAvailability.state, never array length.
import type { AlertsPayload, AvailabilityState, DataAvailability } from "@pulse/web-data/wire";

/** A named per-source availability the <SourceStatus> indicator renders. `label` is the
 *  operator-facing source name ("Alertmanager", "vmalert"); `availability` is the frozen wire
 *  DataAvailability taken verbatim from AlertsPayload.alertmanager / .vmalert. */
export interface SourceStatusView {
  readonly label: string;
  readonly availability: DataAvailability;
}

/**
 * Format a source's last-good time for a degraded indicator ("…as of HH:MM").
 *
 * @param lastGoodAt - UTC ISO-8601 string from DataAvailability.lastGoodAt, or null when the source
 *   has never reported a good read.
 * @returns A short local HH:MM string; "time unknown" when null or unparseable (never throws).
 */
export function formatLastGood(lastGoodAt: string | null): string {
  if (lastGoodAt === null) return "time unknown";
  const ms = Date.parse(lastGoodAt);
  if (Number.isNaN(ms)) return "time unknown";
  return new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/**
 * Compose the source-named headline for a non-current source. Total over the closed
 * AvailabilityState union; the `current` arm is unreachable (the caller guards it) but is
 * present so the switch is exhaustive.
 */
export function sourceStatusHeadline(source: SourceStatusView): string {
  const { label, availability } = source;
  const at = formatLastGood(availability.lastGoodAt);
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
