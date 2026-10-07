// src/client/views/alerts/facet-bar.tsx — the firing-tab filter bar.
//
// Presentational: receives the distinct values (`facetValues`) and the current selection (decoded
// from the URL), and reports a NEW selection via onChange; the caller (view.tsx) encodes +
// navigates. Reads no store/router and holds no selection state — the URL is the single source of
// truth.
import type { ReactElement } from "react";

import { ActiveFilters, FacetFilter, FilterBar, ResultCount } from "@/ui";
import type { ActiveFilter, FacetOption } from "@/ui";
import type { FacetValues } from "./model.js";
import type { FacetKey, FacetSelection } from "./url-state.js";
import { FACET_DEFS } from "./facets.js";

export interface FacetBarProps {
  /** Distinct selectable values per facet, from `facetValues(payload)`. */
  readonly values: FacetValues;
  /** The current selection (decoded from the URL). */
  readonly selection: FacetSelection;
  /** Report a NEW selection; the caller encodes + navigates. Called once per change. */
  readonly onChange: (next: FacetSelection) => void;
  /** Firing alerts before filtering. */
  readonly total: number;
  /** Firing alerts the current selection shows. */
  readonly shown: number;
}

/** Option text for the ack facet; the URL value stays `acked|unacked`. */
const ACK_LABEL: Readonly<Record<string, string>> = { acked: "Acked", unacked: "Not acked" };

function valueLabel(key: FacetKey, value: string): string {
  return key === "ack" ? (ACK_LABEL[value] ?? value) : value;
}

/** Replace one facet's values, returning a new FacetSelection (immutable update). */
function withFacet(sel: FacetSelection, key: FacetKey, next: readonly string[]): FacetSelection {
  return { ...sel, [key]: next } as FacetSelection;
}

const EMPTY_SELECTION: FacetSelection = {
  severity: [],
  state: [],
  group: [],
  hostService: [],
  ruleFamily: [],
  ack: [],
};

/**
 * The faceted-filter bar: one FacetFilter per facet that has ≥1 value or selection (inline toggle
 * chips for ≤4 options, a popover multi-select otherwise), the active values as removable chips
 * with "Clear all", and the shown/total count.
 */
export function FacetBar({ values, selection, onChange, total, shown }: FacetBarProps): ReactElement {
  const active: ActiveFilter<FacetKey>[] = [];
  const filters: ReactElement[] = [];
  for (const def of FACET_DEFS) {
    const selected: readonly string[] = selection[def.key];
    // A selected value absent from the payload (hand-typed link, a target with no current alerts)
    // still renders as a selected option, so every active filter is visible and clearable.
    const options: FacetOption[] = [...new Set([...values[def.key], ...selected])].map((value) => ({
      value,
      label: valueLabel(def.key, value),
    }));
    for (const value of new Set(selected)) {
      active.push({ id: `${def.key}:${value}`, facet: def.key, facetLabel: def.label, value, label: valueLabel(def.key, value) });
    }
    if (options.length === 0) continue; // no values and no selection for this facet → no control
    filters.push(
      <FacetFilter
        key={def.key}
        title={def.label}
        options={options}
        selected={new Set(selected)}
        onSelectedChange={(next) => onChange(withFacet(selection, def.key, [...next]))}
      />,
    );
  }

  return (
    <FilterBar
      label="Alert filters"
      activeFilters={
        <ActiveFilters<FacetKey>
          filters={active}
          onRemove={(filter) => {
            if (filter.facet === undefined) return;
            onChange(withFacet(selection, filter.facet, selection[filter.facet].filter((v) => v !== filter.value)));
          }}
          onClearAll={() => onChange(EMPTY_SELECTION)}
        />
      }
      resultCount={<ResultCount shown={shown} total={total} noun="firing alerts" />}
    >
      {filters}
    </FilterBar>
  );
}
