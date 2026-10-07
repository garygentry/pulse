// src/client/views/alerts/table/columns.tsx — firing triage table column defs + cell renderers.
//
// Every cell renders from fields already on the `ActiveAlert` row plus pure client helpers — no
// per-row fetch. Cell renderers are plain functions (DataTable calls them without mounting, so no
// hooks); StateBadge/PendingMarker are components rendered from the cell. Status cells are
// StatusBadges (icon + text label + data-status, never colour alone).
import type { ReactElement } from "react";

import { ALERT_SEVERITY, Button, StatusBadge, TARGET_STATUS, alertSeverityOf } from "@/ui";
import type { ColumnDef } from "@/ui";
import type { ActiveAlert } from "@pulse/web-data/wire";
import { formatAge, formatTarget, summaryText } from "./columns-model.js";
import { PendingMarker, StateBadge } from "../../../mutations/StateBadge.js";
import { stateToStatus } from "../../../status/target-status.js";

/** One firing-table column: a DataTable ColumnDef with a stable id. */
export type TriageColumn = ColumnDef<ActiveAlert> & { readonly id: string };

/** The firing table columns, in order: severity, name, target, age, summary, receivers, state.
 *  A plain const — the open callback is delivered via `data-triage-open` + the TriageTable
 *  container's delegated click. */
export const triageColumns: TriageColumn[] = [
  { id: "severity", header: "Severity", cell: ({ row }) => severityCell(row.original) },
  { id: "name", header: "Alert", cell: ({ row }) => nameCell(row.original) },
  { id: "target", header: "Target", cell: ({ row }) => formatTarget(row.original.target) },
  { id: "age", header: "Age", cell: ({ row }) => formatAge(row.original.startsAt) },
  {
    id: "summary",
    header: "Summary",
    cell: ({ row }) => summaryText(row.original),
    meta: { className: "max-w-96 truncate" },
  },
  {
    id: "receivers",
    header: "Receivers",
    cell: ({ row }) => (row.original.receivers.length === 0 ? "—" : row.original.receivers.join(", ")),
  },
  { id: "state", header: "State", cell: ({ row }) => stateCell(row.original) },
];

/** Focusable, clickable row-open control. `data-triage-open` carries the fingerprint for
 *  TriageTable's delegated click and for the keyboard focus target. */
function nameCell(a: ActiveAlert): ReactElement {
  return (
    <Button
      type="button"
      variant="link"
      className="h-auto p-0 font-medium text-foreground underline decoration-border underline-offset-4 hover:decoration-current"
      data-triage-open={a.fingerprint}
    >
      {a.name}
    </Button>
  );
}

/** Severity → StatusBadge from ALERT_SEVERITY; the label is the raw wire severity word. */
function severityCell(a: ActiveAlert): ReactElement {
  const severity = alertSeverityOf(a.severity);
  const presentation = ALERT_SEVERITY[severity];
  return (
    <StatusBadge
      tone={presentation.tone}
      icon={presentation.icon}
      label={a.severity}
      data-status={severity}
      data-severity={a.severity}
    />
  );
}

/** Suppression state → marked, NEVER hidden. silenced/inhibited map to "suppressed" and carry a
 *  `bell` marker icon; the label is the literal AM state word. An acked alert adds a read-only
 *  'Acked' badge and the pending tracker's marker follows. */
function stateCell(a: ActiveAlert): ReactElement {
  const status = stateToStatus(a.state, a.severity);
  const suppressed = a.state !== "firing";
  // A firing alert takes its severity's presentation (info → info tone); suppressed stays suppressed.
  const presentation = suppressed ? TARGET_STATUS[status] : ALERT_SEVERITY[alertSeverityOf(a.severity)];
  return (
    <span className="inline-flex items-center gap-2 whitespace-nowrap">
      <StatusBadge
        tone={presentation.tone}
        icon={suppressed ? "bell" : presentation.icon}
        label={a.state}
        {...(presentation.variant !== undefined ? { variant: presentation.variant } : {})}
        data-status={status}
        {...(suppressed ? { "data-suppressed": "" } : {})}
      />
      {a.ack !== undefined ? <StateBadge state="acked" label="Acked" /> : null}
      <PendingMarker target={{ kind: "alert", fingerprint: a.fingerprint }} />
    </span>
  );
}
