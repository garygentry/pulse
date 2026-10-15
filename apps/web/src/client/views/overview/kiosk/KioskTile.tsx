// apps/web/src/client/views/overview/kiosk/KioskTile.tsx — one read-only kiosk host tile.
//
// Two fixed lines: (1) host name, its class label and the effective rollup status; (2) the firing-alert
// count, the host's non-OK services as status chips (worst first, at most KIOSK_TILE_CHIP_LIMIT, then
// "+N more") and its OK services summarised as "N OK". Status is always icon + text from
// TARGET_STATUS / ALERT_SEVERITY. A tile is a list item, never a button: the kiosk is unattended, so
// nothing on it takes focus or selects. Memoized on the immutable host, so a live update re-renders
// only the tiles whose host changed (reported through the grid render probe as kind "tile").

import type { ReactElement } from "react";

import type { HostStatus, ServiceStatus, TargetStatus } from "@pulse/web-data/wire";
import { ALERT_SEVERITY, Badge, StatusBadge, TARGET_STATUS, VisuallyHidden, cn } from "@/ui";
import { effectiveStatus } from "../freshness.js";
import type { ChangeTracker } from "../model.js";
import { OVERVIEW_STATUS_ORDER } from "../model.js";
import { TargetStatusBadge } from "../status-badges.js";
import { changeMarkerAttribute, useStatusChangeMarker } from "../grid/change-marker.js";
import { memoWithEquality } from "../grid/memo.js";
import { reportGridRender } from "../grid/render-probe.js";
import { TARGET_CHANGED_CLASS, kioskTileClass } from "../grid/target-classes.js";

/**
 * Non-OK service chips shown on one tile before the rest collapse into "+N more": the worst one, so
 * its name stays readable in a tile one wallboard column wide.
 */
export const KIOSK_TILE_CHIP_LIMIT = 1 as const;

/** Props for one kiosk tile. */
export interface KioskTileProps {
  /** Current immutable host from the coherent model. */
  readonly host: HostStatus;
  /** Shared accepted-status transition tracker. */
  readonly changeTracker: ChangeTracker;
  /** Whether motion must be replaced by a static marker. */
  readonly reducedMotion: boolean;
}

function rank(status: TargetStatus): number {
  const index = OVERVIEW_STATUS_ORDER.indexOf(status);
  return index === -1 ? OVERVIEW_STATUS_ORDER.length : index;
}

/** The most severe critical/warning alert on the host, or null when every alert is info. */
function highestColouredSeverity(alerts: HostStatus["activeAlerts"]): "critical" | "warning" | null {
  if (alerts.some((alert) => alert.severity === "critical")) return "critical";
  return alerts.some((alert) => alert.severity === "warning") ? "warning" : null;
}

/** "2 alerts" visibly, "2 firing alerts" to assistive technology. */
function AlertCountLabel({ count }: { readonly count: number }): ReactElement {
  return (
    <>
      {count} <VisuallyHidden>firing </VisuallyHidden>
      {count === 1 ? "alert" : "alerts"}
    </>
  );
}

function AlertCount({ alerts }: { readonly alerts: HostStatus["activeAlerts"] }): ReactElement | null {
  const count = alerts.length;
  if (count === 0) return null;
  const severity = highestColouredSeverity(alerts);
  if (severity === null) {
    // Info-only alerts are counted but never colour the tile.
    return (
      <Badge variant="outline" className="shrink-0 tabular-nums" data-alert-count={count} data-severity="info">
        <AlertCountLabel count={count} />
      </Badge>
    );
  }
  return (
    <StatusBadge
      tone={ALERT_SEVERITY[severity].tone}
      icon={ALERT_SEVERITY[severity].icon}
      label={<AlertCountLabel count={count} />}
      data-alert-count={count}
      data-severity={severity}
    />
  );
}

interface ServiceChipProps {
  readonly service: ServiceStatus;
  readonly status: TargetStatus;
  readonly changeTracker: ChangeTracker;
  readonly reducedMotion: boolean;
}

/**
 * A shrinkable chip whose status word never truncates: StatusBadge renders the name as its first
 * text span and the status word as its last (the `detail`), and only the name may shrink.
 */
