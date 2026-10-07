// apps/web/src/client/views/overview/grid/HostCell.tsx — one host card: a host trigger plus sibling
// service chips.
//
// The host trigger renders ONLY name, effective rollup, liveness and firing-alert count — never
// deep-health, backup age, command signals, checks or a sparkline. `rollupEvidence`
// governs the card's effective status. The card itself is not a button: its trigger and each service
// chip are separate native buttons (gridcells) so nothing nests interactively. Like ServiceChip, the
// trigger binds no activation handler; the grid's spatial controller owns the single click path.

import type { ReactElement } from "react";

import type { HostStatus } from "@pulse/web-data/wire";
import { cellLabel } from "../../../a11y/index.js";
import { ALERT_SEVERITY, Badge, StatusBadge, cn } from "@/ui";
import { effectiveStatus } from "../freshness.js";
import type { ChangeTracker } from "../model.js";
import { TargetStatusBadge } from "../status-badges.js";
import { changeMarkerAttribute, useStatusChangeMarker } from "./change-marker.js";
import { lastGoodText } from "./evidence.js";
import { memoWithEquality } from "./memo.js";
import { reportGridRender } from "./render-probe.js";
import { ServiceChip } from "./ServiceChip.js";
import { TARGET_CHANGED_CLASS, TARGET_EVIDENCE_CLASS, TARGET_TRIGGER_CLASS, hostCardClass } from "./target-classes.js";

export { lastGoodText } from "./evidence.js";

/** Props for one host row/card and its nested target triggers. */
export interface HostCellProps {
  /** Current immutable host from the coherent model. */
  readonly host: HostStatus;
  /** Canonical selected target id, or null. */
  readonly selectedTargetId: string | null;
  /** Shared accepted-status transition tracker. */
  readonly changeTracker: ChangeTracker;
  /** Whether motion must be replaced by a static marker. */
  readonly reducedMotion: boolean;
  /** Select a canonical host or service target. */
  readonly onSelect: (drilldownId: string) => void;
}

/** Visible and accessible liveness wording. */
export function livenessText(live: boolean | null): string {
  if (live === null) return "Liveness unknown";
  return live ? "Live" : "Not live";
}

/** The most severe critical/warning alert on the host, or null when every alert is info. */
function highestColouredSeverity(alerts: HostStatus["activeAlerts"]): "critical" | "warning" | null {
  if (alerts.some((alert) => alert.severity === "critical")) return "critical";
  return alerts.some((alert) => alert.severity === "warning") ? "warning" : null;
}

function alertCountText(count: number): string {
  return count === 1 ? "1 firing alert" : `${count} firing alerts`;
}

function HostCellView(props: HostCellProps): ReactElement {
  const { host, selectedTargetId, changeTracker, reducedMotion, onSelect } = props;
  reportGridRender("host", host.drilldownId);
  const status = effectiveStatus(host.rollupEvidence);
  const change = useStatusChangeMarker(changeTracker, host.drilldownId, status, reducedMotion);
  const unknown = status === "unknown";
  const evidence = host.rollupEvidence.availability;
  const alertCount = host.activeAlerts.length;
  const live = livenessText(host.live);

  // Render-only projection so the shared helper phrases the effective (not nominal) rollup.
  const parts = [cellLabel({ ...host, rollup: status }), live];
  if (alertCount > 0) parts.push(alertCountText(alertCount));
  if (unknown) parts.push(lastGoodText(evidence));
  const alertSeverity = highestColouredSeverity(host.activeAlerts);

  // The card also carries `data-target-id` so the kiosk probe (readKioskFitMetrics) measures a whole
  // card; only `[data-overview-target]` triggers are roving targets.
  return (
    <div
      role="row"
      className={hostCardClass(status)}
      data-slot="overview-host"
      data-status={status}
      data-target-id={host.drilldownId}
    >
      <button
        type="button"
        role="gridcell"
        className={cn(TARGET_TRIGGER_CLASS, "border-border bg-transparent")}
        data-overview-target=""
        data-target-kind="host"
        data-target-id={host.drilldownId}
        data-status={status}
        data-changed={changeMarkerAttribute(change)}
        aria-selected={selectedTargetId === host.drilldownId}
        aria-label={parts.join(", ")}
      >
        <span className="text-base font-semibold" data-slot="overview-host-name">
          {host.name}
        </span>
        <TargetStatusBadge status={status} />
        <span
          className="text-xs text-muted-foreground"
          data-live={host.live === null ? "unknown" : String(host.live)}
        >
          {live}
        </span>
        {alertCount > 0 ? (
          alertSeverity !== null ? (
            <StatusBadge
              tone={ALERT_SEVERITY[alertSeverity].tone}
              icon={ALERT_SEVERITY[alertSeverity].icon}
              label={alertCountText(alertCount)}
              data-alert-count={alertCount}
              data-severity={alertSeverity}
            />
          ) : (
            // Info-only alerts are listed but never colour the cell.
            <Badge variant="outline" className="tabular-nums" data-alert-count={alertCount} data-severity="info">
              {alertCountText(alertCount)}
            </Badge>
          )
        ) : null}
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
      {host.services.length > 0 ? (
        <div className="flex min-w-0 flex-wrap gap-1" data-slot="overview-host-services">
          {host.services.map((service) => (
            <ServiceChip
              key={service.drilldownId}
              service={service}
              selected={selectedTargetId === service.drilldownId}
              changeTracker={changeTracker}
              reducedMotion={reducedMotion}
              onSelect={onSelect}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** The selected id if it names this host or one of its services, else null. */
function selectionWithin(host: HostStatus, selectedTargetId: string | null): string | null {
  if (selectedTargetId === null || selectedTargetId === host.drilldownId) return selectedTargetId;
  return host.services.some((service) => service.drilldownId === selectedTargetId) ? selectedTargetId : null;
}

/** Explicit equality: host identity, the selection as it concerns this host, stable collaborators. */
function sameHostCellProps(a: Readonly<HostCellProps>, b: Readonly<HostCellProps>): boolean {
  return (
    a.host === b.host &&
    selectionWithin(a.host, a.selectedTargetId) === selectionWithin(b.host, b.selectedTargetId) &&
    a.changeTracker === b.changeTracker &&
    a.reducedMotion === b.reducedMotion &&
    a.onSelect === b.onSelect
  );
}

/** Render one host card; memoized by immutable host and selection inputs. */
export const HostCell = memoWithEquality(HostCellView, sameHostCellProps);
