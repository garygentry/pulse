// apps/web/src/client/views/overview/drawer/AlertList.tsx — firing alerts attributed to exactly the
// selected target. Snapshot order, read-only: no silence, acknowledge, edit or navigation control.
// Severity comes from ALERT_SEVERITY (`info` uses the info tone).

import type { ReactElement } from "react";

import type { OverviewAlertSummary } from "@pulse/web-data/wire";
import { Badge, Icon, Section, alertSeverityOf } from "@/ui";
import type { EstateClock } from "../../../format.js";
import { UNNAMED_ALERT } from "../selectors.js";
import { formatInstant } from "../stats/format.js";
import { SeverityBadge } from "../status-badges.js";
import { DRAWER_EMPTY_CLASS, DRAWER_LIST_CLASS, DRAWER_ROW_CLASS } from "./classes.js";

/** Empty-section copy. */
export const NO_TARGET_ALERTS_TEXT = "No firing alerts attributed to this target.";

function AlertRow(props: { readonly alert: OverviewAlertSummary; readonly clock: EstateClock }): ReactElement {
  const { alert, clock } = props;
  const started = formatInstant(clock, alert.startsAt);
  return (
    <li className={DRAWER_ROW_CLASS} data-fingerprint={alert.fingerprint} data-severity={alert.severity}>
      <div className="flex flex-wrap items-center gap-2">
        <SeverityBadge severity={alertSeverityOf(alert.severity)} />
        <span data-slot="drawer-alert-name" className="font-medium break-words">{alert.name ? alert.name : UNNAMED_ALERT}</span>
        {alert.acked === true ? (
          <Badge variant="secondary" data-acked="">
            <Icon name="circle-check" />
            Acknowledged
          </Badge>
        ) : null}
      </div>
      <span data-slot="drawer-alert-start" className="text-xs text-muted-foreground">
        {started === null ? "Start time unavailable" : `Started ${started} (${clock.relative(alert.startsAt)})`}
      </span>
      {alert.summary !== undefined ? <span data-slot="drawer-alert-summary">{alert.summary}</span> : null}
    </li>
  );
}

/** Render attributed active alerts without mutation controls. */
export function AlertList(props: {
  readonly alerts: readonly OverviewAlertSummary[];
  readonly clock: EstateClock;
}): ReactElement {
  return (
    <Section level={3} title="Firing alerts" data-section="alerts">
      {props.alerts.length === 0 ? (
        <p data-slot="drawer-empty" className={DRAWER_EMPTY_CLASS}>{NO_TARGET_ALERTS_TEXT}</p>
      ) : (
        <ul className={DRAWER_LIST_CLASS}>
          {props.alerts.map((alert, i) => <AlertRow key={`${alert.fingerprint}:${i}`} alert={alert} clock={props.clock} />)}
        </ul>
      )}
    </Section>
  );
}
