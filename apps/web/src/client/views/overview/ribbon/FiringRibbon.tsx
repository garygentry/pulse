// apps/web/src/client/views/overview/ribbon/FiringRibbon.tsx — the compact current-firing ribbon.
//
// `alerts` is the snapshot's already-filtered firing list, rendered exactly as given: no silenced/
// inhibited inference, dedupe, severity removal or second alert source. Desk/mobile rows expose an
// alert triage action and, only for attributed alerts, a separate target triage action, both through
// the canonical path helpers. Kiosk renders a text-only summary (counts, first five ordered names,
// "+N more") with no interactive or focusable descendant. Non-current alert evidence keeps retained
// names as historical context and never shows the affirmative "No firing alerts". Read-only.

import type { ReactElement } from "react";

import type { OverviewAlertSummary } from "@pulse/web-data/wire";
import { Badge, Button, Callout, Icon, Section, Tooltip, TooltipContent, TooltipTrigger, alertSeverityOf } from "@/ui";
import type { EstateClock } from "../../../format.js";
import type { PathRouter } from "../../../router.js";
import { memoWithEquality, shallowEqualProps } from "../grid/memo.js";
import type { AlertSeverityCounts } from "../model.js";
import { UNNAMED_ALERT, alertTriagePath, buildKioskFiringSummary, countAcked, targetTriagePath } from "../selectors.js";
import { SeverityBadge } from "../status-badges.js";
import { formatInstant, lastGoodLabel } from "../stats/format.js";

/** Inputs for the compact current-firing summary. */
export interface FiringRibbonProps {
  /** Snapshot-provided, already-filtered unsilenced/uninhibited firing summaries. */
  readonly alerts: readonly OverviewAlertSummary[];
  /** Existing application router used for desk/mobile triage links. */
  readonly router: PathRouter;
  /** Estate-timezone formatter for start timestamps. */
  readonly clock: EstateClock;
  /** True only when `store.route.value.query.kiosk === "1"`. */
  readonly kiosk: boolean;
  /** Whether alert-source evidence for this accepted snapshot is current. */
  readonly alertsCurrent: boolean;
  /** Alert-source last-good UTC instant, or null before any success. */
  readonly alertsLastGoodAt: string | null;
}

/** Affirmative empty copy; only rendered when alert evidence is current. */
export const NO_FIRING_ALERTS_TEXT = "No firing alerts";
/** Heading of the non-current alert-evidence treatment. */
export const ALERT_STATE_STALE_TEXT = "Alert state unavailable or stale";

const SEVERITY_LABEL: Readonly<Record<OverviewAlertSummary["severity"], string>> = {
  critical: "Critical",
  warning: "Warning",
  info: "Info",
};

function severityLabel(severity: OverviewAlertSummary["severity"]): string {
  return SEVERITY_LABEL[severity] ?? "Unknown severity";
}

function alertName(alert: OverviewAlertSummary): string {
  return alert.name ? alert.name : UNNAMED_ALERT;
}

function countsText(counts: AlertSeverityCounts): string {
  return `Critical ${counts.critical} · Warning ${counts.warning} · Info ${counts.info}`;
}

function StaleNotice(props: { readonly clock: EstateClock; readonly lastGoodAt: string | null }): ReactElement {
  // Historical context, not a live alert: a static note, never an assertive region.
  return (
    <Callout tone="neutral" role="note" compact title={ALERT_STATE_STALE_TEXT} data-alerts-current="false" data-ribbon-stale="">
      {props.lastGoodAt === null ? "No successful observation" : lastGoodLabel(props.clock, props.lastGoodAt)}
    </Callout>
  );
}

const EMPTY_CLASS = "m-0 text-sm text-muted-foreground";

