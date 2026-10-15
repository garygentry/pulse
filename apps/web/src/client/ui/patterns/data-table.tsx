import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type Column,
  type ColumnDef,
  type Header,
  type RowData,
  type Row,
} from "@tanstack/react-table";
import { defaultRangeExtractor, observeElementOffset, useVirtualizer } from "@tanstack/react-virtual";
import {
  useCallback,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ElementType,
  type FocusEvent,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  type Ref,
  type RefObject,
} from "react";
import { cn } from "@/ui/lib/utils";
import { observeClientRect } from "@/ui/lib/virtual";
import { EmptyState, type EmptyStateProps } from "@/ui/patterns/empty-state";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/ui/primitives/table";

declare module "@tanstack/react-table" {
  // Per-column presentation hints DataTable reads from `columnDef.meta`.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface ColumnMeta<TData extends RowData, TValue> {
    /** Classes for this column's body cells. */
    className?: string;
    /** Classes for this column's header cell. */
    headerClassName?: string;
    /** `"end"` right-aligns (numbers). */
    align?: "start" | "end";
  }
}

/** The attribute on each row's primary link; `useListNavigation` targets it. */
export const ROW_LINK_ATTRIBUTE = "data-row-link";
/** Selector for every row link in a table: `root.querySelectorAll(ROW_LINK_SELECTOR)`. */
export const ROW_LINK_SELECTOR = `[${ROW_LINK_ATTRIBUTE}]`;

/** Where `scrollToIndex` places the row; `"auto"` scrolls only as far as needed. */
export type DataTableScrollAlign = "start" | "center" | "end" | "auto";

/** The imperative handle a `DataTable` exposes through its `ref`. */
export interface DataTableHandle {
  /**
   * Scroll the row at `index` (into `data`) into view, clear of a sticky header: inside the
   * table's own scroll region when it has one, else (a plain table as tall as its rows) by
   * scrolling the row into the page. The promise resolves once the row is rendered and in
   * place: at once on a plain table; on a virtualized one after the window has moved to it and
   * its rows are measured. It also resolves, with the row possibly not rendered, when a user
   * scroll or a newer call takes over, or the row leaves `data`.
   */
  scrollToIndex: (index: number, options?: { align?: DataTableScrollAlign }) => Promise<void>;
  /**
   * `scrollToIndex`, then focus the row's link (or the row itself, when `rowDomId` makes it
   * focusable) and make sure it is visible on the page. Resolves `true` once it has focus, and
   * `false` without focusing when the scroll was cancelled (a user scroll, or a newer
   * `scrollToIndex`/`focusIndex` call took over) or the row has nothing to focus. This is how
   * keyboard navigation reaches row 0 or the last row of a virtualized table, whose far rows
   * are not in the DOM.
   */
  focusIndex: (index: number, options?: { align?: DataTableScrollAlign }) => Promise<boolean>;
}

export interface DataTableVirtualizeOptions<T = unknown> {
  /** Virtualize when there are at least this many rows (at least 1). Default 300. */
  threshold?: number;
  /** Rows rendered beyond each edge of the viewport. Default 8. */
  overscan?: number;
  /**
   * A fixed minimum row height in px. By default rows take their height from the density
   * tokens, like a plain table, and are measured as they render (the token is the estimate
   * for rows not rendered yet). Rows taller than this (a second line of text) are measured
   * too, so offsets stay exact.
   */
  rowHeight?: number;
  /**
   * Whether a row holds a keyboard focus stop. The focused row's previous and next rows for
   * which this is true stay rendered, so Tab and Shift+Tab reach them from anywhere in the
   * table. Default: rows with a row link when `rowLink` is set, else every row. Pass it when
   * focusable controls are sparse, e.g. `(row) => row.canRestart` for a Restart button that
   * only some rows have (or `hasLink(row) || hasAction(row)` for mixed rows).
   */
  isNavigable?: (row: T) => boolean;
}

/** A virtualized table falls back to a plain one below `floor(threshold * this)` rows. */
const DATA_TABLE_VIRTUALIZE_EXIT_RATIO = 0.8;

/** Defaults for `virtualize`. */
export const DATA_TABLE_VIRTUALIZE_DEFAULTS = {
  threshold: 300,
  overscan: 8,
} as const;

type LinkComponent = ElementType<{ href: string; className?: string; children?: ReactNode }>;

