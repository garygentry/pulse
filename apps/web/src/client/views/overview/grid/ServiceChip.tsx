// apps/web/src/client/views/overview/grid/ServiceChip.tsx — one independently selectable service
// target inside its host card.
//
// The chip's status is its OWN effective status (never the host rollup). Status word, icon and
// `data-status` come from TARGET_STATUS and the a11y helpers; no local status-label map exists.
// Activation is native: the grid's spatial controller receives the button's single click (Enter and
// Space synthesize it) and forwards the canonical id, so the chip binds no click/keydown handler of
// its own — a second handler would double-select.

import type { ReactElement } from "react";

import type { ServiceStatus } from "@pulse/web-data/wire";
import { serviceLabel } from "../../../a11y/index.js";
import { cn } from "@/ui";
import { effectiveStatus } from "../freshness.js";
import type { ChangeTracker } from "../model.js";
import { TargetStatusBadge } from "../status-badges.js";
import { changeMarkerAttribute, useStatusChangeMarker } from "./change-marker.js";
import { lastGoodText } from "./evidence.js";
import { memoWithEquality } from "./memo.js";
import { reportGridRender } from "./render-probe.js";
import { TARGET_CHANGED_CLASS, TARGET_EVIDENCE_CLASS, TARGET_TRIGGER_CLASS, statusBorderClass } from "./target-classes.js";

/** Props for one independently selectable service target. */
export interface ServiceChipProps {
  /** Current immutable service from its owning host. */
  readonly service: ServiceStatus;
  /** Whether this exact canonical service is selected. */
  readonly selected: boolean;
  /** Shared accepted-status transition tracker. */
  readonly changeTracker: ChangeTracker;
  /** Whether motion must be replaced by a static marker. */
  readonly reducedMotion: boolean;
  /** Select this service by canonical rendered id. */
  readonly onSelect: (drilldownId: string) => void;
}

function ServiceChipView(props: ServiceChipProps): ReactElement {
  const { service, selected, changeTracker, reducedMotion } = props;
  reportGridRender("service", service.drilldownId);
  const status = effectiveStatus(service.statusEvidence);
  const change = useStatusChangeMarker(changeTracker, service.drilldownId, status, reducedMotion);
  const unknown = status === "unknown";
  const evidence = service.statusEvidence.availability;

  // Render-only projection so the shared helper phrases the effective (not nominal) status.
  const parts = [serviceLabel({ ...service, status })];
  if (unknown) parts.push(lastGoodText(evidence));

  return (
    <button
      type="button"
      role="gridcell"
      className={cn(TARGET_TRIGGER_CLASS, "bg-muted", statusBorderClass(status))}
      data-slot="overview-chip"
      data-overview-target=""
      data-target-kind="service"
      data-target-id={service.drilldownId}
      data-status={status}
      data-changed={changeMarkerAttribute(change)}
      aria-selected={selected}
      aria-label={parts.join(", ")}
    >
      <span className="font-medium" data-slot="overview-chip-name">
        {service.name}
      </span>
      <TargetStatusBadge status={status} />
      {unknown ? (
        <span className={TARGET_EVIDENCE_CLASS} data-slot="overview-target-evidence">
          {lastGoodText(evidence)}
          {evidence.message !== null ? <span className="ms-1">{evidence.message}</span> : null}
        </span>
      ) : null}
      {change?.marker === "static" ? (
        <span className={TARGET_CHANGED_CLASS} data-slot="overview-target-changed">
          Changed
        </span>
      ) : null}
    </button>
  );
}

/** Explicit equality: immutable service identity, selection, and stable collaborators. */
function sameServiceChipProps(a: Readonly<ServiceChipProps>, b: Readonly<ServiceChipProps>): boolean {
  return (
    a.service === b.service &&
    a.selected === b.selected &&
    a.changeTracker === b.changeTracker &&
    a.reducedMotion === b.reducedMotion &&
    a.onSelect === b.onSelect
  );
}

/** Render a status-semantic service button inside its host row; memoized by immutable inputs. */
export const ServiceChip = memoWithEquality(ServiceChipView, sameServiceChipProps);