function AlertRow(props: { readonly alert: OverviewAlertSummary; readonly router: PathRouter; readonly clock: EstateClock }): ReactElement {
  const { alert, router, clock } = props;
  const name = alertName(alert);
  const severity = severityLabel(alert.severity);
  const started = formatInstant(clock, alert.startsAt);
  const startedText = started === null ? "Start time unavailable" : `Started ${started}`;
  const target = alert.target;
  const alertLabel = [`Open alert ${name}`, severity, startedText, ...(target === null ? [] : [`target ${target.id}`])].join(", ");
  const summary = alert.summary ?? "";

  let alertAction: ReactElement;
  if (alert.fingerprint) {
    const button = (
      <Button
        type="button"
        variant="link"
        className="h-auto min-h-11 min-w-11 px-1 whitespace-normal text-left font-semibold"
        data-ribbon-action="alert"
        aria-label={alertLabel}
        onClick={() => router.navigate(alertTriagePath(alert))}
      >
        {name}
      </Button>
    );
    alertAction = summary === "" ? button : (
      <Tooltip>
        <TooltipTrigger asChild>{button}</TooltipTrigger>
        <TooltipContent>{summary}</TooltipContent>
      </Tooltip>
    );
  } else {
    // A missing fingerprint is a wire-contract violation: show it, but invent no path.
    alertAction = <span className="px-1 font-semibold text-muted-foreground" data-alert-unavailable="">{name}</span>;
  }

  return (
    <li className="flex flex-wrap items-center gap-x-2 gap-y-1" data-fingerprint={alert.fingerprint} data-severity={alert.severity}>
      <SeverityBadge severity={alertSeverityOf(String(alert.severity))} label={severity} />
      {alertAction}
      {alert.acked === true ? (
        <Badge variant="secondary" data-acked="">
          <Icon name="circle-check" />
          Acknowledged
        </Badge>
      ) : null}
      <span className="text-xs text-muted-foreground tabular-nums" data-started="">{startedText}</span>
      {target !== null ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-auto min-h-11 min-w-11 max-w-full whitespace-normal break-all"
          data-ribbon-action="target"
          data-target-kind={target.kind}
          aria-label={`Alerts for target ${target.id}`}
          onClick={() => router.navigate(targetTriagePath(target))}
        >
          {target.id}
        </Button>
      ) : null}
    </li>
  );
}

/** Rows re-render only when their alert (structurally shared across cycles), router or clock change. */
const MemoAlertRow = memoWithEquality(AlertRow, shallowEqualProps);

function DeskRibbon(props: FiringRibbonProps): ReactElement {
  const { alerts, router, clock, alertsCurrent, alertsLastGoodAt } = props;
  return (
    <Section
      title={`Firing alerts (${alerts.length})`}
      aria-label="Firing alerts"
      data-ribbon="desk"
      data-kiosk="false"
      data-alerts-current={String(alertsCurrent)}
      className="min-w-0 gap-2"
    >
      {alertsCurrent ? null : <StaleNotice clock={clock} lastGoodAt={alertsLastGoodAt} />}
      {alerts.length === 0 ? (
        alertsCurrent ? <p className={EMPTY_CLASS} data-ribbon-empty="">{NO_FIRING_ALERTS_TEXT}</p> : null
      ) : (
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {alerts.map((alert, index) => (
            <MemoAlertRow key={`${alert.fingerprint}:${index}`} alert={alert} router={router} clock={clock} />
          ))}
        </ul>
      )}
    </Section>
  );
}

function KioskRibbon(props: FiringRibbonProps): ReactElement {
  const { alerts, clock, alertsCurrent, alertsLastGoodAt } = props;
  const summary = buildKioskFiringSummary(alerts);
  const acked = countAcked(alerts);
  return (
    <section
      className="grid min-w-0 gap-2 text-sm"
      aria-label="Firing alerts summary"
      data-ribbon="kiosk"
      data-kiosk="true"
      data-alerts-current={String(alertsCurrent)}
    >
      <p className="m-0 font-semibold tabular-nums" data-ribbon-counts="">{countsText(summary.counts)}</p>
      {acked > 0 ? (
        <p className="m-0" data-ribbon-acked="">
          <Badge variant="secondary">
            <Icon name="circle-check" />
            {`${acked} acknowledged`}
          </Badge>
        </p>
      ) : null}
      {alertsCurrent ? null : <StaleNotice clock={clock} lastGoodAt={alertsLastGoodAt} />}
      {summary.names.length === 0 ? (
        alertsCurrent ? <p className={EMPTY_CLASS} data-ribbon-empty="">{NO_FIRING_ALERTS_TEXT}</p> : null
      ) : (
        <ol className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0" data-ribbon-names="">
          {summary.names.map((name, index) => (
            <li key={index} data-ribbon-name="">{name}</li>
          ))}
        </ol>
      )}
      {summary.overflow > 0 ? <p className={EMPTY_CLASS} data-ribbon-overflow="">{`+${summary.overflow} more`}</p> : null}
    </section>
  );
}

/** Render the interactive desk/mobile ribbon or non-interactive kiosk summary. */
export function FiringRibbon(props: FiringRibbonProps): ReactElement {
  return props.kiosk ? <KioskRibbon {...props} /> : <DeskRibbon {...props} />;
}
