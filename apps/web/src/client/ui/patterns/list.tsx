import { createContext, useContext, useId, type ElementType, type ReactNode } from "react";
import { cn } from "@/ui/lib/utils";

export type ListVariant = "plain" | "divided" | "card";

const ListContext = createContext<ListVariant>("plain");

export interface ListProps {
  as?: "ul" | "ol";
  /** `plain` (spaced rows), `divided` (rules between rows) or `card` (each row a bordered card). */
  variant?: ListVariant;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  id?: string;
  className?: string;
  children?: ReactNode;
}

const LIST_CLASS: Record<ListVariant, string> = {
  plain: "flex flex-col gap-1",
  divided: "flex flex-col divide-y rounded-md border",
  card: "flex flex-col gap-2",
};

const ITEM_CLASS: Record<ListVariant, string> = {
  plain: "rounded-md px-2 py-1.5",
  divided: "px-3 py-2",
  card: "rounded-lg border bg-card px-4 py-3 text-card-foreground",
};

/** A semantic list of {@link ListItem}s. */
export function List({ as: Tag = "ul", variant = "plain", className, children, ...props }: ListProps) {
  return (
    <ListContext.Provider value={variant}>
      {/* role=list: list-style:none strips list semantics in Safari; restate them. */}
      <Tag
        data-slot="list"
        data-variant={variant}
        role="list"
        className={cn("m-0 list-none p-0", LIST_CLASS[variant], className)}
        {...props}
      >
        {children}
      </Tag>
    </ListContext.Provider>
  );
}

type LinkComponent = ElementType<{ href: string; className?: string; children?: ReactNode }>;
type CurrentValue = "true" | "page" | "location" | "step";

export interface ListItemProps {
  /** A leading glyph or badge (decorative, or text-bearing like a status badge). */
  leading?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  /** Trailing, secondary facts (a time, a count). Not interactive. */
  meta?: ReactNode;
  /** Row actions (buttons, links). They stay separately focusable beside the row link. */
  actions?: ReactNode;
  /** Whole-row link. The title is the link; its hit area stretches over the row. */
  href?: string;
  /** Link component for `href` (e.g. the router's link); defaults to `<a>`. */
  linkAs?: LinkComponent;
  /** Whole-row button (mutually exclusive with `href`). */
  onSelect?: () => void;
  /** The current row: `aria-current` (on the link/button, else the row) + a highlight. */
  selected?: boolean;
  /** The `aria-current` token used when `selected`. Default `"true"`; `"page"` for nav links. */
  current?: CurrentValue;
  /** Programmatic focus target (e.g. a hash). Use `tabIndex={-1}` with it. */
  id?: string;
  tabIndex?: number;
  className?: string;
  /** Extra content below the description (e.g. a nested detail). */
  children?: ReactNode;
}

/**
 * One list row: `leading` · title/description · `meta` · `actions`.
 *
 * Interaction modes:
 * - static (default);
 * - `href`: the title is one link whose hit area covers the row (stretched
 *   `::after`), so actions stay real, separate controls, never nested inside it;
 * - `onSelect`: the same, with a button.
 */
export function ListItem({
  leading,
  title,
  description,
  meta,
  actions,
  href,
  linkAs: LinkAs = "a",
  onSelect,
  selected = false,
  current = "true",
  id,
  tabIndex,
  className,
  children,
}: ListItemProps) {
  const variant = useContext(ListContext);
  const descriptionId = useId();
  const interactive = href !== undefined || onSelect !== undefined;
  const ariaCurrent = selected ? current : undefined;
  // Controls inside the row (a tooltip trigger in meta, a link in children) sit
  // above the stretched link's overlay; plain text still clicks through to it.
  const lift =
    "[&_:is(a,button,input,select,textarea,[tabindex])]:relative [&_:is(a,button,input,select,textarea,[tabindex])]:z-10";
  const stretched =
    "text-left font-medium outline-none after:absolute after:inset-0 after:rounded-[inherit] after:content-[''] focus-visible:after:ring-[3px] focus-visible:after:ring-ring/50";

  let heading: ReactNode;
  if (href !== undefined) {
    heading = (
      <LinkAs href={href} className={cn(stretched, "text-foreground")} {...{
          "aria-current": ariaCurrent,
          "aria-describedby": description != null ? descriptionId : undefined,
        }}>
        {title}
      </LinkAs>
    );
  } else if (onSelect !== undefined) {
    heading = (
      <button
        type="button"
        onClick={onSelect}
        aria-current={ariaCurrent}
        aria-describedby={description != null ? descriptionId : undefined}
        className={cn(stretched, "cursor-pointer bg-transparent p-0")}
      >
        {title}
      </button>
    );
  } else {
    heading = <span className="font-medium">{title}</span>;
  }

  return (
    <li
      data-slot="list-item"
      data-selected={selected ? "" : undefined}
      id={id}
      tabIndex={tabIndex}
      aria-current={!interactive ? ariaCurrent : undefined}
      className={cn(
        "relative flex items-start gap-3 text-sm outline-none",
        ITEM_CLASS[variant],
        interactive && "transition-colors hover:bg-accent/60",
        selected && "bg-accent text-accent-foreground",
        "focus-visible:ring-[3px] focus-visible:ring-ring/50",
        className,
      )}
    >
      {leading != null ? <div className="mt-0.5 flex shrink-0 items-center">{leading}</div> : null}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        {heading}
        {description != null ? (
          <div id={descriptionId} className={cn("text-muted-foreground", lift)}>
            {description}
          </div>
        ) : null}
        {children != null ? <div className={cn("flex min-w-0 flex-col gap-0.5", lift)}>{children}</div> : null}
      </div>
      {meta != null ? (
        <div className={cn("flex shrink-0 items-center gap-2 text-xs text-muted-foreground tabular-nums", lift)}>{meta}</div>
      ) : null}
      {/* Above the stretched link so the actions stay clickable. */}
      {actions != null ? <div className="relative z-10 flex shrink-0 items-center gap-1">{actions}</div> : null}
    </li>
  );
}

export interface ListGroupProps {
  heading: ReactNode;
  /** Heading level: 2 (default), 3 or 4. */
  level?: 2 | 3 | 4;
  /** Item count shown beside the heading. */
  count?: number;
  description?: ReactNode;
  id?: string;
  className?: string;
  /** The group's {@link List}. */
  children?: ReactNode;
}

/** A headed group of rows: `section[aria-labelledby]` with a heading, an optional count and a List. */
export function ListGroup({ heading, level = 2, count, description, id, className, children }: ListGroupProps) {
  const headingId = `${useId().replace(/[^a-zA-Z0-9_-]/g, "")}-heading`;
  const Heading = `h${level}` as const;
  return (
    <section data-slot="list-group" id={id} aria-labelledby={headingId} className={cn("flex flex-col gap-2", className)}>
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
      {children}
    </section>
  );
}