export interface DataTableProps<T> {
  /**
   * TanStack column defs. A def with `columns: [...]` is a group: it renders a
   * two-row header, with the group cell `scope="colgroup"` spanning its leaves.
   * A `cell` renderer is called as a function (no hooks inside it).
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TanStack's own ColumnDef[] idiom
  columns: ColumnDef<T, any>[];
  data: readonly T[];
  /** The table's caption; it also names the scroll region. */
  caption: ReactNode;
  /** Keep the caption for assistive tech but hide it visually. */
  captionHidden?: boolean;
  /** Stable row key (TanStack row id): React key and `data-row-link` value. */
  getRowId: (row: T, index: number) => string;
  /** Makes the first cell's content a link to this href (`data-row-link` = row id). */
  rowLink?: (row: T) => string | undefined;
  /** Link component for `rowLink` (e.g. the router's link); defaults to `<a>`. */
  linkAs?: LinkComponent;
  /**
   * DOM `id` for a row (plus `tabIndex=-1`), so a hash or a script can focus it. On a
   * virtualized table only the rendered rows are in the DOM: reach any other row through
   * the handle (`focusIndex` or `scrollToIndex`) rather than `getElementById`.
   */
  rowDomId?: (row: T) => string;
  /** The first column's cells are row headers (`th scope="row"`). Default `true`. */
  rowHeader?: boolean;
  /** Shown in one full-width row when `data` is empty: a title, or full EmptyState props. */
  empty?: ReactNode | Omit<EmptyStateProps, "compact">;
  /** `compact` (default, D16: compact tables) or `comfortable`. */
  density?: "comfortable" | "compact";
  /** Header cells stick to the top of the scroll region (bound its height via `className`). Default `true`. */
  stickyHeader?: boolean;
  /**
   * Classes for the root (`data-slot="data-table"`), which is the scroll region with or
   * without `virtualize`, e.g. `max-h-96` for a sticky header.
   */
  className?: string;
  /**
   * The scroll region is a tab stop, so keyboard users can scroll it. Default `true`. Pass
   * `false` where nobody interacts (a kiosk wallboard) so the page has no idle tab stops.
   */
  focusable?: boolean;
  /**
   * Render only the rows in view (plus `overscan`) once there are `threshold` rows
   * or more (an empty table never virtualizes). The root stays the scroll region,
   * bounded by a default max height (override it with `className`, e.g. `max-h-96`);
   * rows keep their density-token height and each rendered row is measured, so rows
   * of varying height keep the spacers, scrollbar and `scrollToIndex` exact; the
   * table carries `aria-rowcount` and each row `aria-rowindex`.
   *
   * Keyboard: the focused row, its adjacent rows and its previous and next navigable
   * rows (`isNavigable`: by default the nearest with a row link when `rowLink` is set;
   * pass it when cell controls are sparse) stay rendered whatever the scroll position
   * or `overscan`, tracked by row id (so they survive rows inserted or re-sorted above
   * them), and a focused row is scrolled into view. Tab, Shift+Tab and arrow keys
   * therefore move row by row across the rendered window. The first and last rows are
   * not in the DOM, so `useListNavigation`'s Home/End (and vim `gg`/`G`) need its
   * `focusEdge` option wired to the handle's `focusIndex` (see the UI architecture doc).
   * `true` uses the defaults.
   *
   * Hysteresis: once a mounted table virtualizes, it stays virtualized until it
   * has fewer than `floor(threshold * 0.8)` rows (at least 1), so live data
   * hovering around the threshold does not remount the table (losing scroll and
   * focus) on every crossing. A table that has never virtualized renders the plain
   * (non-virtualized) table.
   */
  virtualize?: boolean | DataTableVirtualizeOptions<T>;
  /** Imperative handle (`scrollToIndex`, `focusIndex`); works with and without `virtualize`. */
  ref?: Ref<DataTableHandle>;
}

interface VirtualConfig<T> {
  threshold: number;
  overscan: number;
  /** An explicit fixed row height, or `undefined` for token-height measured rows. */
  rowHeight: number | undefined;
  isNavigable: ((row: T) => boolean) | undefined;
}

function virtualConfig<T>(virtualize: DataTableProps<T>["virtualize"]): VirtualConfig<T> | null {
  if (virtualize === undefined || virtualize === false) return null;
  const options = virtualize === true ? {} : virtualize;
  return {
    threshold: Math.max(1, options.threshold ?? DATA_TABLE_VIRTUALIZE_DEFAULTS.threshold),
    overscan: Math.max(0, options.overscan ?? DATA_TABLE_VIRTUALIZE_DEFAULTS.overscan),
    rowHeight: options.rowHeight,
    isNavigable: options.isNavigable,
  };
}

/** The cell-height token per density (theme.css), and its default value in px. */
const ROW_HEIGHT_TOKEN = {
  compact: { name: "--table-compact-cell-h", fallback: 32 },
  comfortable: { name: "--table-cell-h", fallback: 44 },
} as const;

