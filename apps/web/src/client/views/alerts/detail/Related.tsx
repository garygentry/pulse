// src/client/views/alerts/detail/Related.tsx — related alerts on the same target.
//
// Other firing alerts whose TargetIdentity is EXACTLY equal to this alert's (relatedByTarget). A null
// target renders an explicit "No target" state — never a fuzzy label-based guess. Unbounded.
import type { ReactElement } from "react";

import { ALERT_SEVERITY, Button, EmptyState, List, Section, StatusBadge, TARGET_STATUS, alertSeverityOf } from "@/ui";
import type { ActiveAlert, AlertsPayload } from "@pulse/web-data/wire";
import { relatedByTarget } from "../model.js";
import { stateToStatus } from "../../../status/target-status.js";

/** One related alert: a full-width row button with its status badge and name. A firing alert's badge
 *  takes its severity's presentation (info → info tone); a silenced/inhibited one stays suppressed. */
function RelatedRow(props: { alert: ActiveAlert; onSelect?: (fingerprint: string) => void }): ReactElement {
  const a = props.alert;
  const severity = alertSeverityOf(a.severity);
  const firing = a.state === "firing";
  const status = firing ? severity : stateToStatus(a.state, a.severity);
  const presentation = firing ? ALERT_SEVERITY[severity] : TARGET_STATUS[stateToStatus(a.state, a.severity)];
  return (
    <li>
      <Button
        type="button"
        variant="ghost"
        className="h-auto min-h-11 w-full justify-start gap-2 text-left whitespace-normal"
        data-related={a.fingerprint}
        onClick={() => props.onSelect?.(a.fingerprint)}
      >
        <StatusBadge
          tone={presentation.tone}
          icon={presentation.icon}
          label={a.severity}
          {...(presentation.variant !== undefined ? { variant: presentation.variant } : {})}
          data-status={status}
          data-severity={a.severity}
        />
        <span className="min-w-0 break-words">{a.name}</span>
      </Button>
    </li>
  );
}

/** Related firing alerts on the exact same TargetIdentity. */
export function Related(props: {
  payload: AlertsPayload | null;
  alert: ActiveAlert;
  /** Switch the open alert to a related one (wired by view.tsx to navigate ?sel=<fingerprint>). */
  onSelect?: (fingerprint: string) => void;
}): ReactElement {
  let body: ReactElement;
  if (props.alert.target === null) {
    body = (
      <EmptyState
        compact
        icon="info"
        title="No target"
        description="This alert is not attributed to a host, service, or endpoint, so it has no related alerts."
      />
    );
  } else {
    const all = props.payload ? relatedByTarget(props.payload, props.alert.target) : [];
    // relatedByTarget includes self when it is firing — exclude it by fingerprint.
    const related = all.filter((a) => a.fingerprint !== props.alert.fingerprint);
    body =
      related.length === 0 ? (
        <EmptyState compact icon="info" title="No related alerts" description="No other alerts are firing on this target." />
      ) : (
        <List aria-label="Related alerts">
          {related.map((a) => (
            <RelatedRow key={a.fingerprint} alert={a} {...(props.onSelect !== undefined ? { onSelect: props.onSelect } : {})} />
          ))}
        </List>
      );
  }

  return (
    <Section level={3} title="Related alerts on this target" data-section="related">
      {body}
    </Section>
  );
}
