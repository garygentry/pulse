import { useId, type ComponentProps, type ReactNode } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/ui/primitives/card";
import { Icon } from "@/ui/patterns/icon";
import { KeyValueList, type KeyValueLayout } from "@/ui/patterns/key-value-list";
import { cn } from "@/ui/lib/utils";

export interface ComparisonRow {
  /** React key; defaults to the label when it is a string, else the index. */
  id?: string;
  label: ReactNode;
  declared: ReactNode;
  observed: ReactNode;
  /**
   * Optional per-row sync marker (e.g. a status badge: "In sync" / "Drifted"),
   * rendered beside the observed value. It must carry its own text, not colour alone.
   */
  marker?: ReactNode;
}

export interface ComparisonGridProps extends Omit<ComponentProps<"div">, "children"> {
  /**
   * Paired label/value rows: each side renders them as a {@link KeyValueList}.
   * Omit them and pass `declared`/`observed` when the two sides don't share labels.
   */
  rows?: readonly ComparisonRow[];
  /** Free-form declared side, rendered instead of the rows' declared values. */
  declared?: ReactNode;
  /** Free-form observed side, rendered instead of the rows' observed values. */
  observed?: ReactNode;
  declaredLabel?: ReactNode;
  observedLabel?: ReactNode;
  declaredDescription?: ReactNode;
  observedDescription?: ReactNode;
  /** Layout of each side's {@link KeyValueList}; defaults to `stacked` (cards are narrow). */
  layout?: KeyValueLayout;
  /**
   * Title each side with a heading of this level (the sides are then plain cards
   * under it). By default each side is a named `region` instead; pass a level
   * when the grid repeats on a page, so it doesn't add a run of identically
   * named landmarks.
   */
  headingLevel?: 3 | 4 | 5 | 6;
}

/**
 * "Declared intent ▸ Observed reality": two labelled cards (a {@link KeyValueList}
 * of paired rows, or free-form content per side), side by side from `md` up and
 * stacked below.
 */
export function ComparisonGrid({
  rows = [],
  declared,
  observed,
  declaredLabel = "Declared intent",
  observedLabel = "Observed reality",
  declaredDescription,
  observedDescription,
  layout = "stacked",
  headingLevel,
  className,
  ...props
}: ComparisonGridProps) {
  const id = useId();
  const key = (row: ComparisonRow, index: number) =>
    row.id ?? (typeof row.label === "string" ? row.label : String(index));

  return (
    <div
      data-slot="comparison-grid"
      className={cn("grid items-stretch gap-4 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]", className)}
      {...props}
    >
      <Side
        titleId={`${id}-declared`}
        title={declaredLabel}
        description={declaredDescription}
        headingLevel={headingLevel}
      >
        {declared !== undefined ? (
          declared
        ) : (
          <KeyValueList
            layout={layout}
            items={rows.map((row, index) => ({ id: key(row, index), label: row.label, value: row.declared }))}
          />
        )}
      </Side>
      <div className="hidden items-center text-muted-foreground md:flex" aria-hidden="true">
        <Icon name="chevron-right" size={20} />
      </div>
      <Side
        titleId={`${id}-observed`}
        title={observedLabel}
        description={observedDescription}
        headingLevel={headingLevel}
      >
        {observed !== undefined ? (
          observed
        ) : (
          <KeyValueList
            layout={layout}
            items={rows.map((row, index) => ({
              id: key(row, index),
              label: row.label,
              value:
                row.marker === undefined ? (
                  row.observed
                ) : (
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="min-w-0">{row.observed}</span>
                    {row.marker}
                  </span>
                ),
            }))}
          />
        )}
      </Side>
    </div>
  );
}

function Side({
  titleId,
  title,
  description,
  headingLevel,
  children,
}: {
  titleId: string;
  title: ReactNode;
  description?: ReactNode;
  headingLevel?: 3 | 4 | 5 | 6 | undefined;
  children: ReactNode;
}) {
  const Heading = headingLevel === undefined ? null : (`h${headingLevel}` as const);
  return (
    <Card
      role={Heading === null ? "region" : undefined}
      aria-labelledby={Heading === null ? titleId : undefined}
      className="min-w-0 gap-4 py-4"
    >
      <CardHeader className="px-4">
        {Heading === null ? (
          <CardTitle id={titleId} className="text-sm">
            {title}
          </CardTitle>
        ) : (
          <CardTitle className="text-sm">
            <Heading id={titleId}>{title}</Heading>
          </CardTitle>
        )}
        {description !== undefined ? <CardDescription>{description}</CardDescription> : null}
      </CardHeader>
      <CardContent className="min-w-0 px-4">{children}</CardContent>
    </Card>
  );
}
