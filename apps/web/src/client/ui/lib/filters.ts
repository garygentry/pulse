/**
 * The shared filter-criteria shape and its generic, pure application.
 *
 * Criteria are a free-text `query` plus named multi-select `facets` (each a set
 * of selected values; an empty set means "no constraint"). Features keep their
 * own domain predicates: they describe how to read an item through
 * `FilterAccessors`, and may add a `where` predicate for anything that is not a
 * text or facet match (e.g. "exclude hidden").
 */

/** A free-text query plus a set of selected values per facet key. */
export interface FilterCriteria<F extends string = string> {
  readonly query: string;
  readonly facets: Readonly<Record<F, ReadonlySet<string>>>;
}

/** The value(s) an item has for one facet. `null`/`undefined`/`[]` = none. */
export type FacetValue = string | readonly string[] | null | undefined;

/** How `applyFilters` reads an item. Facets without an accessor are not applied. */
export interface FilterAccessors<T, F extends string = string> {
  /** Fields the query is matched against (case-insensitive substring). */
  readonly text?: (item: T) => readonly (string | null | undefined)[];
  /** A domain query predicate; overrides `text`. Receives the normalized query (never ""). */
  readonly matchQuery?: (item: T, normalizedQuery: string) => boolean;
  /** Per facet: the item's value(s). An item with none never matches a non-empty selection. */
  readonly facets?: { readonly [K in F]?: (item: T) => FacetValue };
  /** An extra domain predicate, applied after the query and facets. */
  readonly where?: (item: T, criteria: FilterCriteria<F>) => boolean;
}

/** The surviving items in input order, with the counts a `ResultCount` shows. */
export interface FilterResult<T> {
  readonly rows: readonly T[];
  readonly total: number;
  readonly hidden: number;
}

/** One active criterion, as a removable chip. `facet` is undefined for the query. */
export interface ActiveFilter<F extends string = string> {
  /** Stable React key. */
  readonly id: string;
  readonly facet?: F;
  /** Lower-case facet noun used in the chip's accessible name ("status", "search"). */
  readonly facetLabel: string;
  readonly value: string;
  /** Visible chip text. */
  readonly label: string;
}

/** Normalize free text once for case-insensitive substring matching. */
export function normalizeQuery(query: string): string {
  return query.trim().toLocaleLowerCase("en-US");
}

/** Criteria with an empty query and an empty selection for every listed facet. */
export function emptyCriteria<F extends string>(facetKeys: readonly F[]): FilterCriteria<F> {
  const facets = {} as Record<F, ReadonlySet<string>>;
  for (const key of facetKeys) facets[key] = new Set<string>();
  return { query: "", facets };
}

/** Toggle one value in a copy of `set` (the source is never mutated). */
export function toggleValue<V>(set: ReadonlySet<V>, value: V): Set<V> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

/** True when the query is non-blank or any facet has a selection. */
export function hasActiveCriteria(criteria: FilterCriteria<string>): boolean {
  if (normalizeQuery(criteria.query) !== "") return true;
  return Object.values<ReadonlySet<string>>(criteria.facets).some((set) => set.size > 0);
}

/** Number of active criteria: one for a non-blank query plus each selected facet value. */
export function countActiveCriteria(criteria: FilterCriteria<string>): number {
  let count = normalizeQuery(criteria.query) === "" ? 0 : 1;
  for (const set of Object.values<ReadonlySet<string>>(criteria.facets)) count += set.size;
  return count;
}

function valuesOf(value: FacetValue): readonly string[] {
  if (value == null) return [];
  return typeof value === "string" ? [value] : value;
}

function matchesText(fields: readonly (string | null | undefined)[], needle: string): boolean {
  for (const field of fields) {
    if (field != null && normalizeQuery(field).includes(needle)) return true;
  }
  return false;
}

/** True when one item satisfies every active criterion. */
export function matchesCriteria<T, F extends string>(
  item: T,
  criteria: FilterCriteria<F>,
  accessors: FilterAccessors<T, F>,
): boolean {
  const needle = normalizeQuery(criteria.query);
  if (needle !== "") {
    if (accessors.matchQuery) {
      if (!accessors.matchQuery(item, needle)) return false;
    } else if (accessors.text && !matchesText(accessors.text(item), needle)) {
      return false;
    }
  }
  for (const key of Object.keys(criteria.facets) as F[]) {
    const selected = criteria.facets[key];
    const read = accessors.facets?.[key];
    if (selected.size === 0 || !read) continue;
    if (!valuesOf(read(item)).some((value) => selected.has(value))) return false;
  }
  return accessors.where ? accessors.where(item, criteria) : true;
}

/**
 * Filter `items` by `criteria`: stable order, O(n), pure. Within a facet the
 * selected values are OR-ed; across the query, facets and `where` they are AND-ed.
 */
export function applyFilters<T, F extends string>(
  items: readonly T[],
  criteria: FilterCriteria<F>,
  accessors: FilterAccessors<T, F>,
): FilterResult<T> {
  const rows = items.filter((item) => matchesCriteria(item, criteria, accessors));
  return { rows, total: items.length, hidden: items.length - rows.length };
}

/** How many items carry each value of one facet (for `FacetFilter` option counts). */
export function facetCounts<T>(
  items: readonly T[],
  read: (item: T) => FacetValue,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    for (const value of new Set(valuesOf(read(item)))) {
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
  }
  return counts;
}

/** Labels used to describe criteria as `ActiveFilter` chips. */
export interface DescribeOptions<F extends string> {
  /** Lower-case noun per facet ("status"); defaults to the facet key. */
  readonly facetLabels?: Partial<Record<F, string>>;
  /** Visible text for one selected value; defaults to the value. */
  readonly valueLabel?: (facet: F, value: string) => string;
  /** Noun for the query chip; defaults to "search". */
  readonly queryLabel?: string;
}

/** The active criteria as ordered chips: the query first, then facets in key order. */
export function describeActiveFilters<F extends string>(
  criteria: FilterCriteria<F>,
  options: DescribeOptions<F> = {},
): ActiveFilter<F>[] {
  const chips: ActiveFilter<F>[] = [];
  const query = criteria.query.trim();
  if (query !== "") {
    chips.push({ id: "query", facetLabel: options.queryLabel ?? "search", value: query, label: query });
  }
  for (const facet of Object.keys(criteria.facets) as F[]) {
    for (const value of criteria.facets[facet]) {
      chips.push({
        id: `${facet}:${value}`,
        facet,
        facetLabel: options.facetLabels?.[facet] ?? facet,
        value,
        label: options.valueLabel ? options.valueLabel(facet, value) : value,
      });
    }
  }
  return chips;
}

/** Criteria with one chip's criterion removed (the query chip clears the query). */
export function removeActiveFilter<F extends string>(
  criteria: FilterCriteria<F>,
  filter: Pick<ActiveFilter<F>, "facet" | "value">,
): FilterCriteria<F> {
  if (filter.facet === undefined) return { ...criteria, query: "" };
  const current = criteria.facets[filter.facet];
  if (!current?.has(filter.value)) return criteria;
  const next = new Set(current);
  next.delete(filter.value);
  return { ...criteria, facets: { ...criteria.facets, [filter.facet]: next } };
}
