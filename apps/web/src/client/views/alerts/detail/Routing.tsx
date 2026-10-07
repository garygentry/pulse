// src/client/views/alerts/detail/Routing.tsx — read-only routing explanation.
//
// INTENDED (vendored taxonomy policy for the severity) rendered alongside ACTUAL (the receivers
// Alertmanager matched). Reconciliation is presentational — the taxonomy has no receiver names. No
// controls, no fetch, no throw: a pure function of alert.severity + alert.receivers.
import type { ReactElement } from "react";

import { Badge, KeyValueList, Section } from "@/ui";
import type { ActiveAlert } from "@pulse/web-data/wire";
import { explainRouting } from "../routing-explain.js";

/** Read-only routing explanation: taxonomy policy for the severity, reconciled with actual receivers. */
export function Routing(props: { alert: ActiveAlert }): ReactElement {
  const intent = explainRouting(props.alert.severity);
  const receivers = props.alert.receivers;

  return (
    <Section level={3} title="Routing" data-section="routing">
      {intent.matched && intent.routing !== null ? (
        <KeyValueList
          data-routing="intent"
          items={[
            { label: "Severity policy", value: intent.response },
            { label: "Channels", value: intent.routing.channels },
            { label: "Repeat interval", value: intent.routing.repeatInterval ?? "—" },
            { label: "Group window", value: intent.routing.groupWindow ?? "—" },
            { label: "Bypasses quiet hours", value: intent.routing.bypassesQuietHours ? "yes" : "no" },
            { label: "Sends resolved", value: intent.routing.sendsResolved ? "yes" : "no" },
            { label: "Webhook mirror", value: intent.webhookMirror ?? "—" },
          ]}
        />
      ) : (
        <p className="text-sm text-muted-foreground" data-routing="unmatched">
          No routing policy defined for severity <code>{intent.severity}</code> in the vendored
          taxonomy (contract v{intent.contractVersion}).
        </p>
      )}

      {/* ACTUAL — the receivers Alertmanager actually matched; empty is a routing-gap cue. */}
      <div className="flex flex-wrap items-center gap-2 text-sm" role="group" aria-label="Actual receivers">
        {receivers.length > 0 ? (
          receivers.map((r) => (
            <Badge key={r} variant="secondary">{r}</Badge>
          ))
        ) : (
          <span className="text-muted-foreground" data-routing="no-receivers">No receivers matched</span>
        )}
      </div>
    </Section>
  );
}
