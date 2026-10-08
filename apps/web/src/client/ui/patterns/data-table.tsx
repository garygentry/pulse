/**
 * Pulse edit: opt-in row virtualization (`virtualize`, over `@tanstack/react-virtual`;
 * rows are measured, so variable-height rows are placed exactly), a `ref` handle with
 * `scrollToIndex`, and `focusable` (drop the scroll region's tab stop on a wallboard).
 * Below the threshold, with the defaults, the table renders as deck's does; the
 * virtualized path is a separate component.
 */
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
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ElementType,
  type FocusEvent,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  type Ref,
} from "react";
import { cn } from "@/ui/lib/utils";
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
   * Scroll the row at `index` (into `data`) into view. On a virtualized table
   * this renders the row first, so it can be focused afterwards.
   */
  scrollToIndex: (index: number, options?: { align?: DataTableScrollAlign }) => void;
}

export interface DataTableVirtualizeOptions {
  /** Virtualize when there are at least this many rows. Default 300. */
  threshold?: number;
  /** Rows rendered beyond each edge of the viewport. Default 8. */
  overscan?: number;
  /**
   * Row height in px: the size assumed for a row until it is rendered and measured, and
   * each row's minimum height. Default 36 (`compact`) or 48 (`comfortable`). Rows taller
   * than this (a second line of text) are measured, so offsets stay exact.
   */
  rowHeight?: number;
}

/** A virtualized table falls back to a plain one below `floor(threshold * this)` rows. */
const DATA_TABLE_VIRTUALIZE_EXIT_RATIO = 0.8;

/** Defaults for `virtualize`. */
export const DATA_TABLE_VIRTUALIZE_DEFAULTS = {
  threshold: 300,
  overscan: 8,
  rowHeight: { compact: 36, comfortable: 48 },
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
  /** DOM `id` for a row (plus `tabIndex=-1`), so a hash or a script can focus it. */
  rowDomId?: (row: T) => string;
  /** The first column's cells are row headers (`th scope="row"`). Default `true`. */
  rowHeader?: boolean;
  /** Shown in one full-width row when `data` is empty: a title, or full EmptyState props. */
  empty?: ReactNode | Omit<EmptyStateProps, "compact">;
  /** `compact` (default, D16: compact tables) or `comfortable`. */
  density?: "comfortable" | "compact";
  /** Header cells stick to the top of the scroll region (bound its height via `className`). Default `true`. */
  stickyHeader?: boolean;
  /** Classes for the scroll region (the root), e.g. `max-h-96` for a sticky header. */
  className?: string;
  /**
   * The scroll region is a tab stop, so keyboard users can scroll it. Default `true`. Pass
   * `false` where nobody interacts (a kiosk wallboard) so the page has no idle tab stops.
   */
  focusable?: boolean;
  /**
   * Render only the rows in view (plus `overscan`) once there are `threshold` rows
   * or more. The scroll region is then the `data-table-viewport` element, bounded
   * by a default max height (override it with `className`, e.g. `max-h-96`); rows
   * are at least `rowHeight` tall and each rendered row is measured, so rows of
   * varying height keep the spacers, scrollbar and `scrollToIndex` exact; the
   * table carries `aria-rowcount` and each row `aria-rowindex`. A focused row
   * stays rendered (tracked by row id, so it survives rows inserted or re-sorted
   * above it) and is scrolled into view, so Tab and arrow keys move across the
   * rendered window. `true` uses the defaults.
   *
   * Hysteresis: once a mounted table virtualizes, it stays virtualized until it
   * has fewer than `floor(threshold * 0.8)` rows (at least 1), so live data
   * hovering around the threshold does not remount the table (losing scroll and
   * focus) on every crossing. A table that has never virtualized renders as deck's.
   */
  virtualize?: boolean | DataTableVirtualizeOptions;
  /** Imperative handle: `scrollToIndex(index)` works with and without `virtualize`. */
  ref?: Ref<DataTableHandle>;
}

interface VirtualConfig {
  threshold: number;
  overscan: number;
  rowHeight: number;
}

function virtualConfig(
  virtualize: DataTableProps<unknown>["virtualize"],
  density: "comfortable" | "compact",
): VirtualConfig | null {
  if (virtualize === undefined || virtualize === false) return null;
  const options = virtualize === true ? {} : virtualize;
  return {
    threshold: options.threshold ?? DATA_TABLE_VIRTUALIZE_DEFAULTS.threshold,
    overscan: options.overscan ?? DATA_TABLE_VIRTUALIZE_DEFAULTS.overscan,
    rowHeight: options.rowHeight ?? DATA_TABLE_VIRTUALIZE_DEFAULTS.rowHeight[density],
  };
}