/**
 * A virtualized row's height estimate (before it is rendered and measured): the density's
 * cell-height token as the document resolves it, so the operator's density setting applies.
 */
function tokenRowHeight(density: "comfortable" | "compact"): number {
  const token = ROW_HEIGHT_TOKEN[density];
  if (typeof document === "undefined") return token.fallback;
  const style = getComputedStyle(document.documentElement);
  const raw = style.getPropertyValue(token.name).trim();
  const value = Number.parseFloat(raw);
  if (!(value > 0)) return token.fallback;
  if (raw.endsWith("rem")) return value * (Number.parseFloat(style.fontSize) || 16);
  if (raw.endsWith("px")) return value;
  return token.fallback;
}

const ROW_INDEX_ATTRIBUTE = "data-row-index";

/** The rendered `<tr>` for a row id inside `root`, if any. */
function findRow(root: HTMLElement | null, id: string): HTMLElement | null {
  for (const tr of root?.querySelectorAll<HTMLElement>("tbody > tr[data-row-id]") ?? []) {
    if (tr.getAttribute("data-row-id") === id) return tr;
  }
  return null;
}

/** A row's own controls, for a row with no row link that is not focusable itself. */
const ROW_CONTROL_SELECTOR = "a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]";

/**
 * Focus a rendered row's link, else the row itself when it is focusable, else its first
 * control. The row is already aimed inside the table: focus without the browser's own scroll
 * (which ignores the sticky header), then bring it into the page if it is outside it.
 */
function focusRow(root: HTMLElement | null, id: string): boolean {
  const row = findRow(root, id);
  if (row === null) return false;
  const target =
    row.querySelector<HTMLElement>(ROW_LINK_SELECTOR) ??
    (row.hasAttribute("tabindex") ? row : row.querySelector<HTMLElement>(ROW_CONTROL_SELECTOR));
  if (target === null) return false;
  target.focus({ preventScroll: true });
  target.scrollIntoView?.({ block: "nearest" });
  return target.ownerDocument.activeElement === target;
}

/** Whether the root scrolls vertically (it has a bounded height), or grows with its rows. */
const scrollsVertically = (root: HTMLElement): boolean => root.scrollHeight > root.clientHeight;

const scrollBlock = (align: DataTableScrollAlign): ScrollLogicalPosition => (align === "auto" ? "nearest" : align);

/**
 * Scroll a plain table's root (only the root, never the page) so `row` sits at `align`,
 * clear of the sticky header (`header` px).
 */
function scrollPlainRow(root: HTMLElement, row: HTMLElement, align: DataTableScrollAlign, header: number): void {
  const box = row.getBoundingClientRect();
  // The row's top in the root's scrolled content.
  const top = box.top - root.getBoundingClientRect().top - root.clientTop + root.scrollTop;
  const start = top - header;
  const end = top + box.height - root.clientHeight;
  let target: number;
  if (align === "start") target = start;
  else if (align === "end") target = end;
  else if (align === "center") target = start - (root.clientHeight - header - box.height) / 2;
  else if (start < root.scrollTop) target = start;
  else if (end > root.scrollTop) target = end;
  else return;
  root.scrollTo({ top: Math.max(0, target) });
}

const isEmptyStateProps = (value: unknown): value is Omit<EmptyStateProps, "compact"> =>
  typeof value === "object" && value !== null && !Array.isArray(value) && "title" in value && !("$$typeof" in value);

function alignClass<T>(column: Column<T, unknown>): string | undefined {
  return column.columnDef.meta?.align === "end" ? "text-right" : undefined;
}

/** The root's (scroll region's) classes on both paths. */
const ROOT_CLASS =
  "relative w-full overflow-auto rounded-md border outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50";

/**
 * A data table over TanStack Table (headless) and the shadcn table primitives.
 * It owns the caption, grouped headers with `scope`, row headers, the row-link
 * convention, the empty row and horizontal scrolling in a focusable, labelled
 * region. Figures are tabular (`tabular-nums`).
 */
