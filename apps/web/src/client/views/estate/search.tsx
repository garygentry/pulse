// src/client/views/estate/search.tsx — query-synced search box + in-memory filter (spec 06 §4).
//
// `filterEstate` is a pure, single-linear-pass, case-insensitive substring match over the loaded
// model — no index infrastructure (REQ-SCALE-01/PERF-01). `SearchBox` is a controlled, dumb input:
// it holds no query state and performs no navigation; the landing owns the `?q=` write (01 §6).

import type { ReactElement } from "react";
import { useMemo } from "react";
import type { WebEstateModelV2 } from "@pulse/renderer";
import { FilterBar, SearchInput } from "@/ui";
import type { EstateQuery } from "./types.js";
import { filterEstate } from "./search-model.js";
import type { FilteredEstate } from "./search-model.js";

/**
 * Memoized {@link filterEstate} keyed on `(model identity, query)` (06 §4.4). A null model (no
 * payload yet) yields null so callers can gate on delivery without branching around the hook.
 */
export function useFilteredEstate(
  model: WebEstateModelV2 | null,
  query: EstateQuery["q"],
): FilteredEstate | null {
  return useMemo(() => (model ? filterEstate(model, query) : null), [model, query]);
}

/** Props for {@link SearchBox}. Controlled: `value` in, every change out via `onQueryChange`. */
export interface SearchBoxProps {
  /** Current query, sourced from `?q=` (`EstateQuery.q`, 00 §7). */
  readonly value: EstateQuery["q"];
  /** Fired on each input change with the new raw query string. */
  readonly onQueryChange: (next: string) => void;
  /** Number of matched entities, shown as a polite live result summary. Optional. */
  readonly resultCount?: number;
  /** Accessible label for the input. Default "Search estate". */
  readonly "aria-label"?: string;
}

/**
 * The estate search box: a `@/ui` `SearchInput` inside a `role="search"` FilterBar, with a polite
 * live match count. Holds no query state and performs no navigation — the landing filters via
 * {@link filterEstate} and writes `?q=` through `router.navigate` (01 §6).
 */
export function SearchBox({
  value,
  onQueryChange,
  resultCount,
  "aria-label": ariaLabel = "Search estate",
}: SearchBoxProps): ReactElement {
  return (
    <FilterBar label="Estate search" className="w-full min-w-0 sm:w-auto">
      <SearchInput
        label={ariaLabel}
        aria-label={ariaLabel}
        value={value}
        onValueChange={onQueryChange}
        rootClassName="min-w-0 flex-1 sm:w-64 sm:flex-none"
      />
      {resultCount !== undefined && value.trim() !== "" ? (
        // aria-live so filtering announces its result count without moving focus.
        <span className="self-center text-xs whitespace-nowrap text-muted-foreground" role="status" aria-live="polite">
          {resultCount} match{resultCount === 1 ? "" : "es"}
        </span>
      ) : null}
    </FilterBar>
  );
}
