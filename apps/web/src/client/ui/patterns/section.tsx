import { useId, type ComponentProps, type ReactNode } from "react";
import { cn } from "@/ui/lib/utils";

export interface SectionProps extends Omit<ComponentProps<"section">, "title" | "aria-labelledby"> {
  /** The section heading. */
  title: ReactNode;
  /** The section element's id (an in-page anchor). The heading id becomes `{id}-heading`. */
  id?: string;
  /** Override the heading id outright (e.g. to keep an id existing links target). */
  headingId?: string;
  description?: ReactNode;
  /** Section-level actions, right of the heading. */
  actions?: ReactNode;
  /** `plain` (default) flows in the page; `card` sits on a bordered card surface. */
  variant?: "plain" | "card";
  /** Heading level: 2 (default) under the page `h1`, 3 to 5 for nested sections. */
  level?: 2 | 3 | 4 | 5;
}

/**
 * A titled region of a page: `section[aria-labelledby]` named by its own
 * heading, with an optional description and actions row.
 */
export function Section({
  title,
  id,
  headingId,
  description,
  actions,
  variant = "plain",
  level = 2,
  className,
  children,
  ...props
}: SectionProps) {
  const generated = useId();
  const resolvedHeadingId =
    headingId ?? (id !== undefined ? `${id}-heading` : `section-${generated.replace(/[^a-zA-Z0-9_-]/g, "")}`);
  const Heading = `h${level}` as const;

  return (
    <section
      data-slot="section"
      data-variant={variant}
      id={id}
      aria-labelledby={resolvedHeadingId}
      className={cn(
        // Spacing tokens (theme.css), which the operator's compact density tightens.
        "flex flex-col gap-(--section-gap)",
        variant === "card" &&
          "rounded-xl border bg-card p-(--section-card-p) text-card-foreground shadow-sm",
        className,
      )}
      {...props}
    >
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-col gap-1">
          <Heading id={resolvedHeadingId} className="text-base font-semibold">
            {title}
          </Heading>
          {description != null && <p className="text-sm text-muted-foreground">{description}</p>}
        </div>
        {actions != null && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children}
    </section>
  );
}
