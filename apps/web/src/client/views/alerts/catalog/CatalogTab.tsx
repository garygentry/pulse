// views/alerts/catalog/CatalogTab.tsx — the read-only alert-catalog tab.
//
// A pure prop-driven renderer over `AlertsPayload.rules`: one row per RuleState, in the data tier's
// group/family -> name order, passed verbatim to a DataTable. No reordering, no row removal, no
// links/buttons/mutation, no global state reads.
import type { ReactElement } from "react";

import type { RuleState } from "@pulse/web-data/wire";
import { Badge, DataTable, EmptyState, StatusBadge, TARGET_STATUS } from "@/ui";
import type { ColumnDef } from "@/ui";
import { ruleHealthStatus } from "./catalog-model.js";

/** Props for {@link CatalogTab}. The slice is `AlertsPayload.rules`, passed by view.tsx in the data
 *  tier's group/family -> name order. This component never reorders it. */
export interface CatalogTabProps {
  /** Every vmalert rule the data tier projected — incl. inactive and deadman/canary rules. Rendered
   *  one row per element, in received order. */
  readonly rules: readonly RuleState[];
}

/** Placeholder for a null timestamp / missing value. */
const EMPTY_CELL = "—";

/** One catalog column: a DataTable ColumnDef with a stable id. */
export type CatalogColumn = ColumnDef<RuleState> & { readonly id: string };

/** The catalog table columns. Each maps directly to a `RuleState` field; column order is a display
 *  choice, ROW order is the data tier's and is not set here. Read-only: no column links or mutates. */
export const CATALOG_COLUMNS: CatalogColumn[] = [
  {
    id: "name",
    header: "Rule",
    // Deadman/canary rules are listed and annotated with a neutral Badge so an operator can see why
    // a rule is absent from the firing list.
    cell: ({ row }) => (
      <span className="inline-flex flex-wrap items-center gap-1">
        <span className="font-medium" data-catalog-rule="">
          {row.original.name}
        </span>
        {row.original.deadman ? (
          <Badge variant="outline" data-catalog-deadman="">
            deadman
          </Badge>
        ) : null}
      </span>
    ),
  },
  { id: "group", header: "Group", cell: ({ row }) => row.original.group },
  { id: "family", header: "Family", cell: ({ row }) => row.original.family },
  // Bounded upstream state string (e.g. "firing" | "inactive" | "pending"); rendered verbatim.
  { id: "state", header: "State", cell: ({ row }) => row.original.state },
  {
    id: "health",
    header: "Health",
    cell: ({ row }) => healthCell(row.original),
  },
  {
    id: "lastEval",
    header: "Last evaluation",
    // UTC ISO-8601 string or null → "—".
    cell: ({ row }) => row.original.lastEvaluationAt ?? EMPTY_CELL,
  },
];

/** Health → StatusBadge labelled with the rule's own health word. On `unhealthy`, a non-null
 *  `lastError` is shown beneath it (truncated; `title` carries the full text). */
function healthCell(r: RuleState): ReactElement {
  const status = ruleHealthStatus(r.health);
  const presentation = TARGET_STATUS[status];
  return (
    <span className="flex min-w-0 flex-col gap-1">
      <StatusBadge
        tone={presentation.tone}
        icon={presentation.icon}
        label={r.health}
        {...(presentation.variant !== undefined ? { variant: presentation.variant } : {})}
        data-status={status}
      />
      {r.health === "unhealthy" && r.lastError !== null ? (
        <span
          className="block max-w-80 truncate font-mono text-xs text-muted-foreground"
          title={r.lastError}
          data-catalog-error=""
        >
          {r.lastError}
        </span>
      ) : null}
    </span>
  );
}

/**
 * Every vmalert rule, one row per `RuleState`, in the data tier's group/family -> name order.
 * Read-only. Renders a catalog-specific `EmptyState` when the slice is empty. The tabpanel wrapper is
 * view.tsx's; this component renders the panel content only.
 */
export function CatalogTab({ rules }: CatalogTabProps): ReactElement {
  if (rules.length === 0) {
    return <EmptyState icon="list" title="No rules" description="No vmalert rules were reported." />;
  }
  // Rows passed verbatim — the data tier's order is trusted.
  return (
    <DataTable<RuleState>
      caption="Alert rules"
      captionHidden
      columns={CATALOG_COLUMNS}
      data={rules}
      getRowId={(r, index) => `${r.group}\u0000${r.name}\u0000${index}`}
      virtualize
      className="max-h-[70vh]"
    />
  );
}
