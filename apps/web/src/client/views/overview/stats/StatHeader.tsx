// apps/web/src/client/views/overview/stats/StatHeader.tsx — whole-estate totals.
//
// Every number comes from the one `OverviewStats` derived from the model the grid renders. Missing
// coverage/engine evidence is rendered as an explicit "unavailable" state — never 0 gaps or OK — and
// retained non-current values carry their stale qualifier plus last-good time. Feed freshness
// (Live/Stale + update time) is the shell's top-bar indicator and the estate zone + UTC fallback
// marker sit in the page header meta; this header repeats neither. Kiosk renders `KioskStatStrip`
// instead: the same numbers as one compact line, so the tile wall keeps the screen.
// Read-only: no control in this region mutates anything.

import type { ReactElement, ReactNode } from "react";

import { ALERT_SEVERITY, Badge, TARGET_STATUS, VisuallyHidden } from "@/ui";
import type { EstateClock } from "../../../format.js";
import { OVERVIEW_STATUS_ORDER } from "../model.js";
import type { CoverageStat, EngineOkStat, OverviewStats, OverviewSurfaceState, StatusCounts } from "../model.js";
import { SeverityBadge, TargetStatusBadge } from "../status-badges.js";
import { countText, evidenceQualifier, lastGoodLabel } from "./format.js";

/** Inputs for the whole-estate statistic region. */
export interface StatHeaderProps {
  /** Statistics derived from the exact model rendered by the grid. */
  readonly stats: OverviewStats;
  /** Delivery state of the overview surface (exposed as `data-surface`). */
  readonly surface: OverviewSurfaceState;
  /** Estate-timezone formatter for every absolute last-good time. */
  readonly clock: EstateClock;
}

const SEVERITIES = ["critical", "warning", "info"] as const;

const LIST_CLASS = "m-0 flex list-none flex-wrap gap-1.5 p-0";
const DETAIL_CLASS = "text-xs text-muted-foreground tabular-nums";

/** One labelled stat card: a named group with a visible title. */
function StatCard(props: {
  readonly stat: string;
  readonly label: string;
  readonly title: string;
  readonly availability?: string;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <div
      className="flex min-w-0 flex-col gap-2 rounded-lg border bg-card p-3 text-card-foreground"
      data-stat={props.stat}
      {...(props.availability !== undefined ? { "data-availability": props.availability } : {})}
      role="group"
      aria-label={props.label}
    >
      <span className="text-xs font-medium text-muted-foreground" data-stat-title="">
        {props.title}
      </span>
      {props.children}
    </div>
  );
}

function StatusGroup(props: { readonly kind: "hosts" | "services"; readonly title: string; readonly counts: StatusCounts }): ReactElement {
  return (
    <StatCard stat={props.kind} label={props.title} title={props.title}>
      <ul className={LIST_CLASS}>
        {OVERVIEW_STATUS_ORDER.map((status) => (
          <li key={status} data-stat-status={status}>
            <TargetStatusBadge status={status} label={`${countText(props.counts[status])} ${TARGET_STATUS[status].label}`} />
          </li>
        ))}
      </ul>
    </StatCard>
  );
}

function FiringGroup(props: { readonly stats: OverviewStats }): ReactElement {
  const { firing, silenced, inhibited } = props.stats;
  return (
    <StatCard stat="firing" label="Firing alerts" title="Firing">
      <ul className={LIST_CLASS}>
        {SEVERITIES.map((severity) => (
          <li key={severity} data-stat-severity={severity}>
            <SeverityBadge severity={severity} label={`${ALERT_SEVERITY[severity].label} ${countText(firing[severity])}`} />
          </li>
        ))}
        <li data-stat-severity="silenced">
          <Badge variant="outline" className="tabular-nums">{`Silenced ${countText(silenced)}`}</Badge>
        </li>
        <li data-stat-severity="inhibited">
          <Badge variant="outline" className="tabular-nums">{`Inhibited ${countText(inhibited)}`}</Badge>
        </li>
      </ul>
    </StatCard>
  );
}

