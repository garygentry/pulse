// apps/web/src/client/views/alerts/degraded.tsx
// <SourceStatus> — per-source DataAvailability notices above the firing table. Keys off
// DataAvailability.state, NEVER array length (never silent-green).
import type { ReactElement } from "react";

import { Callout, TARGET_STATUS } from "@/ui";
import type { AlertsPayload } from "@pulse/web-data/wire";
import { sourceStatusHeadline, sourceStatusViews } from "./degraded-model.js";
import type { SourceStatusView } from "./degraded-model.js";

/** Props for {@link SourceStatus} — a single source. */
export interface SourceStatusProps {
  readonly source: SourceStatusView;
}

/**
 * A per-source degraded/unknown notice. Renders NOTHING when the source is `current`; otherwise a
 * source-named Callout (icon + text, never colour alone) with the unknown status presentation.
 * A polite status region, not a live alert.
 */
export function SourceStatus({ source }: SourceStatusProps): ReactElement | null {
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
      title={sourceStatusHeadline(source)}
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
export function SourceStatusBanners({ payload }: { readonly payload: AlertsPayload }): ReactElement {
  return (
    <div data-source-status-group="" className="grid gap-2 empty:hidden">
      {sourceStatusViews(payload).map((s) => (
        <SourceStatus key={s.availability.source} source={s} />
      ))}
    </div>
  );
}
