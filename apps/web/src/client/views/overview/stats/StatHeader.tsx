// apps/web/src/client/views/overview/stats/StatHeader.tsx — whole-estate totals.
//
// Every number comes from the one `OverviewStats` derived from the model the grid renders. Missing
// coverage/engine evidence is rendered as an explicit "unavailable" state — never 0 gaps or OK — and
// retained non-current values carry their stale qualifier plus last-good time. Feed freshness
// (Live/Stale + update time) is the shell's top-bar indicator and the estate zone + UTC fallback
// marker sit in the page header meta; this header repeats neither.
// Read-only: no control in this region mutates anything.

import type { ReactElement, ReactNode } from "react";

import { ALERT_SEVERITY, Badge, TARGET_STATUS } from "@/ui";
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
