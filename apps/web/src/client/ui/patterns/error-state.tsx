import type { ReactNode } from "react";
import { cn } from "@/ui/lib/utils";
import { Callout } from "@/ui/patterns/callout";
import { Button } from "@/ui/primitives/button";

export interface ErrorStateProps {
  /** What failed ("This source could not be loaded"). */
  title: ReactNode;
  /** A safe, user-facing explanation. Never raw exception text or stack traces. */
  message?: ReactNode;
  /** Shows a Retry button that calls this. */
  onRetry?: () => void;
  /** Accessible name / text of the retry button. */
  retryLabel?: string;
  /** Extra diagnostic detail, collapsed behind a "Details" disclosure. */
  details?: ReactNode;
  /** Tighter variant for in-table / in-list / fragment use. */
  compact?: boolean;
  className?: string;
}

/**
 * An explicit failure region: `role="alert"`, a failure glyph + text, and an
 * optional Retry. Distinct in role, glyph and tone from `EmptyState`.
 */
export function ErrorState({
  title,
  message,
  onRetry,
  retryLabel = "Retry",
  details,
  compact = false,
  className,
}: ErrorStateProps) {
  return (
    <Callout
      data-slot="error-state"
      tone="danger"
      icon="triangle-alert"
      role="alert"
      title={title}
      compact={compact}
      className={cn(className)}
      action={
        onRetry ? (
          <Button type="button" variant="outline" size="sm" onClick={onRetry}>
            {retryLabel}
          </Button>
        ) : undefined
      }
    >
      {message != null || details != null ? (
        <>
          {message != null && <p>{message}</p>}
          {details != null && (
            <details className="w-full text-xs">
              <summary className="cursor-pointer text-muted-foreground select-none">Details</summary>
              <div className="mt-1 font-mono break-words whitespace-pre-wrap">{details}</div>
            </details>
          )}
        </>
      ) : undefined}
    </Callout>
  );
}