const ROW_INDEX_ATTRIBUTE = "data-row-index";

const scrollBlock = (align: DataTableScrollAlign | undefined): ScrollLogicalPosition =>
  align === undefined || align === "auto" ? "nearest" : align;

const isEmptyStateProps = (value: unknown): value is Omit<EmptyStateProps, "compact"> =>
  typeof value === "object" && value !== null && !Array.isArray(value) && "title" in value && !("$$typeof" in value);

function alignClass<T>(column: Column<T, unknown>): string | undefined {
  return column.columnDef.meta?.align === "end" ? "text-right" : undefined;
}

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

  const cellPad = density === "compact" ? "h-8 px-2 py-1" : "h-11 px-3 py-2.5";
  const rows = table.getRowModel().rows;
  const virtual = virtualConfig(virtualize, density);
  // Hysteresis (see `virtualize`): stay virtualized down to the exit bound once on.
  const [wasVirtualized, setWasVirtualized] = useState(false);
  const virtualized =
    virtual !== null &&
    (rows.length >= virtual.threshold ||
      (wasVirtualized &&
        rows.length >= Math.max(1, Math.floor(virtual.threshold * DATA_TABLE_VIRTUALIZE_EXIT_RATIO))));
  // Derived state from the previous render (React re-runs this render before committing).
  if (virtualized !== wasVirtualized) setWasVirtualized(virtualized);

  const rootRef = useRef<HTMLDivElement>(null);
  const virtualScrollRef = useRef<DataTableHandle["scrollToIndex"] | null>(null);
  useImperativeHandle(
    ref,
    () => ({
      scrollToIndex(index, options) {
        if (virtualScrollRef.current !== null) {
          virtualScrollRef.current(index, options);
          return;
        }
        const row = rootRef.current?.querySelector("tbody")?.children[index];
        row?.scrollIntoView({ block: scrollBlock(options?.align) });
      },
    }),
    [],
  );
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
              // A row's minimum height (a table row grows to its content); its real
              // height is measured through `ref`.
              style: { height: position.minHeight },
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
      className={cn(
        "relative w-full overflow-auto rounded-md border outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
        className,
      )}
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
              <TableCell colSpan={Math.max(1, leafColumns.length)} className="px-3">
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
  minHeight: number;
  measure: (node: HTMLTableRowElement | null) => void;
}

/**
 * After `scrollToIndex`, how many commits may re-aim at the row once the rows the
 * scroll rendered are measured, and for how long (ms) (see `scrollToRow`).
 */
const SCROLL_CORRECTION = { passes: 3, ms: 500 } as const;

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
  rootRef: Ref<HTMLDivElement>;
  scrollRef: { current: DataTableHandle["scrollToIndex"] | null };
  config: VirtualConfig;
  rows: Row<T>[];
  renderRow: (row: Row<T>, position: VirtualRowPosition) => ReactElement;
  headerRows: ReactElement[];
  colgroups: ReactNode;
  columnCount: number;
  caption: ReactNode;
  captionHidden: boolean;
  captionId: string;
  density: "comfortable" | "compact";
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
 * The virtualized body of `DataTable`: a bounded scroll viewport (sticky header,
 * spacer rows above and below the rendered window) over `useVirtualizer`.
 */
