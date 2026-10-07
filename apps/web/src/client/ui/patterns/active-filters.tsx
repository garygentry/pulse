import type { ActiveFilter } from "@/ui/lib/filters";
import { cn } from "@/ui/lib/utils";
import { Icon } from "@/ui/patterns/icon";
import { Button } from "@/ui/primitives/button";

export interface ActiveFiltersProps<F extends string = string> {
  /** The active criteria, e.g. from `describeActiveFilters`. Renders nothing when empty. */
  filters: readonly ActiveFilter<F>[];
  onRemove: (filter: ActiveFilter<F>) => void;
  /** Omit to hide the "Clear all" button. */
  onClearAll?: () => void;
  clearAllLabel?: string;
  /** Accessible name of the chip group. */
  label?: string;
  className?: string;
}

/**
 * The active criteria as removable chips, each a button named
 * "Remove {facet} filter {value}", plus a "Clear all" button.
 */
export function ActiveFilters<F extends string = string>({
  filters,
  onRemove,
  onClearAll,
  clearAllLabel = "Clear all",
  label = "Active filters",
  className,
}: ActiveFiltersProps<F>) {
  if (filters.length === 0) return null;
  return (
    <div
      data-slot="active-filters"
      role="group"
      aria-label={label}
      className={cn("flex flex-wrap items-center gap-1.5", className)}
    >
      {filters.map((filter) => (
        <button
          key={filter.id}
          type="button"
          aria-label={`Remove ${filter.facetLabel} filter ${filter.label}`}
          onClick={() => onRemove(filter)}
          className="inline-flex h-6 max-w-64 items-center gap-1 rounded-full border border-border bg-secondary py-0.5 pr-1.5 pl-2.5 text-xs font-medium text-secondary-foreground outline-none hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <span className="text-muted-foreground">{filter.facetLabel}:</span>
          <span className="truncate">{filter.label}</span>
          <Icon name="x" size={12} />
        </button>
      ))}
      {onClearAll ? (
        <Button variant="ghost" size="xs" onClick={onClearAll}>
          {clearAllLabel}
        </Button>
      ) : null}
    </div>
  );
}
