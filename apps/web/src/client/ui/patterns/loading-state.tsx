import { useId } from "react";
import { cn } from "@/ui/lib/utils";
import { Skeleton } from "@/ui/primitives/skeleton";

export type LoadingPreset = "lines" | "table" | "cards" | "detail";

export interface LoadingStateProps {
  /** What is loading; the region's accessible name and visible text. */
  label?: string;
  /** Skeleton shape approximating the content that will replace it. */
  preset?: LoadingPreset;
  /** Row / line / card count for the preset (defaults: lines 3, table 5, cards 3, detail 4). */
  rows?: number;
  /** Keep the label for assistive tech only (visually hidden). */
  hideLabel?: boolean;
  className?: string;
}

// Fixed widths (no randomness) so the workbench and visual snapshots are stable.
const LINE_WIDTHS = ["w-full", "w-11/12", "w-4/5", "w-2/3", "w-3/4"] as const;
const DEFAULT_ROWS: Record<LoadingPreset, number> = { lines: 3, table: 5, cards: 3, detail: 4 };

/**
 * A loading placeholder: `role="status"` + `aria-busy`, named by its visible
 * "Loading…" text. The skeleton shapes are decorative (`aria-hidden`).
 */
export function LoadingState({
  label = "Loading…",
  preset = "lines",
  rows,
  hideLabel = false,
  className,
}: LoadingStateProps) {
  const labelId = `loading-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const count = Math.max(1, rows ?? DEFAULT_ROWS[preset]);

  return (
    <div
      data-slot="loading-state"
      data-preset={preset}
      role="status"
      aria-busy="true"
      aria-labelledby={labelId}
      className={cn("flex w-full flex-col gap-3", className)}
    >
      <span id={labelId} className={cn("text-sm text-muted-foreground", hideLabel && "sr-only")}>
        {label}
      </span>
      <div aria-hidden="true" className="w-full">
        <Skeletons preset={preset} count={count} />
      </div>
    </div>
  );
}

function Skeletons({ preset, count }: { preset: LoadingPreset; count: number }) {
  const indices = Array.from({ length: count }, (_, i) => i);
  switch (preset) {
    case "lines":
      return (
        <div className="flex flex-col gap-2">
          {indices.map((i) => (
            <Skeleton key={i} className={cn("h-4", LINE_WIDTHS[i % LINE_WIDTHS.length])} />
          ))}
        </div>
      );
    case "table":
      return (
        <div className="flex flex-col overflow-hidden rounded-lg border">
          <div className="flex gap-4 border-b bg-muted/50 px-3 py-3">
            {[0, 1, 2, 3].map((c) => (
              <Skeleton key={c} className="h-3 flex-1" />
            ))}
          </div>
          {indices.map((i) => (
            <div key={i} className="flex gap-4 border-b px-3 py-3 last:border-b-0">
              <Skeleton className="h-4 flex-[2]" />
              <Skeleton className="h-4 flex-1" />
              <Skeleton className="h-4 flex-1" />
              <Skeleton className="h-4 flex-1" />
            </div>
          ))}
        </div>
      );
    case "cards":
      return (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(16rem,1fr))] gap-4">
          {indices.map((i) => (
            <div key={i} className="flex flex-col gap-3 rounded-xl border p-4">
              <div className="flex items-center gap-3">
                <Skeleton className="size-8 rounded-md" />
                <Skeleton className="h-4 w-1/2" />
              </div>
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-2/3" />
            </div>
          ))}
        </div>
      );
    case "detail":
      return (
        <div className="flex flex-col gap-4">
          <Skeleton className="h-6 w-1/3" />
          <div className="grid grid-cols-[minmax(6rem,12rem)_1fr] gap-x-6 gap-y-3">
            {indices.map((i) => (
              <div key={i} className="contents">
                <Skeleton className="h-4 w-4/5" />
                <Skeleton className={cn("h-4", LINE_WIDTHS[(i + 1) % LINE_WIDTHS.length])} />
              </div>
            ))}
          </div>
          <Skeleton className="h-24 w-full" />
        </div>
      );
  }
}