const CHIP_CLASS = cn(
  "min-w-0 shrink [&>span:last-child]:shrink-0 [&>span:last-child]:overflow-visible [&>span:last-child]:text-inherit",
  "data-[changed]:outline-2 data-[changed]:outline-solid data-[changed]:outline-foreground",
);

/**
 * One non-OK service: the status icon, its name (truncating before anything else on the line is
 * clipped) and its status word (never truncated); carries its own change marker.
 */
function KioskServiceChipView(props: ServiceChipProps): ReactElement {
  const { service, status, changeTracker, reducedMotion } = props;
  const change = useStatusChangeMarker(changeTracker, service.drilldownId, status, reducedMotion);
  const s = TARGET_STATUS[status];
  return (
    <StatusBadge
      tone={s.tone}
      icon={s.icon}
      label={service.name}
      detail={<span data-slot="overview-kiosk-chip-status">{s.label}</span>}
      {...(s.variant !== undefined ? { variant: s.variant } : {})}
      className={CHIP_CLASS}
      data-slot="overview-kiosk-chip"
      data-target-id={service.drilldownId}
      data-status={status}
      data-changed={changeMarkerAttribute(change)}
    />
  );
}

const KioskServiceChip = memoWithEquality(
  KioskServiceChipView,
  (a, b) =>
    a.service === b.service && a.status === b.status && a.changeTracker === b.changeTracker && a.reducedMotion === b.reducedMotion,
);

function KioskTileView(props: KioskTileProps): ReactElement {
  const { host, changeTracker, reducedMotion } = props;
  reportGridRender("tile", host.drilldownId);
  const status = effectiveStatus(host.rollupEvidence);
  const change = useStatusChangeMarker(changeTracker, host.drilldownId, status, reducedMotion);

  const services = host.services.map((service) => ({ service, status: effectiveStatus(service.statusEvidence) }));
  const okCount = services.filter((entry) => entry.status === "ok").length;
  const flagged = services
    .filter((entry) => entry.status !== "ok")
    .sort((a, b) => rank(a.status) - rank(b.status));
  const shown = flagged.slice(0, KIOSK_TILE_CHIP_LIMIT);
  const hidden = flagged.length - shown.length;

  return (
    <li
      className={kioskTileClass(status)}
      data-slot="overview-kiosk-tile"
      data-target-id={host.drilldownId}
      data-status={status}
      data-changed={changeMarkerAttribute(change)}
    >
      <div className="flex h-6 min-w-0 items-center gap-2">
        <span className="min-w-0 truncate text-base font-semibold" data-slot="overview-host-name">
          {host.name}
        </span>
        <span className="min-w-0 flex-1 shrink-4 truncate text-xs text-muted-foreground" data-slot="overview-kiosk-class">
          {host.collectionClass}
        </span>
        <TargetStatusBadge status={status} />
      </div>
      <div className="flex h-6 min-w-0 items-center gap-1 overflow-hidden" data-slot="overview-kiosk-services">
        {change?.marker === "static" ? (
          <span className={cn(TARGET_CHANGED_CLASS, "shrink-0")} data-slot="overview-target-changed">
            Changed
          </span>
        ) : null}
        <AlertCount alerts={host.activeAlerts} />
        {shown.map((entry) => (
          <KioskServiceChip
            key={entry.service.drilldownId}
            service={entry.service}
            status={entry.status}
            changeTracker={changeTracker}
            reducedMotion={reducedMotion}
          />
        ))}
        {hidden > 0 ? (
          <span className="shrink-0 text-xs text-muted-foreground" data-slot="overview-kiosk-more">{`+${hidden} more`}</span>
        ) : null}
        {okCount > 0 ? (
          <span className="shrink-0" data-slot="overview-kiosk-ok">
            <TargetStatusBadge status="ok" label={`${okCount} OK`} />
          </span>
        ) : null}
      </div>
    </li>
  );
}

/** Explicit equality: immutable host identity and stable collaborators. */
function sameKioskTileProps(a: Readonly<KioskTileProps>, b: Readonly<KioskTileProps>): boolean {
  return a.host === b.host && a.changeTracker === b.changeTracker && a.reducedMotion === b.reducedMotion;
}

/** Render one read-only kiosk tile; memoized by immutable host and collaborators. */
export const KioskTile = memoWithEquality(KioskTileView, sameKioskTileProps);
