import { Children, isValidElement, useId, useRef, type ReactNode } from "react";
import { useListNavigation } from "@/ui/hooks/use-list-navigation";
import { columnsFromOffsets } from "@/ui/lib/grid";
import { cn } from "@/ui/lib/utils";

/** The focusable element of each grid item (a LinkTile's link, a card's first control). */
const ITEM_FOCUSABLE = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface CardGridProps {
  /** Optional group heading; the grid becomes a `section` named by it. */
  heading?: ReactNode;
  /** Heading level: 2 (default) to 5. */
  level?: 2 | 3 | 4 | 5;
  /** Item count shown beside the heading. */
  count?: number;
  description?: ReactNode;
  /** Names the list when there is no heading. */
  "aria-label"?: string;
  /**
   * 2-D arrow-key navigation between items' focusable elements (←/→ within a
   * row, ↑/↓ by row, Home/End), measured from the live layout.
   */
  navigable?: boolean;
  id?: string;
  className?: string;
  /** One card per child (e.g. `LinkTile`s); each is wrapped in a list item. */
  children?: ReactNode;
}

/** A responsive auto-fill grid of cards (`minmax(16rem, 1fr)`), as a list, with an optional heading. */
export function CardGrid({
  heading,
  level = 2,
  count,
  description,
  navigable = false,
  id,
  className,
  children,
  ...labelling
}: CardGridProps) {
  const rootRef = useRef<HTMLElement & HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const headingId = `${useId().replace(/[^a-zA-Z0-9_-]/g, "")}-heading`;

  const focusables = (): HTMLElement[] =>
    [...(listRef.current?.children ?? [])]
      .map((li) => li.querySelector<HTMLElement>(ITEM_FOCUSABLE))
      .filter((el): el is HTMLElement => el !== null);

  useListNavigation({
    enabled: navigable,
    scope: "element",
    containerRef: rootRef,
    keys: "arrows",
    getItems: focusables,
    grid: {
      columns: () =>
        columnsFromOffsets([...(listRef.current?.children ?? [])].map((li) => li.getBoundingClientRect().top)),
    },
  });

  const list = (
    <ul
      ref={listRef}
      role="list"
      aria-labelledby={heading != null ? headingId : undefined}
      aria-label={heading == null ? labelling["aria-label"] : undefined}
      className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(min(16rem,100%),1fr))] gap-3 p-0"
    >
      {Children.toArray(children).map((child, index) => (
        // toArray has already made each child's key unique; reuse it so tiles
        // move (and keep focus) instead of remounting when the order changes.
        <li key={isValidElement(child) && child.key != null ? child.key : index} data-slot="card-grid-item" className="min-w-0 [&>*]:h-full">
          {child}
        </li>
      ))}
    </ul>
  );

  if (heading == null) {
    return (
      <div data-slot="card-grid" id={id} ref={rootRef} className={className}>
        {list}
      </div>
    );
  }

  const Heading = `h${level}` as const;
  return (
    <section data-slot="card-grid" id={id} ref={rootRef} aria-labelledby={headingId} className={cn("flex flex-col gap-3", className)}>
      <div className="flex flex-col gap-0.5">
        <Heading id={headingId} className="flex items-center gap-2 text-sm font-semibold">
          {heading}
          {count !== undefined ? (
            <span className="rounded-full bg-muted px-2 text-xs font-medium text-muted-foreground tabular-nums">
              {count}
            </span>
          ) : null}
        </Heading>
        {description != null ? <p className="text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {list}
    </section>
  );
}
