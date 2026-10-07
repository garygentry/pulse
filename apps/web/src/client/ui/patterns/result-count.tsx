import { cn } from "@/ui/lib/utils";

export interface ResultCountProps {
  /** Items shown after filtering. */
  shown: number;
  /** Items before filtering. */
  total: number;
  /** Plural noun appended to the total ("hosts"). */
  noun?: string;
  className?: string;
}

/**
 * "Showing X of Y; Z hidden by filters." — a polite live region, so screen
 * readers hear the new count as filters change.
 */
export function ResultCount({ shown, total, noun, className }: ResultCountProps) {
  const hidden = Math.max(0, total - shown);
  return (
    <p
      data-slot="result-count"
      role="status"
      aria-live="polite"
      className={cn("text-sm text-muted-foreground tabular-nums", className)}
    >
      Showing {shown} of {total}
      {noun ? ` ${noun}` : ""}; {hidden} hidden by filters.
    </p>
  );
}
