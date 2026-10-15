import type { ReactNode } from "react";
import type { IconName } from "@/ui/lib/icons";
import { cn } from "@/ui/lib/utils";
import { Icon } from "@/ui/patterns/icon";

export interface EmptyStateProps {
  /** What is empty ("No documents to show"). */
  title: ReactNode;
  description?: ReactNode;
  /** A neutral glyph; defaults to `inbox`. Never a failure glyph — that is ErrorState. */
  icon?: IconName;
  /** A next step (a link or button). */
  action?: ReactNode;
  /** One-line variant for in-table / in-list use (e.g. a DataTable's empty row). */
  compact?: boolean;
  className?: string;
}

/**
 * "Acquired, nothing to show": a polite `role="status"` region with a neutral
 * icon + text. Deliberately distinct in role, glyph and tone from `ErrorState`.
 */
export function EmptyState({ title, description, icon = "inbox", action, compact = false, className }: EmptyStateProps) {
  if (compact) {
    return (
      <div
        data-slot="empty-state"
        data-compact=""
        role="status"
        className={cn("flex flex-wrap items-center gap-x-2 gap-y-1 py-(--empty-state-compact-py) text-sm text-muted-foreground", className)}
      >
        <Icon name={icon} className="shrink-0" />
        <span className="font-medium text-foreground">{title}</span>
        {description != null && <span>{description}</span>}
        {action != null && <span className="ms-auto">{action}</span>}
      </div>
    );
  }

  return (
    <div
      data-slot="empty-state"
      role="status"
      className={cn(
        "flex flex-col items-center gap-2 rounded-lg border border-dashed px-(--empty-state-px) py-(--empty-state-py) text-center",
        className,
      )}
    >
      <span className="mb-1 flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <Icon name={icon} size={20} />
      </span>
      <p className="text-sm font-medium">{title}</p>
      {description != null && <p className="max-w-prose text-sm text-muted-foreground">{description}</p>}
      {action != null && <div className="mt-2 flex flex-wrap justify-center gap-2">{action}</div>}
    </div>
  );
}