function CoverageGroup(props: { readonly coverage: CoverageStat; readonly clock: EstateClock }): ReactElement {
  const { coverage, clock } = props;
  if (coverage.status === "unavailable") {
    return (
      <StatCard stat="coverage" availability="unavailable" label="Coverage" title="Coverage">
        <TargetStatusBadge status="unknown" label="Coverage unavailable" />
        <span className={DETAIL_CLASS}>
          {coverage.message}
          {coverage.availability.lastGoodAt !== null ? ` ${lastGoodLabel(clock, coverage.availability.lastGoodAt)}` : null}
        </span>
      </StatCard>
    );
  }
  const current = coverage.availability.state === "current";
  const gapsText = `Gaps ${countText(coverage.gaps)}`;
  return (
    <StatCard stat="coverage" availability={current ? "current" : "retained"} label="Coverage" title="Coverage">
      {coverage.gaps > 0
        ? <TargetStatusBadge status="warning" label={gapsText} />
        : <Badge variant="outline" className="tabular-nums">{gapsText}</Badge>}
      <span className={DETAIL_CLASS}>
        {`Covered ${countText(coverage.covered)} · Extras ${countText(coverage.extras)}`}
      </span>
      {current ? null : (
        <span className={DETAIL_CLASS} data-stat-qualifier="">{evidenceQualifier(clock, coverage.availability)}</span>
      )}
    </StatCard>
  );
}

function engineBadge(status: "ok" | "critical" | "unknown", label: string): ReactElement {
  return <TargetStatusBadge status={status} label={label} />;
}

function EngineGroup(props: { readonly engine: EngineOkStat; readonly clock: EstateClock }): ReactElement {
  const { engine, clock } = props;
  const current = engine.status === "available" && engine.availability.state === "current";
  let badge: ReactElement;
  if (engine.status === "available" && current) {
    badge = engine.ok ? engineBadge("ok", "Engine OK") : engineBadge("critical", "Engine not OK");
  } else if (engine.availability.state === "not-configured") {
    badge = engineBadge("unknown", "Engine not configured");
  } else {
    badge = engineBadge("unknown", "Engine unavailable");
  }
  const lastGood = engine.availability.lastGoodAt;
  return (
    <StatCard stat="engine" availability={current ? "current" : "unavailable"} label="Engine" title="Engine">
      {badge}
      {current || lastGood === null ? null : (
        <span className={DETAIL_CLASS} data-stat-qualifier="">{lastGoodLabel(clock, lastGood)}</span>
      )}
    </StatCard>
  );
}

/** Render coherent estate totals as a grid of stat cards. */
export function StatHeader(props: StatHeaderProps): ReactElement {
  const { stats, surface, clock } = props;
  return (
    <section className="grid min-w-0 gap-2" aria-label="Estate statistics" data-surface={surface.status}>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,14rem),1fr))] gap-3">
        <StatusGroup kind="hosts" title="Hosts" counts={stats.hosts} />
        <StatusGroup kind="services" title="Services" counts={stats.services} />
        <FiringGroup stats={stats} />
        <CoverageGroup coverage={stats.coverage} clock={clock} />
        <EngineGroup engine={stats.engine} clock={clock} />
      </div>
    </section>
  );
}

/** One labelled run of the kiosk strip: a muted label, then its badges; never shrinks. */
function StripGroup(props: { readonly stat: string; readonly label: string; readonly children: ReactNode }): ReactElement {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-1.5 xl:flex-nowrap" data-stat={props.stat} role="group" aria-label={props.label}>
      <span className="text-sm font-medium text-muted-foreground" aria-hidden="true">
        {props.label}
      </span>
      {props.children}
    </div>
  );
}

/**
 * Host and service counts per status as one badge each: "Critical 1 · 2" reads hosts · services
 * (the run's label says so); the accessible text spells both out. Statuses with no host and no
 * service are left out (OK always shows, so the run is never empty).
 */
