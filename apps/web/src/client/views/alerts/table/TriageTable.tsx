// src/client/views/alerts/table/TriageTable.tsx — the virtualized firing triage table.
//
// A DataTable<ActiveAlert> that virtualizes at the default 300-row threshold. Row-open is a
// delegated click on the container reading the nearest [data-triage-open] fingerprint, not a
// `rowLink` href: opening merges `sel` into the CURRENT query (facets, tab, kiosk), which a static
// per-row href cannot express. No per-row fetch of any kind.
import type { RefObject, ReactElement, MouseEvent as ReactMouseEvent } from "react";
import type { Signal } from "@preact/signals-core";

import { DATA_TABLE_VIRTUALIZE_DEFAULTS, DataTable, EmptyState } from "@/ui";
import type { DataTableHandle } from "@/ui";
import type { ActiveAlert } from "@pulse/web-data/wire";
import { triageColumns } from "./columns.js";

/** Fixed row height of the virtualized triage table (the compact DataTable row). Exported so tests
 *  and the keyboard loop agree with the value passed to `virtualize.rowHeight`. */
export const TRIAGE_ROW_HEIGHT: number = DATA_TABLE_VIRTUALIZE_DEFAULTS.rowHeight.compact;

export interface TriageTableProps {
  /** Facet-filtered firing rows, in the data tier's order. Never re-sorted. */
  readonly rows: readonly ActiveAlert[];
  /** Keyboard cursor into `rows`. Rendering does not depend on it; focus does. */
  readonly selectedIndex: Signal<number>;
  /** Open the alert's detail pane (sets ?sel=<fingerprint>) — passed from view.tsx. */
  readonly onOpenAlert: (fingerprint: string) => void;
  /** True iff BOTH alertmanager and vmalert are state==="current" — gates the empty state. */
  readonly sourcesCurrent: boolean;
  /** True when alerts are firing but the active facets exclude every one of them: the empty table
   *  then says "no match", never the estate-wide all-clear. Optional; defaults to false. */
  readonly filtersExcludeAll?: boolean;
  /** Container ref for click delegation and keyboard focus queries. */
  readonly containerRef: RefObject<HTMLDivElement | null>;
  /** The DataTable handle (`scrollToIndex`) the keyboard loop drives. */
  readonly tableRef?: RefObject<DataTableHandle | null>;
}

/** The firing triage table, or a distinct empty state: "No alerts match these filters" (alerts are
 *  firing but filtered out), "No firing alerts" (all-clear, both sources current), or a non-committal
 *  "Firing alerts unavailable" (a source degraded — never silent-green). */
export function TriageTable(props: TriageTableProps): ReactElement {
  if (props.rows.length === 0) {
    return (
      <div ref={props.containerRef} data-triage-table="" className="min-w-0">
        {props.filtersExcludeAll === true ? (
          <EmptyState
            icon="search"
            title="No alerts match these filters"
            description="Clear a filter chip above to see all firing alerts."
          />
        ) : props.sourcesCurrent ? (
          <EmptyState icon="bell" title="No firing alerts" description="All monitored targets are healthy." />
        ) : (
          <EmptyState
            icon="wifi-off"
            title="Firing alerts unavailable"
            description="A data source is degraded — see the status notice above. This is not an all-clear."
          />
        )}
      </div>
    );
  }

  const onClick = (event: ReactMouseEvent): void => {
    const target = event.target as Element | null;
    const el = typeof target?.closest === "function" ? target.closest("[data-triage-open]") : null;
    const fp = el?.getAttribute("data-triage-open");
    if (fp !== null && fp !== undefined && fp !== "") props.onOpenAlert(fp);
  };

  return (
    // Delegated click target only; the row-open controls inside are native buttons.
    <div ref={props.containerRef} data-triage-table="" className="min-w-0" onClick={onClick}>
      <DataTable<ActiveAlert>
        {...(props.tableRef !== undefined ? { ref: props.tableRef } : {})}
        caption="Firing alerts"
        captionHidden
        columns={triageColumns}
        data={props.rows}
        getRowId={(a) => a.fingerprint}
        rowHeader={false}
        virtualize={{ rowHeight: TRIAGE_ROW_HEIGHT }}
        className="max-h-[70vh]"
      />
    </div>
  );
}
