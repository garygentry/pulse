import { createContext, useContext, type ComponentProps, type ReactNode } from "react";
import { cn } from "@/ui/lib/utils";

export type KeyValueLayout = "stacked" | "inline" | "grid";

export interface KeyValueItem {
  /** React key; defaults to the label when it is a string, else the index. */
  id?: string;
  label: ReactNode;
  value: ReactNode;
  /** Secondary text under the value (provenance, units, a short explanation). */
  hint?: ReactNode;
}

export interface KeyValueListProps extends Omit<ComponentProps<"dl">, "children"> {
  /** Pairs to render. Use `children` (`<KeyValue>`) instead for custom groups. */
  items?: readonly KeyValueItem[];
  children?: ReactNode;
  /**
   * - `grid` (default): two columns, label ▸ value, collapsing to stacked pairs on narrow screens.
   * - `stacked`: label above value, one pair per row.
   * - `inline`: compact pairs flowing along one line (meta rows).
   */
  layout?: KeyValueLayout;
}

const LayoutContext = createContext<KeyValueLayout>("grid");

const LIST_LAYOUT: Record<KeyValueLayout, string> = {
  grid: "grid grid-cols-1 gap-y-3 sm:grid-cols-[minmax(8rem,max-content)_minmax(0,1fr)] sm:gap-x-6 sm:gap-y-2",
  stacked: "flex flex-col gap-3",
  inline: "flex flex-wrap items-baseline gap-x-6 gap-y-1",
};

const GROUP_LAYOUT: Record<KeyValueLayout, string> = {
  grid: "flex flex-col gap-0.5 sm:contents",
  stacked: "flex flex-col gap-0.5",
  inline: "flex items-baseline gap-1.5",
};

const LABEL_LAYOUT: Record<KeyValueLayout, string> = {
  grid: "text-muted-foreground",
  stacked: "text-xs font-medium text-muted-foreground",
  inline: "text-muted-foreground",
};

/**
 * Label/value pairs as a description list: a `dl` whose pairs are each wrapped in a
 * `div` group (valid HTML, and screen readers announce "term, definition").
 */
export function KeyValueList({ items, children, layout = "grid", className, ...props }: KeyValueListProps) {
  return (
    <LayoutContext.Provider value={layout}>
      <dl
        data-slot="key-value-list"
        data-layout={layout}
        className={cn("m-0 text-sm", LIST_LAYOUT[layout], className)}
        {...props}
      >
        {items?.map((item, index) => (
          <KeyValue
            key={item.id ?? (typeof item.label === "string" ? item.label : index)}
            label={item.label}
            hint={item.hint}
          >
            {item.value}
          </KeyValue>
        ))}
        {children}
      </dl>
    </LayoutContext.Provider>
  );
}

export interface KeyValueProps extends Omit<ComponentProps<"div">, "children"> {
  label: ReactNode;
  /** The value; `children` is an alias for richer content. */
  value?: ReactNode;
  children?: ReactNode;
  hint?: ReactNode;
}

/** One `dt`/`dd` pair inside a {@link KeyValueList}. */
export function KeyValue({ label, value, children, hint, className, ...props }: KeyValueProps) {
  const layout = useContext(LayoutContext);
  return (
    <div data-slot="key-value" className={cn(GROUP_LAYOUT[layout], className)} {...props}>
      <dt className={LABEL_LAYOUT[layout]}>
        {label}
        {layout === "inline" ? <span aria-hidden="true">:</span> : null}
      </dt>
      <dd className="m-0 min-w-0 break-words text-foreground">
        {value ?? children}
        {hint !== undefined && hint !== null ? (
          <span className="mt-0.5 block text-xs text-muted-foreground">{hint}</span>
        ) : null}
      </dd>
    </div>
  );
}

/** Shared look for a value that is absent. Text, never a blank or a bare dash. */
export function EmptyValue({ children, className, ...props }: ComponentProps<"span">) {
  return (
    <span data-slot="empty-value" className={cn("text-muted-foreground italic", className)} {...props}>
      {children}
    </span>
  );
}

/** The estate config declares nothing for this field (intent side). */
export function NotDeclared(props: Omit<ComponentProps<"span">, "children">) {
  return <EmptyValue {...props}>Not declared</EmptyValue>;
}

/** No snapshot/probe has reported this field yet (reality side). */
export function NotObserved(props: Omit<ComponentProps<"span">, "children">) {
  return <EmptyValue {...props}>Not observed</EmptyValue>;
}

/** An optional input (parameter, argument) the caller left empty. */
export function NotSupplied(props: Omit<ComponentProps<"span">, "children">) {
  return <EmptyValue {...props}>Not supplied</EmptyValue>;
}
