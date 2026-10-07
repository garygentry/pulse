import { useCallback, useMemo, useState } from "react";
import {
  applyFilters,
  countActiveCriteria,
  emptyCriteria,
  hasActiveCriteria,
  removeActiveFilter,
  toggleValue,
  type ActiveFilter,
  type FilterAccessors,
  type FilterCriteria,
  type FilterResult,
} from "@/ui/lib/filters";

export interface UseFacetFiltersOptions<F extends string> {
  /** Every facet key; each starts (and clears) to an empty selection. */
  readonly facets: readonly F[];
  /** Uncontrolled initial state. */
  readonly initialQuery?: string;
  readonly initialFacets?: Partial<Record<F, Iterable<string>>>;
  /** Controlled state (e.g. page- or URL-owned). Pass with `onCriteriaChange`. */
  readonly criteria?: FilterCriteria<F>;
  readonly onCriteriaChange?: (next: FilterCriteria<F>) => void;
}

export interface FacetFiltersState<F extends string> {
  readonly criteria: FilterCriteria<F>;
  readonly query: string;
  readonly setQuery: (query: string) => void;
  /** Selected values of one facet. */
  readonly selected: (facet: F) => ReadonlySet<string>;
  readonly isSelected: (facet: F, value: string) => boolean;
  readonly toggle: (facet: F, value: string) => void;
  /** Replace one facet's selection. */
  readonly setFacet: (facet: F, values: Iterable<string>) => void;
  /** Clear one facet's selection. */
  readonly clear: (facet: F) => void;
  /** Clear the query and every facet. */
  readonly clearAll: () => void;
  /** Remove the criterion one `ActiveFilters` chip stands for. */
  readonly remove: (filter: Pick<ActiveFilter<F>, "facet" | "value">) => void;
  /** Any criterion set (a non-blank query or any selected value). */
  readonly isActive: boolean;
  /** Non-blank query (1) plus each selected value. */
  readonly activeCount: number;
  /** `applyFilters` bound to the current criteria. */
  readonly apply: <T>(items: readonly T[], accessors: FilterAccessors<T, F>) => FilterResult<T>;
}

function initialCriteria<F extends string>(options: UseFacetFiltersOptions<F>): FilterCriteria<F> {
  const base = emptyCriteria(options.facets);
  const facets: Record<F, ReadonlySet<string>> = { ...base.facets };
  for (const key of options.facets) {
    const initial = options.initialFacets?.[key];
    if (initial) facets[key] = new Set(initial);
  }
  return { query: options.initialQuery ?? "", facets };
}

/**
 * Filter state in the shared `{ query, facets }` shape, with the toggle/clear
 * helpers every filter bar needs. Uncontrolled by default; pass `criteria` and
 * `onCriteriaChange` to control it.
 */
export function useFacetFilters<F extends string>(
  options: UseFacetFiltersOptions<F>,
): FacetFiltersState<F> {
  const [internal, setInternal] = useState<FilterCriteria<F>>(() => initialCriteria(options));
  const controlled = options.criteria !== undefined;
  const criteria = options.criteria ?? internal;
  const { onCriteriaChange } = options;
  const facetKeys = options.facets;

  const update = useCallback(
    (next: FilterCriteria<F>) => {
      if (!controlled) setInternal(next);
      onCriteriaChange?.(next);
    },
    [controlled, onCriteriaChange],
  );

  const selected = useCallback(
    (facet: F): ReadonlySet<string> => criteria.facets[facet] ?? new Set<string>(),
    [criteria],
  );

  return useMemo<FacetFiltersState<F>>(
    () => ({
      criteria,
      query: criteria.query,
      setQuery: (query) => update({ ...criteria, query }),
      selected,
      isSelected: (facet, value) => selected(facet).has(value),
      toggle: (facet, value) =>
        update({
          ...criteria,
          facets: { ...criteria.facets, [facet]: toggleValue(selected(facet), value) },
        }),
      setFacet: (facet, values) =>
        update({ ...criteria, facets: { ...criteria.facets, [facet]: new Set(values) } }),
      clear: (facet) =>
        update({ ...criteria, facets: { ...criteria.facets, [facet]: new Set<string>() } }),
      clearAll: () => update(emptyCriteria(facetKeys)),
      remove: (filter) => update(removeActiveFilter(criteria, filter)),
      isActive: hasActiveCriteria(criteria),
      activeCount: countActiveCriteria(criteria),
      apply: (items, accessors) => applyFilters(items, criteria, accessors),
    }),
    [criteria, facetKeys, selected, update],
  );
}
