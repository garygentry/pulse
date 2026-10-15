import type * as React from "react";
import { cn } from "@/ui/lib/utils";

export interface FilterBarProps extends Omit<React.ComponentProps<"div">, "role"> {
  /** Accessible name of the search landmark ("Host filters"). */
  label: string;
  /** Usually a `SearchInput`. */
  search?: React.ReactNode;
  /** Facet controls (`FacetFilter`s, toggles), laid out inline after the search. */
  children?: React.ReactNode;
  /** Usually `ActiveFilters`; shown on the row below. */
  activeFilters?: React.ReactNode;
  /** Usually `ResultCount`; right-aligned on the row below. */
  resultCount?: React.ReactNode;
}

/**
 * A `role="search"` landmark: the search field and facet controls on one row,
 * active-filter chips and the result count below. Wraps on narrow screens.
 */
export function FilterBar({
  label,
  search,
  children,
  activeFilters,
  resultCount,
  className,
  ...props
}: FilterBarProps) {
  const hasSecondRow = Boolean(activeFilters) || Boolean(resultCount);
  return (
    <div
      data-slot="filter-bar"
      role="search"
      aria-label={label}
      className={cn("flex w-full flex-col gap-2", className)}
      {...props}
    >
      <div className="flex flex-wrap items-end gap-2">
        {search ? <div className="min-w-48 flex-1 sm:max-w-sm">{search}</div> : null}
        {children}
      </div>
      {hasSecondRow ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0 flex-1">{activeFilters}</div>
          {resultCount ? <div className="min-w-0 sm:ml-auto">{resultCount}</div> : null}
        </div>
      ) : null}
    </div>
  );
}
