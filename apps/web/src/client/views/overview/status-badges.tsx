// apps/web/src/client/views/overview/status-badges.tsx — the overview's status and severity badges.
// Tone, icon and variant come only from TARGET_STATUS / ALERT_SEVERITY; `data-status` /
// `data-severity` is the stable test hook. Every label renders as a JSX text child.

import type { ReactElement, ReactNode } from "react";

import type { TargetStatus } from "@pulse/web-data/wire";
import { ALERT_SEVERITY, StatusBadge, TARGET_STATUS } from "@/ui";
import type { AlertSeverity, StatusBadgeSize } from "@/ui";

/** A TARGET_STATUS badge; `label` defaults to the status word. */
export function TargetStatusBadge(props: {
  readonly status: TargetStatus;
  readonly label?: ReactNode;
  readonly size?: StatusBadgeSize;
}): ReactElement {
  const s = TARGET_STATUS[props.status];
  return (
    <StatusBadge
      tone={s.tone}
      icon={s.icon}
      label={props.label ?? s.label}
      size={props.size ?? "sm"}
      data-status={props.status}
      {...(s.variant !== undefined ? { variant: s.variant } : {})}
    />
  );
}

/** An ALERT_SEVERITY badge; `label` defaults to the severity word. */
export function SeverityBadge(props: {
  readonly severity: AlertSeverity;
  readonly label?: ReactNode;
  readonly size?: StatusBadgeSize;
}): ReactElement {
  const s = ALERT_SEVERITY[props.severity];
  return (
    <StatusBadge
      tone={s.tone}
      icon={s.icon}
      label={props.label ?? s.label}
      size={props.size ?? "sm"}
      data-severity={props.severity}
      {...(s.variant !== undefined ? { variant: s.variant } : {})}
    />
  );
}
