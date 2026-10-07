import type { AlertHistoryLane } from "@pulse/web-data/wire";
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
