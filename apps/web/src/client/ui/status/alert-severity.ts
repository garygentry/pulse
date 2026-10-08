import type { ActiveAlert, AlertHistoryLane } from "@pulse/web-data/wire";
import { defineStatusMap } from "@/ui/lib/status";

/** The normalized alert severities; free-form wire values resolve through `alertSeverityOf`. */
export type AlertSeverity = AlertHistoryLane["severity"];

/** Alert severity presentation. Info has its own tone rather than collapsing to neutral. */
export const ALERT_SEVERITY = defineStatusMap<AlertSeverity>({
  critical: { tone: "danger", icon: "octagon-alert", label: "Critical" },
  warning: { tone: "warn", icon: "triangle-alert", label: "Warning" },
  info: { tone: "info", icon: "info", label: "Info" },
  unknown: { tone: "neutral", icon: "circle-help", label: "Unknown" },
});

/** Normalize a free-form severity string (e.g. `ActiveAlert.severity`); anything else is unknown. */
export function alertSeverityOf(severity: string): AlertSeverity {
  return severity === "critical" || severity === "warning" || severity === "info" ? severity : "unknown";
}

/** A delivered alert's state status: a firing alert takes its normalized severity (so a firing
 *  info alert is `info`, not the target-status `unknown`); silenced and inhibited are `suppressed`. */
export type AlertStateStatus = AlertSeverity | "suppressed";

/** Alert state presentation, keyed by {@link alertStateOf}. Firing entries are the severity's;
 *  suppressed is an outline badge with the bell marker, distinct from every severity without colour. */
export const ALERT_STATE = defineStatusMap<AlertStateStatus>({
  ...ALERT_SEVERITY,
  suppressed: { tone: "neutral", icon: "bell", label: "Suppressed", variant: "outline" },
});

/** The {@link ALERT_STATE} key for an alert's delivery state and free-form severity. */
export function alertStateOf(state: ActiveAlert["state"], severity: string): AlertStateStatus {
  return state === "firing" ? alertSeverityOf(severity) : "suppressed";
}