function VirtualizedTable<T>({
  rootRef,
  scrollRef,
  config,
  rows,
  renderRow,
  headerRows,
  colgroups,
  columnCount,
  caption,
  captionHidden,
  captionId,
  density,
  className,
  focusable,
}: VirtualizedTableProps<T>) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const theadRef = useRef<HTMLTableSectionElement>(null);
  const captionRef = useRef<HTMLTableCaptionElement>(null);
  // The row holding focus stays rendered while it is scrolled out of the window,
  // so focus is never dropped to the body.
  // Tracked by row id, not index: live data re-sorting or inserting rows above it
  // moves the row, and its current index is resolved from `rows` on each use.
  const focusedIdRef = useRef<string | null>(null);
  const focusedIndex = (): number | null => {
    const id = focusedIdRef.current;
    if (id === null) return null;
    const index = rows.findIndex((row) => row.id === id);
    return index === -1 ? null : index;
  };
  // Reports the viewport's scroll offset to the virtualizer now, and re-renders the
  // window synchronously, instead of on the next `scroll` event (one per frame):
  // keys pressed faster than frames would otherwise walk focus off the edge of a
  // stale window.
  const syncOffsetRef = useRef<(() => void) | null>(null);
  // Caption and header sit above the first row inside the viewport; the sticky
  // header also covers the top of it.
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
    getScrollElement: () => viewportRef.current,
    estimateSize: () => config.rowHeight,
    overscan: config.overscan,
    scrollMargin: offsets.scrollMargin,
    scrollPaddingStart: offsets.header,
    getItemKey: (index) => rows[index]?.id ?? index,
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
      return instance.itemSizeCache.get(key) ?? config.rowHeight;
    },
    observeElementOffset: (instance, notify) => {
      syncOffsetRef.current = () => {
        if (instance.scrollElement !== null) notify(instance.scrollElement.scrollTop, true);
      };
      const unsubscribe = observeElementOffset(instance, notify);
      return () => {
        syncOffsetRef.current = null;
        unsubscribe?.();
      };
    },
    rangeExtractor: (range) => {
      const indexes = defaultRangeExtractor(range);
      const focused = focusedIndex();
      if (focused === null || focused >= range.count || indexes.includes(focused)) return indexes;
      return [...indexes, focused].sort((a, b) => a - b);
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
    until: number;
  } | null>(null);
  const scrollToRow = (index: number, align: DataTableScrollAlign): void => {
    pendingScrollRef.current = null;
    const target = virtualizer.getOffsetForIndex(index, align);
    const id = rows[index]?.id;
    if (target === undefined || id === undefined || target[0] === virtualizer.scrollOffset) return;
    pendingScrollRef.current = {
      id,
      align,
      passes: SCROLL_CORRECTION.passes,
      until: performance.now() + SCROLL_CORRECTION.ms,
    };
    virtualizer.scrollToOffset(target[0], { align: "start" });
  };

  // Rows measured in this commit (row refs run before this effect) may have moved the
  // pending target: re-aim while it is off. Once the row is rendered and in place, done.
  useLayoutEffect(() => {
    const pending = pendingScrollRef.current;
    const viewport = viewportRef.current;
    if (pending === null || viewport === null) return;
    const index = rows.findIndex((row) => row.id === pending.id);
    const rendered = index !== -1 && virtualizer.getVirtualItems().some((item) => item.index === index);
    const target = index === -1 ? undefined : virtualizer.getOffsetForIndex(index, pending.align);
    const reachable =
      target === undefined ? undefined : Math.min(target[0], viewport.scrollHeight - viewport.clientHeight);
    const expired = pending.passes <= 0 || performance.now() > pending.until;
    if (reachable === undefined || expired || (rendered && Math.abs(viewport.scrollTop - reachable) <= 1)) {
      pendingScrollRef.current = null;
      return;
    }
    pending.passes -= 1;
    if (Math.abs(viewport.scrollTop - reachable) > 1) virtualizer.scrollToOffset(reachable, { align: "start" });
  });

  const cancelPendingScroll = () => {
    pendingScrollRef.current = null;
  };
  // A key the browser turns into a scroll of the viewport. Keys a handler already took
  // (list navigation prevents the default and moves focus, which re-aims) do not cancel.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!event.defaultPrevented && SCROLL_KEYS.has(event.key)) cancelPendingScroll();
  };

  useLayoutEffect(() => {
    scrollRef.current = (index, options) => scrollToRow(index, options?.align ?? "auto");
    return () => {
      scrollRef.current = null;
    };
  });

  const onFocus = (event: FocusEvent<HTMLDivElement>) => {
    const row = (event.target as Element).closest(`[${ROW_INDEX_ATTRIBUTE}]`);
    if (row === null) return;
    focusedIdRef.current = row.getAttribute("data-row-id");
    scrollToRow(Number(row.getAttribute(ROW_INDEX_ATTRIBUTE)), "auto");
    syncOffsetRef.current?.();
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
        minHeight: config.rowHeight,
        measure: virtualizer.measureElement,
      }),
    );
    cursor = start + item.size;
  }
  const trailing = virtualizer.getTotalSize() - cursor;
  if (trailing > 0) body.push(<SpacerRow key="gap-end" height={trailing} columnCount={columnCount} />);

  return (
    <div ref={rootRef} data-slot="data-table" data-density={density} data-virtualized="" className="relative w-full">
      <div
        ref={viewportRef}
        data-slot="data-table-viewport"
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
        className={cn(
          "relative max-h-[70vh] w-full overflow-auto rounded-md border outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
          className,
        )}
      >
        <table
          aria-rowcount={headerCount + rows.length}
          className="w-full caption-top border-collapse text-sm tabular-nums"
        >
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
    </div>
  );
}