function StripStatuses(props: { readonly hosts: StatusCounts; readonly services: StatusCounts }): ReactElement {
  const { hosts, services } = props;
  const present = OVERVIEW_STATUS_ORDER.filter((status) => status === "ok" || hosts[status] !== 0 || services[status] !== 0);
  return (
    <>
      {present.map((status) => (
        <span key={status} data-stat-status={status}>
          <TargetStatusBadge
            status={status}
            label={
              <>
                <span aria-hidden="true">{`${TARGET_STATUS[status].label} ${countText(hosts[status])} · ${countText(services[status])}`}</span>
                <VisuallyHidden>{`${TARGET_STATUS[status].label}: ${countText(hosts[status])} hosts, ${countText(services[status])} services`}</VisuallyHidden>
              </>
            }
          />
        </span>
      ))}
    </>
  );
}

/** Muted, truncating strip detail (a qualifier or last-good time): the first thing to give way. */
const STRIP_DETAIL_CLASS = "min-w-0 shrink truncate text-xs text-muted-foreground tabular-nums";

function StripCoverage(props: { readonly coverage: CoverageStat; readonly clock: EstateClock }): ReactElement {
  const { coverage, clock } = props;
  if (coverage.status === "unavailable") {
    return (
      <StripGroup stat="coverage" label="Coverage">
        <TargetStatusBadge status="unknown" label="Unavailable" />
      </StripGroup>
    );
  }
  const current = coverage.availability.state === "current";
  const gapsText = `Gaps ${countText(coverage.gaps)}`;
  return (
    <>
      <StripGroup stat="coverage" label="Coverage">
        {coverage.gaps > 0
          ? <TargetStatusBadge status="warning" label={gapsText} />
          : <Badge variant="outline" className="tabular-nums">{gapsText}</Badge>}
      </StripGroup>
      {current ? null : (
        <span className={STRIP_DETAIL_CLASS} data-stat-qualifier="">{evidenceQualifier(clock, coverage.availability)}</span>
      )}
    </>
  );
}

function StripEngine(props: { readonly engine: EngineOkStat; readonly clock: EstateClock }): ReactElement {
  const { engine, clock } = props;
  const current = engine.status === "available" && engine.availability.state === "current";
  let badge: ReactElement;
  if (engine.status === "available" && current) {
    badge = engine.ok ? engineBadge("ok", "OK") : engineBadge("critical", "Not OK");
  } else if (engine.availability.state === "not-configured") {
    badge = engineBadge("unknown", "Not configured");
  } else {
    badge = engineBadge("unknown", "Unavailable");
  }
  const lastGood = engine.availability.lastGoodAt;
  return (
    <>
      <StripGroup stat="engine" label="Engine">
        {badge}
      </StripGroup>
      {current || lastGood === null ? null : (
        <span className={STRIP_DETAIL_CLASS} data-stat-qualifier="">{lastGoodLabel(clock, lastGood)}</span>
      )}
    </>
  );
}

/**
 * The kiosk's estate totals as one line: host · service counts per status, coverage gaps and engine
 * state (with its last-good time when not current). From `xl` (wallboard widths) up it never wraps —
 * details truncate instead — so its height, and with it the tile region's, stays fixed; narrower
 * screens may wrap rather than clip a count. Firing counts are on the kiosk alert line below; the
 * estate time zone is in the tile wall's footer. `relative` keeps the visually
 * hidden badge text inside the strip's clip, so it never widens the page.
 */
export function KioskStatStrip(props: StatHeaderProps): ReactElement {
  const { stats, surface, clock } = props;
  return (
    <section
      className="relative flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 overflow-hidden whitespace-nowrap xl:flex-nowrap"
      aria-label="Estate statistics"
      data-surface={surface.status}
      data-slot="overview-stat-strip"
      data-stat-strip=""
    >
      <StripGroup stat="hosts" label="Hosts · services">
        <StripStatuses hosts={stats.hosts} services={stats.services} />
      </StripGroup>
      <StripCoverage coverage={stats.coverage} clock={clock} />
      <StripEngine engine={stats.engine} clock={clock} />
    </section>
  );
}
