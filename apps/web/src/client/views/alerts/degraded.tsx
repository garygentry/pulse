// apps/web/src/client/views/alerts/degraded.tsx
// <SourceStatus> — per-source DataAvailability notices above the firing table. Keys off
// DataAvailability.state, NEVER array length (never silent-green).
import type { ReactElement } from "react";

import { Callout, StatusBadge, TARGET_STATUS } from "@/ui";
import type { AlertsPayload } from "@pulse/web-data/wire";
import type { EstateClock } from "../../format.js";
import { sourceStatusHeadline, sourceStatusViews } from "./degraded-model.js";
import type { SourceStatusView } from "./degraded-model.js";

/** Props for {@link SourceStatus} — a single source. */
export interface SourceStatusProps {
  readonly source: SourceStatusView;
  /** The estate clock for the last-good time. */
  readonly clock: EstateClock;
}

/**
 * A per-source degraded/unknown notice. Renders NOTHING when the source is `current`; otherwise a
 * source-named Callout (icon + text, never colour alone) with the unknown status presentation.
 * A polite status region, not a live alert.
 */
export function SourceStatus({ source, clock }: SourceStatusProps): ReactElement | null {
  const { availability } = source;
  if (availability.state === "current") return null; // healthy → no indicator (partial render)

  // availability.message is the source-provided human string when present; otherwise the headline
  // is the whole message. We never invent a "green" fallback.
  return (
    <Callout
      compact
      role="status"
      tone={TARGET_STATUS.unknown.tone}
      icon={TARGET_STATUS.unknown.icon}
      title={sourceStatusHeadline(source, clock)}
      data-status="unknown"
      data-availability={availability.state}
      data-source={availability.source}
    >
      {availability.message !== null ? <span data-source-status-detail="">{availability.message}</span> : null}
    </Callout>
  );
}

/** The notice group `view.tsx` mounts above the facets. Each source renders independently; a
 *  `current` source contributes nothing, so the group collapses (`empty:hidden`) when both are healthy. */
export function SourceStatusBanners({ payload, clock }: { readonly payload: AlertsPayload; readonly clock: EstateClock }): ReactElement {
  return (
    <div data-source-status-group="" className="grid gap-2 empty:hidden">
      {sourceStatusViews(payload).map((s) => (
        <SourceStatus key={s.availability.source} source={s} clock={clock} />
      ))}
    </div>
  );
}

/**
 * The deadman heartbeat as its own indicator above the firing table (F4): firing means the alert
 * path works, so it is OK, not a problem row. A configured heartbeat that is NOT firing (with current
 * Alertmanager evidence) is a warning. Renders nothing when there is no verdict to give. The badge
 * label is short; the explanation is wrapping text, so it fits a 320px screen.
 */
export function HeartbeatIndicator(props: { readonly state: "firing" | "silent" | "absent" }): ReactElement | null {
  if (props.state === "absent") return null;
  const status = props.state === "firing" ? "ok" : "warning";
  const { tone, icon } = TARGET_STATUS[status];
  return (
    <p className="m-0 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm" data-slot="alerts-heartbeat" data-status={status}>
      <StatusBadge tone={tone} icon={icon} label={props.state === "firing" ? "Heartbeat OK" : "Heartbeat missing"} />
      <span className="min-w-0 text-muted-foreground">
        {props.state === "firing"
          ? "The always-firing heartbeat is arriving, so the alert path is working."
          : "The heartbeat is not firing, so the alert path may be broken."}
      </span>
    </p>
  );
}