export function DataTable<T>({
  columns,
  data,
  caption,
  captionHidden = false,
  getRowId,
  rowLink,
  linkAs: LinkAs = "a",
  rowDomId,
  rowHeader = true,
  empty,
  density = "compact",
  stickyHeader = true,
  className,
  focusable = true,
  virtualize,
  ref,
}: DataTableProps<T>) {
  const captionId = `${useId().replace(/[^a-zA-Z0-9_-]/g, "")}-caption`;
  const table = useReactTable<T>({
    columns,
    data: data as T[],
    getRowId,
    getCoreRowModel: getCoreRowModel(),
    // No pagination: without this, every `data` change queues a page-index reset
    // (a state update), which re-renders the whole table a second time.
    autoResetPageIndex: false,
  });

  const headerGroups = table.getHeaderGroups();
  const leafColumns = table.getVisibleLeafColumns();
  const firstLeafId = leafColumns[0]?.id;
  const grouped = headerGroups.length > 1;

  // A column appears in several header rows (as placeholders above its real
  // header). Render it once, in its first row, spanning down to its real one.
  const span = (() => {
    const first = new Map<string, number>();
    const real = new Map<string, number>();
    headerGroups.forEach((group, g) =>
      group.headers.forEach((header) => {
        if (!first.has(header.column.id)) first.set(header.column.id, g);
        if (!header.isPlaceholder) real.set(header.column.id, g);
      }),
    );
    return { first, real };
  })();

  // Spacing tokens (theme.css): the operator's compact density tightens either table density.
  const cellPad =
    density === "compact"
      ? "h-(--table-compact-cell-h) px-(--table-compact-cell-px) py-(--table-compact-cell-py)"
      : "h-(--table-cell-h) px-(--table-cell-px) py-(--table-cell-py)";
  const rows = table.getRowModel().rows;
  const virtual = virtualConfig<T>(virtualize);
  // Hysteresis (see `virtualize`): stay virtualized down to the exit bound once on. The
  // threshold and exit bound are at least 1, so an empty table is never virtualized.
  const [wasVirtualized, setWasVirtualized] = useState(false);
  const virtualized =
    virtual !== null &&
    (rows.length >= virtual.threshold ||
      (wasVirtualized &&
        rows.length >= Math.max(1, Math.floor(virtual.threshold * DATA_TABLE_VIRTUALIZE_EXIT_RATIO))));
  // Derived state from the previous render (React re-runs this render before committing).
  if (virtualized !== wasVirtualized) setWasVirtualized(virtualized);

  const rootRef = useRef<HTMLDivElement>(null);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const virtualScrollRef = useRef<VirtualScroll | null>(null);
  // Each handle call takes a new token: a `focusIndex` focuses only while it is still the
  // latest call, so it never undoes a newer scroll.
  const requestRef = useRef(0);
  useImperativeHandle(ref, () => {
    /** Scroll to the row; resolves whether the scroll completed (not cancelled or superseded). */
    const scroll = (index: number, align: DataTableScrollAlign): Promise<boolean> => {
      if (virtualScrollRef.current !== null) return virtualScrollRef.current(index, align);
      const root = rootRef.current;
      const row = root?.querySelector("tbody")?.children[index];
      if (!root || !(row instanceof HTMLElement) || !row.hasAttribute("data-row-id")) return Promise.resolve(false);
      if (scrollsVertically(root)) {
        const header = stickyHeader ? (root.querySelector("thead")?.getBoundingClientRect().height ?? 0) : 0;
        scrollPlainRow(root, row, align, header);
      } else {
        // A table as tall as its rows does not scroll itself: the page (or an ancestor) does.
        row.scrollIntoView?.({ block: scrollBlock(align) });
      }
      return Promise.resolve(true);
    };
    return {
      async scrollToIndex(index, options) {
        requestRef.current += 1;
        await scroll(index, options?.align ?? "auto");
      },
      async focusIndex(index, options) {
        const token = (requestRef.current += 1);
        const id = rowsRef.current[index]?.id;
        if (id === undefined) return false;
        const completed = await scroll(index, options?.align ?? "auto");
        if (!completed || requestRef.current !== token) return false;
        return focusRow(rootRef.current, id);
      },
    };
  }, [stickyHeader]);
  const emptyProps: Omit<EmptyStateProps, "compact"> = isEmptyStateProps(empty)
    ? empty
    : { title: (empty as ReactNode) ?? "No rows to show" };

  const renderHeader = (header: Header<T, unknown>, g: number): ReactNode => {
    const { column } = header;
    if (span.first.get(column.id) !== g) return null;
    const leaf = column.columns.length === 0;
    const rowSpan = (span.real.get(column.id) ?? g) - g + 1;
    const content = flexRender(column.columnDef.header, header.getContext());
    return (
      <TableHead
        key={header.id}
        scope={leaf ? "col" : "colgroup"}
        colSpan={header.colSpan > 1 ? header.colSpan : undefined}
        rowSpan={rowSpan > 1 ? rowSpan : undefined}
        className={cn(
          cellPad,
          "bg-muted text-xs font-medium text-muted-foreground",
          stickyHeader && "sticky top-0 z-10",
          !leaf && "border-x text-center",
          leaf && alignClass(column),
          column.columnDef.meta?.headerClassName,
        )}
      >
        {content}
      </TableHead>
    );
  };

  const renderRow = (row: Row<T>, position?: VirtualRowPosition): ReactElement => {
    const href = rowLink?.(row.original);
    return (
      <TableRow
        key={row.id}
        id={rowDomId?.(row.original)}
        tabIndex={rowDomId !== undefined ? -1 : undefined}
        data-row-id={row.id}
        {...(position !== undefined
          ? {
              [ROW_INDEX_ATTRIBUTE]: position.index,
              "aria-rowindex": position.ariaRowIndex,
              // Only an explicit `rowHeight` sets a (minimum) height; otherwise the cells'
              // density tokens do, as in a plain table. The real height is measured through `ref`.
              style: position.height !== undefined ? { height: position.height } : undefined,
              ref: position.measure,
            }
          : {})}
        className="outline-none focus-visible:bg-muted/50"
      >
        {row.getVisibleCells().map((cell) => {
          const { column } = cell;
          const isFirst = column.id === firstLeafId;
          // A cell renderer is called as a plain function, not mounted as a
          // component (which `flexRender` does): a large table then skips
          // one component instance per cell. Cell renderers must not call
          // hooks; render a component from the cell when one is needed.
          const renderCell = column.columnDef.cell;
          let content: ReactNode =
            typeof renderCell === "function"
              ? (renderCell(cell.getContext()) as ReactNode)
              : flexRender(renderCell, cell.getContext());
          if (isFirst && href !== undefined) {
            content = (
              <LinkAs
                href={href}
                className="font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:rounded-sm focus-visible:ring-[3px] focus-visible:ring-ring/50"
                {...{ [ROW_LINK_ATTRIBUTE]: row.id }}
              >
                {content}
              </LinkAs>
            );
          }
          const cellClass = cn(cellPad, "text-left", alignClass(column), column.columnDef.meta?.className);
          return isFirst && rowHeader ? (
            <th key={cell.id} scope="row" data-slot="table-cell" className={cn("align-middle font-normal whitespace-nowrap", cellClass)}>
              {content}
            </th>
          ) : (
            <TableCell key={cell.id} className={cellClass}>
              {content}
            </TableCell>
          );
        })}
      </TableRow>
    );
  };

  if (virtualized) {
    return (
      <VirtualizedTable
        rootRef={rootRef}
        scrollRef={virtualScrollRef}
        config={virtual}
        rows={rows}
        renderRow={renderRow}
        isNavigable={(row) =>
          virtual.isNavigable !== undefined
            ? virtual.isNavigable(row.original)
            : rowLink === undefined || rowLink(row.original) !== undefined
        }
        headerRows={headerGroups.map((group, g) => (
          <TableRow key={group.id} aria-rowindex={g + 1} className="hover:bg-transparent">
            {group.headers.map((header) => renderHeader(header, g))}
          </TableRow>
        ))}
        colgroups={
          grouped
            ? headerGroups[0]!.headers.map((header) => <colgroup key={header.id} span={header.colSpan} />)
            : null
        }
        columnCount={Math.max(1, leafColumns.length)}
        caption={caption}
        captionHidden={captionHidden}
        captionId={captionId}
        density={density}
        stickyHeader={stickyHeader}
        className={className}
        focusable={focusable}
      />
    );
  }

  return (
    <div
      ref={rootRef}
      data-slot="data-table"
      data-density={density}
      role="region"
      aria-labelledby={captionId}
      // Focusable so keyboard users can scroll it horizontally.
      tabIndex={focusable ? 0 : undefined}
      className={cn(ROOT_CLASS, className)}
    >
      <table className="w-full caption-top border-collapse text-sm tabular-nums">
        <caption
          id={captionId}
          className={cn(captionHidden ? "sr-only" : "px-3 py-2 text-left text-sm text-muted-foreground")}
        >
          {caption}
        </caption>
        {grouped ? (
          <>
            {headerGroups[0]!.headers.map((header) => (
              <colgroup key={header.id} span={header.colSpan} />
            ))}
          </>
        ) : null}
        <TableHeader>
          {headerGroups.map((group, g) => (
            <TableRow key={group.id} className="hover:bg-transparent">
              {group.headers.map((header) => renderHeader(header, g))}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow className="hover:bg-transparent">
              <TableCell colSpan={Math.max(1, leafColumns.length)} className="px-(--table-cell-px)">
                <EmptyState compact {...emptyProps} />
              </TableCell>
            </TableRow>
          ) : (
            rows.map((row) => renderRow(row))
          )}
        </TableBody>
      </table>
    </div>
  );
}

/** Where a virtualized row sits, and how it reports its rendered height. */
interface VirtualRowPosition {
  index: number;
  ariaRowIndex: number;
  /** An explicit `rowHeight`, else `undefined` (the density tokens size the row). */
  height: number | undefined;
  measure: (node: HTMLTableRowElement | null) => void;
}

/** The virtualized table's `scrollToIndex`. */
/** The virtualized table's scroll to a row: resolves whether it completed (not cancelled). */
type VirtualScroll = (index: number, align: DataTableScrollAlign) => Promise<boolean>;

/**
 * After `scrollToIndex`, how many further commits may re-aim at the row (or re-render the
 * window at the new offset) before the scroll settles where it is (see `scrollToRow`).
 * Counted in commits, never wall-clock time, so a slow device converges the same way.
 */
const SCROLL_CORRECTION_PASSES = 3;

/** Keys that scroll a focused scroll region (and so cancel a pending re-aim). */
const SCROLL_KEYS: ReadonlySet<string> = new Set([
  "ArrowUp",
  "ArrowDown",
  "PageUp",
  "PageDown",
  "Home",
  "End",
  " ",
]);

interface VirtualizedTableProps<T> {
  rootRef: RefObject<HTMLDivElement | null>;
  scrollRef: { current: VirtualScroll | null };
  config: VirtualConfig<T>;
  rows: Row<T>[];
  renderRow: (row: Row<T>, position: VirtualRowPosition) => ReactElement;
  /** Whether a row holds a keyboard focus stop (see `DataTableVirtualizeOptions.isNavigable`). */
  isNavigable: (row: Row<T>) => boolean;
  headerRows: ReactElement[];
  colgroups: ReactNode;
  columnCount: number;
  caption: ReactNode;
  captionHidden: boolean;
  captionId: string;
  density: "comfortable" | "compact";
  stickyHeader: boolean;
  className: string | undefined;
  focusable: boolean;
}

/**
 * An `aria-hidden` row standing in for `height` px of rows that are not rendered. It carries
 * the rows' bottom border, as the row it replaces would: in the collapsed-border table the
 * next row then gets the same top half-border as anywhere else, so a row measures the same
 * height whether or not it follows a spacer (no re-measure as the window moves).
 */
function SpacerRow({ height, columnCount }: { height: number; columnCount: number }) {
  return (
    <tr aria-hidden="true" data-slot="data-table-spacer" className="border-b">
      <td colSpan={columnCount} className="border-0 p-0" style={{ height }} />
    </tr>
  );
}

/**
 * The virtualized body of `DataTable`: the root is a bounded scroll region (sticky header,
 * spacer rows above and below the rendered window) over `useVirtualizer`.
 */
function VirtualizedTable<T>({
  rootRef,
  scrollRef,
  config,
  rows,
  renderRow,
  isNavigable,
  headerRows,
  colgroups,
  columnCount,
  caption,
  captionHidden,
  captionId,
  density,
  stickyHeader,
  className,
  focusable,
}: VirtualizedTableProps<T>) {
  const theadRef = useRef<HTMLTableSectionElement>(null);
  const captionRef = useRef<HTMLTableCaptionElement>(null);
  const indexById = useMemo(() => new Map(rows.map((row, index) => [row.id, index])), [rows]);
  // Stable per `rows`: the virtualizer recomputes every row's offset when this changes.
  const getItemKey = useCallback((index: number) => rows[index]?.id ?? index, [rows]);
  const estimate = useMemo(() => config.rowHeight ?? tokenRowHeight(density), [config.rowHeight, density]);

  // The row holding focus, and its previous and next navigable rows, stay rendered while
  // scrolled out of the window: focus is never dropped to the body, and Tab or an arrow
  // key always has the logical neighbour to move to, whatever the overscan.
  // Tracked by row id, not index: live data re-sorting or inserting rows above it
  // moves the row, and its current index is resolved from `rows` on each use.
  const focusedIdRef = useRef<string | null>(null);
  const pinCacheRef = useRef<{ rows: Row<T>[]; index: number; pinned: number[] } | null>(null);
  const pinnedIndexes = (): number[] => {
    const id = focusedIdRef.current;
    if (id === null) return [];
    // Focus can leave without a blur (the focused row was removed by live data): unpin then.
    const root = rootRef.current;
    if (root === null || !root.contains(root.ownerDocument.activeElement)) {
      focusedIdRef.current = null;
      return [];
    }
    const index = indexById.get(id);
    if (index === undefined) return [];
    const cached = pinCacheRef.current;
    if (cached !== null && cached.rows === rows && cached.index === index) return cached.pinned;
    const nearest = (step: 1 | -1): number | undefined => {
      for (let i = index + step; i >= 0 && i < rows.length; i += step) if (isNavigable(rows[i]!)) return i;
      return undefined;
    };
    const pinned = [...new Set([index - 1, index, index + 1, nearest(-1), nearest(1)])]
      .filter((i): i is number => i !== undefined && i >= 0 && i < rows.length)
      .sort((a, b) => a - b);
    pinCacheRef.current = { rows, index, pinned };
    return pinned;
  };
  // Reports the viewport's scroll offset to the virtualizer now, instead of on the next
  // `scroll` event (one per frame). `flush` re-renders the window synchronously: keys
  // pressed faster than frames would otherwise walk focus off the edge of a stale window.
  const syncOffsetRef = useRef<((flush: boolean) => void) | null>(null);
  const syncOffset = (flush: boolean) => syncOffsetRef.current?.(flush);
  // Forces a commit, so a pending scroll is checked even when nothing else re-renders.
  const [, requestCommit] = useReducer((n: number) => n + 1, 0);
  // Caption and header sit above the first row inside the viewport; a sticky header also
  // covers the top of it (a non-sticky one scrolls away with the rows).
  const [offsets, setOffsets] = useState({ scrollMargin: 0, header: 0 });

  useLayoutEffect(() => {
    const header = Math.round(theadRef.current?.getBoundingClientRect().height ?? 0);
    // A visually hidden caption is out of flow.
    const caption = captionHidden ? 0 : (captionRef.current?.getBoundingClientRect().height ?? 0);
    const scrollMargin = Math.round(caption) + header;
    setOffsets((prev) =>
      prev.scrollMargin === scrollMargin && prev.header === header ? prev : { scrollMargin, header },
    );
  });

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => rootRef.current,
    // The library sizes the scroll element by its border box (offsetHeight), which counts the
    // viewport's 1px top and bottom borders (and a horizontal scrollbar) as visible rows, so an
    // `"end"` scroll stopped ~2px short. The client box is the area rows actually show in.
    observeElementRect: observeClientRect,
    estimateSize: () => estimate,
    overscan: config.overscan,
    scrollMargin: offsets.scrollMargin,
    scrollPaddingStart: stickyHeader ? offsets.header : 0,
    getItemKey,
    // Rows are measured (once on mount, then on resize), keyed by row id: a row taller
    // than the estimate (a wrapped second line) moves the rows below it and the spacers.
    indexAttribute: ROW_INDEX_ATTRIBUTE,
    // Unrounded (the library default rounds): table rows are often fractional (e.g. 52.5px),
    // and a rounded size per row would drift by up to half a pixel a row.
    measureElement: (element, entry, instance) => {
      const box = entry?.borderBoxSize?.[0];
      const size = box !== undefined ? box.blockSize : element.getBoundingClientRect().height;
      if (size > 0) return size;
      // A hidden table (an inactive tab) measures 0: keep what is known instead of
      // collapsing every row, which would render them all.
      const key = instance.options.getItemKey(instance.indexFromElement(element));
      return instance.itemSizeCache.get(key) ?? estimate;
    },
    observeElementOffset: (instance, notify) => {
      syncOffsetRef.current = (flush) => {
        if (instance.scrollElement !== null) notify(instance.scrollElement.scrollTop, flush);
      };
      const unsubscribe = observeElementOffset(instance, notify);
      return () => {
        syncOffsetRef.current = null;
        unsubscribe?.();
      };
    },
    rangeExtractor: (range) => {
      const indexes = defaultRangeExtractor(range);
      const extra = pinnedIndexes().filter((i) => i < range.count && !indexes.includes(i));
      return extra.length === 0 ? indexes : [...indexes, ...extra].sort((a, b) => a - b);
    },
  });

  // Scroll by offset rather than `virtualizer.scrollToIndex`, which re-aims at the row
  // whenever a measurement changes for up to seconds, and so would undo a scroll the
  // user starts right after. Rows the scroll renders are measured in the next commit
  // and can move the target: the library compensates rows above the viewport, but not
  // the list growing below it, so a scroll to the last rows would stop short of the end
  // once they measure taller. A few bounded passes after those commits re-aim, and any
  // user scroll gesture (wheel, touch, pointer, scrolling key) cancels them. The target
  // is held by row id, like the focused row, so live re-sorts do not retarget it.
  const pendingScrollRef = useRef<{
    id: string;
    align: DataTableScrollAlign;
    passes: number;
    resolve: (completed: boolean) => void;
  } | null>(null);
  /** Ends the pending scroll: `completed` when it reached the row, else cancelled or superseded. */
  const settlePendingScroll = (completed = false) => {
    const pending = pendingScrollRef.current;
    pendingScrollRef.current = null;
    pending?.resolve(completed);
  };
  const cancelPendingScroll = () => settlePendingScroll(false);
  const scrollToRow = (index: number, align: DataTableScrollAlign, flush = false): Promise<boolean> => {
    cancelPendingScroll();
    const id = rows[index]?.id;
    const target = virtualizer.getOffsetForIndex(index, align);
    if (id === undefined || target === undefined) return Promise.resolve(false);
    return new Promise((resolve) => {
      pendingScrollRef.current = { id, align, passes: SCROLL_CORRECTION_PASSES, resolve };
      if (target[0] !== virtualizer.scrollOffset) virtualizer.scrollToOffset(target[0], { align: "start" });
      // Render the window at the new offset now, and check the scroll in the next commit.
      syncOffset(flush);
      requestCommit();
    });
  };

  // Rows measured in this commit (row refs run before this effect) may have moved the
  // pending target: re-aim while it is off. Once the row is rendered and in place, or the
  // passes run out, the scroll settles (and its promise resolves).
  useLayoutEffect(() => {
    const pending = pendingScrollRef.current;
    const viewport = rootRef.current;
    if (pending === null || viewport === null) return;
    const index = indexById.get(pending.id);
    const target = index === undefined ? undefined : virtualizer.getOffsetForIndex(index, pending.align);
    if (target === undefined) return cancelPendingScroll();
    const reachable = Math.min(target[0], viewport.scrollHeight - viewport.clientHeight);
    const rendered = virtualizer.getVirtualItems().some((item) => item.index === index);
    const aimed = Math.abs(viewport.scrollTop - reachable) <= 1;
    // Out of passes, it settles where it is: complete if the row is at least rendered.
    if ((rendered && aimed) || pending.passes <= 0) return settlePendingScroll(rendered);
    pending.passes -= 1;
    if (!aimed) virtualizer.scrollToOffset(reachable, { align: "start" });
    syncOffset(false);
    requestCommit();
  });

  // A key the browser turns into a scroll of the viewport. Keys a handler already took
  // (list navigation prevents the default and moves focus, which re-aims) do not cancel.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!event.defaultPrevented && SCROLL_KEYS.has(event.key)) cancelPendingScroll();
  };

  useLayoutEffect(() => {
    scrollRef.current = (index, align) => scrollToRow(index, align);
    return () => {
      scrollRef.current = null;
    };
  });
  // An unmount mid-scroll still resolves the caller's promise.
  useLayoutEffect(() => cancelPendingScroll, []);

  const onFocus = (event: FocusEvent<HTMLDivElement>) => {
    const row = (event.target as Element).closest(`[${ROW_INDEX_ATTRIBUTE}]`);
    focusedIdRef.current = row?.getAttribute("data-row-id") ?? null;
    if (row === null) return;
    void scrollToRow(Number(row.getAttribute(ROW_INDEX_ATTRIBUTE)), "auto", true);
  };

  const onBlur = (event: FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget;
    if (!(next instanceof Node) || !event.currentTarget.contains(next)) focusedIdRef.current = null;
  };

  const headerCount = headerRows.length;
  const body: ReactNode[] = [];
  let cursor = 0;
  for (const item of virtualizer.getVirtualItems()) {
    const row = rows[item.index];
    if (row === undefined) continue;
    const start = item.start - offsets.scrollMargin;
    if (start > cursor) body.push(<SpacerRow key={`gap-${item.index}`} height={start - cursor} columnCount={columnCount} />);
    body.push(
      renderRow(row, {
        index: item.index,
        ariaRowIndex: headerCount + item.index + 1,
        height: config.rowHeight,
        measure: virtualizer.measureElement,
      }),
    );
    cursor = start + item.size;
  }
  const trailing = virtualizer.getTotalSize() - cursor;
  if (trailing > 0) body.push(<SpacerRow key="gap-end" height={trailing} columnCount={columnCount} />);

  return (
    <div
      ref={rootRef}
      data-slot="data-table"
      data-density={density}
      data-virtualized=""
      role="region"
      aria-labelledby={captionId}
      // Focusable so keyboard users can scroll it.
      tabIndex={focusable ? 0 : undefined}
      onFocus={onFocus}
      onBlur={onBlur}
      onWheel={cancelPendingScroll}
      onTouchStart={cancelPendingScroll}
      onPointerDown={cancelPendingScroll}
      onKeyDown={onKeyDown}
      className={cn(ROOT_CLASS, "max-h-[70vh]", className)}
    >
      <table aria-rowcount={headerCount + rows.length} className="w-full caption-top border-collapse text-sm tabular-nums">
        <caption
          ref={captionRef}
          id={captionId}
          className={cn(captionHidden ? "sr-only" : "px-3 py-2 text-left text-sm text-muted-foreground")}
        >
          {caption}
        </caption>
        {colgroups}
        <TableHeader ref={theadRef}>{headerRows}</TableHeader>
        <TableBody>{body}</TableBody>
      </table>
    </div>
  );
}
