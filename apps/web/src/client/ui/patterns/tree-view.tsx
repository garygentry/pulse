// Pulse divergences from deck: `renderMeta` output is the treeitem's accessible description; opt-in
// row virtualization (`virtualize`, over `@tanstack/react-virtual`); `*` expands every sibling and
// printable keys jump by label (type-ahead); the row wraps, so a caller's meta can drop to a line of
// its own at narrow widths.
import { defaultRangeExtractor, observeElementOffset, useVirtualizer } from "@tanstack/react-virtual";
import {
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { useListNavigation } from "@/ui/hooks/use-list-navigation";
import { cssEscape } from "@/ui/lib/dom";
import {
  filterTreeNodes,
  textPredicate,
  visibleTreeRows,
  type TreeEntry,
  type VisibleTreeRow,
} from "@/ui/lib/tree";
import { cn } from "@/ui/lib/utils";
import { observeClientRect } from "@/ui/lib/virtual";
import { EmptyState } from "@/ui/patterns/empty-state";
import { Icon } from "@/ui/patterns/icon";

export interface TreeNodeState {
  readonly leaf: boolean;
  readonly expanded: boolean;
  readonly selected: boolean;
  readonly depth: number;
}

export interface TreeViewVirtualizeOptions {
  /** Virtualize when at least this many rows are visible (expanded). Default 300. */
  threshold?: number;
  /** Rows rendered beyond each edge of the viewport. Default 10. */
  overscan?: number;
  /** Row height in px assumed until a row is rendered and measured. Default 32. */
  rowHeight?: number;
}

/** Defaults for `virtualize`. */
export const TREE_VIEW_VIRTUALIZE_DEFAULTS = { threshold: 300, overscan: 10, rowHeight: 32 } as const;

/** A virtualized tree falls back to the nested one below `floor(threshold * this)` visible rows. */
const VIRTUALIZE_EXIT_RATIO = 0.8;

export interface TreeViewProps<T> {
  nodes: readonly T[];
  getId: (node: T) => string;
  getLabel: (node: T) => string;
  /** A node's children; omit for a flat list. */
  getChildren?: (node: T) => readonly T[] | undefined;
  /** Overrides "no children ⇒ leaf" (an empty folder is still a branch). */
  isLeaf?: (node: T) => boolean;
  /** Expanded branch ids (controlled). Pair with `onExpandedChange`. */
  expanded?: ReadonlySet<string>;
  /** Initially expanded branch ids (uncontrolled). */
  defaultExpanded?: Iterable<string>;
  onExpandedChange?: (expanded: ReadonlySet<string>) => void;
  /** The selected (current) node id: `aria-selected` + `aria-current`. */
  selectedId?: string | null;
  /** Raised when a leaf is activated (click, Enter, Space); branches too with `selectBranches`. */
  onSelect?: (node: T) => void;
  /** Branches are selectable as well as expandable. Default `false`: activating a branch toggles it. */
  selectBranches?: boolean;
  /** The row glyph; default folder / open folder / file. Must be decorative (`aria-hidden`). */
  renderIcon?: (node: T, state: TreeNodeState) => ReactNode;
  /** Trailing row content (a count, a badge). Plain text or badges only; never interactive. It is
   *  the treeitem's accessible description, read after the label. The row wraps: give the meta
   *  `basis-full` (e.g. under a container query) to put it on a line of its own. */
  renderMeta?: (node: T, state: TreeNodeState) => ReactNode;
  /**
   * Filter: text (case-insensitive substring of the label) or a predicate. A
   * match keeps its ancestors, which expand automatically. Memoize a predicate:
   * a new identity resets any branches collapsed while filtering.
   */
  filter?: string | ((node: T) => boolean);
  /** Shown (as a compact EmptyState) when there is nothing to show. */
  empty?: ReactNode;
  /**
   * Render only the rows in and near a bounded scroll viewport once at least `threshold` rows are
   * visible. The treeitems are then flat (no `group` nesting), each with `aria-level`,
   * `aria-setsize` and `aria-posinset` from the model; rows are measured as they render; the
   * focused row and the Tab stop stay rendered; keyboard moves reach rows that are not rendered
   * and scroll them into view. Hysteresis: once virtualized, the tree stays so until fewer than
   * `floor(threshold * 0.8)` rows are visible. Below the threshold the output is deck's.
   */
  virtualize?: boolean | TreeViewVirtualizeOptions;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  /** The tree's description, e.g. the id of visible keyboard help. */
  "aria-describedby"?: string;
  className?: string;
}

interface RowInfo<T> {
  readonly row: VisibleTreeRow<T>;
  readonly index: number;
  readonly labelId: string;
}

interface VirtualConfig {
  readonly threshold: number;
  readonly overscan: number;
  readonly rowHeight: number;
}

function virtualConfig(virtualize: TreeViewProps<unknown>["virtualize"]): VirtualConfig | null {
  if (virtualize === undefined || virtualize === false) return null;
  const options = virtualize === true ? {} : virtualize;
  return {
    threshold: options.threshold ?? TREE_VIEW_VIRTUALIZE_DEFAULTS.threshold,
    overscan: options.overscan ?? TREE_VIEW_VIRTUALIZE_DEFAULTS.overscan,
    rowHeight: options.rowHeight ?? TREE_VIEW_VIRTUALIZE_DEFAULTS.rowHeight,
  };
}

const EMPTY_SET: ReadonlySet<string> = new Set();

/** Type-ahead: keys typed within this many ms of the last extend the search string. */
const TYPEAHEAD_MS = 500;

function defaultIcon(state: TreeNodeState): ReactNode {
  const name = state.leaf ? "file" : state.expanded ? "folder-open" : "folder";
  return <Icon name={name} className="shrink-0 text-muted-foreground" />;
}

/**
 * A WAI-ARIA tree: `tree` > `treeitem` (> `group` > `treeitem` …) with
 * `aria-level`, `aria-setsize`/`aria-posinset`, `aria-expanded` on branches and
 * `aria-selected`/`aria-current` on the selected node.
 *
 * Keyboard (arrows preset of `useListNavigation`): ↑/↓ (and j/k) move, Home/End
 * jump, → expands a branch or steps into it, ← collapses or steps to the parent,
 * Enter activates (select a leaf, toggle a branch), Space toggles a branch or
 * selects a leaf, `*` expands every sibling branch, and other printable keys move
 * to the next row whose label starts with what was typed. One item is in the Tab
 * order (the last focused, else the selected, else the first).
 */
export function TreeView<T>({
  nodes,
  getId,
  getLabel,
  getChildren,
  isLeaf,
  expanded: expandedProp,
  defaultExpanded,
  onExpandedChange,
  selectedId = null,
  onSelect,
  selectBranches = false,
  renderIcon,
  renderMeta,
  filter,
  empty,
  virtualize,
  className,
  ...labelling
}: TreeViewProps<T>) {
  const baseId = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const rootRef = useRef<HTMLDivElement>(null);

  // Expansion: controlled or not.
  const [ownExpanded, setOwnExpanded] = useState<ReadonlySet<string>>(() => new Set(defaultExpanded ?? []));
  const expanded = expandedProp ?? ownExpanded;
  const setExpanded = (next: ReadonlySet<string>): void => {
    if (expandedProp === undefined) setOwnExpanded(next);
    onExpandedChange?.(next);
  };

  // Branches the user collapsed while a filter auto-expanded them; reset when the filter changes.
  const [filterCollapsed, setFilterCollapsed] = useState<{ key: unknown; ids: ReadonlySet<string> }>({
    key: filter,
    ids: EMPTY_SET,
  });
  const collapsedWhileFiltering = filterCollapsed.key === filter ? filterCollapsed.ids : EMPTY_SET;

  const predicate = typeof filter === "function" ? filter : textPredicate(filter ?? "", getLabel);
  const filtering = predicate !== undefined;
  const accessors = { getId, getChildren, isLeaf };
  const tree = useMemo(
    () => filterTreeNodes(nodes, accessors, predicate),
    // Accessors are read per call; the tree only changes with its inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [nodes, filter],
  );

  const effectiveExpanded = useMemo<ReadonlySet<string>>(() => {
    if (!filtering) return expanded;
    const all = new Set(expanded);
    for (const id of tree.autoExpanded) if (!collapsedWhileFiltering.has(id)) all.add(id);
    return all;
  }, [filtering, expanded, tree, collapsedWhileFiltering]);

  const rows = useMemo(() => visibleTreeRows(tree.entries, effectiveExpanded), [tree, effectiveExpanded]);
  const byId = useMemo(() => {
    const map = new Map<string, RowInfo<T>>();
    rows.forEach((row, index) => map.set(row.entry.id, { row, index, labelId: `${baseId}-label-${index}` }));
    return map;
  }, [rows, baseId]);

  // Virtualization, with hysteresis so expanding and collapsing around the threshold does not
  // switch layouts (and remount every row) on each crossing.
  const virtual = virtualConfig(virtualize);
  const [wasVirtualized, setWasVirtualized] = useState(false);
  const virtualized =
    virtual !== null &&
    (rows.length >= virtual.threshold ||
      (wasVirtualized && rows.length >= Math.max(1, Math.floor(virtual.threshold * VIRTUALIZE_EXIT_RATIO))));
  // Adjusting state during render (React's documented pattern); converges in one extra pass.
  if (virtualized !== wasVirtualized) setWasVirtualized(virtualized);

  const [activeId, setActiveId] = useState<string | null>(null);
  const tabStopId =
    activeId !== null && byId.has(activeId)
      ? activeId
      : selectedId !== null && byId.has(selectedId)
        ? selectedId
        : (rows[0]?.entry.id ?? null);

  const setBranches = (ids: readonly string[], open: boolean): void => {
    if (open) {
      const reopened = ids.filter((id) => collapsedWhileFiltering.has(id));
      if (reopened.length > 0) {
        const next = new Set(collapsedWhileFiltering);
        for (const id of reopened) next.delete(id);
        setFilterCollapsed({ key: filter, ids: next });
      }
      const closed = ids.filter((id) => !effectiveExpanded.has(id));
      if (closed.length > 0) {
        const next = new Set(expanded);
        for (const id of closed) next.add(id);
        setExpanded(next);
      }
      return;
    }
    const own = ids.filter((id) => expanded.has(id));
    if (own.length > 0) {
      const next = new Set(expanded);
      for (const id of own) next.delete(id);
      setExpanded(next);
    }
    const auto = filtering ? ids.filter((id) => tree.autoExpanded.has(id)) : [];
    if (auto.length > 0) {
      const next = new Set(collapsedWhileFiltering);
      for (const id of auto) next.add(id);
      setFilterCollapsed({ key: filter, ids: next });
    }
  };
  const setBranch = (id: string, open: boolean): void => setBranches([id], open);

  const activate = (entry: TreeEntry<T>): void => {
    if (entry.leaf || selectBranches) onSelect?.(entry.node);
    if (!entry.leaf) setBranch(entry.id, !effectiveExpanded.has(entry.id));
  };

  const itemEl = (id: string): HTMLElement | null =>
    rootRef.current?.querySelector<HTMLElement>(`[role="treeitem"][data-tree-id="${cssEscape(id)}"]`) ?? null;
  const entryOfEl = (el: HTMLElement): RowInfo<T> | undefined => byId.get(el.dataset.treeId ?? "");

  // A virtualized tree may not have the row in the DOM: its body renders the row, then focuses it.
  const virtualFocusRef = useRef<((id: string) => void) | null>(null);
  const focusRow = (id: string): void => {
    if (virtualFocusRef.current !== null) {
      setActiveId(id); // kept rendered from the next commit
      virtualFocusRef.current(id);
    } else {
      itemEl(id)?.focus();
    }
  };

  /** The focused row, from the DOM's focus (not `activeId`, which outlives a blur). */
  const focusedInfo = (): RowInfo<T> | undefined => {
    const root = rootRef.current;
    const active = root?.ownerDocument.activeElement;
    if (root === null || root === undefined || !(active instanceof HTMLElement)) return undefined;
    if (active.getAttribute("role") !== "treeitem" || !root.contains(active)) return undefined;
    return entryOfEl(active);
  };

  useListNavigation({
    scope: "element",
    containerRef: rootRef,
    keys: "arrows",
    getItems: () => rootRef.current?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? [],
    // Virtualized, moves are worked out over every visible row, rendered or not.
    ...(virtualized
      ? {
          virtual: {
            count: () => rows.length,
            activeIndex: () => focusedInfo()?.index ?? -1,
            focus: (index: number) => {
              const row = rows[index];
              if (row !== undefined) focusRow(row.entry.id);
            },
          },
        }
      : {}),
    onActivate: (el) => {
      const info = entryOfEl(el);
      if (info !== undefined) activate(info.row.entry);
    },
    onToggle: (el) => {
      const info = entryOfEl(el);
      if (info === undefined) return;
      const { entry } = info.row;
      if (entry.leaf) onSelect?.(entry.node);
      else setBranch(entry.id, !effectiveExpanded.has(entry.id));
    },
    onExpand: (el) => {
      const info = entryOfEl(el);
      if (info === undefined || info.row.entry.leaf) return;
      const { entry } = info.row;
      if (!effectiveExpanded.has(entry.id)) setBranch(entry.id, true);
      else if (entry.children[0] !== undefined) focusRow(entry.children[0].id);
    },
    onCollapse: (el) => {
      const info = entryOfEl(el);
      if (info === undefined) return;
      const { entry, parentId } = info.row;
      if (!entry.leaf && effectiveExpanded.has(entry.id)) setBranch(entry.id, false);
      else if (parentId !== null) focusRow(parentId);
    },
  });

  // The tree keys outside `useListNavigation`'s list grammar: `*` and type-ahead (WAI-ARIA tree
  // pattern). React's root listener runs after the hook's element listener, so these see only keys
  // it left alone (`defaultPrevented` is set on the rest, j/k included). They work from the model,
  // so they reach rows a virtualized tree has not rendered.
  const typeahead = useRef({ text: "", at: Number.NEGATIVE_INFINITY });
  const onTreeKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key.length !== 1 || event.key === " ") return;
    const info = focusedInfo();
    if (info === undefined) return;
    if (event.key === "*") {
      const { parentId } = info.row;
      const siblings = parentId === null ? tree.entries : (byId.get(parentId)?.row.entry.children ?? []);
      setBranches(siblings.filter((sibling) => !sibling.leaf).map((sibling) => sibling.id), true);
      event.preventDefault();
      return;
    }
    const now = performance.now();
    const state = typeahead.current;
    const key = event.key.toLowerCase();
    state.text = now - state.at <= TYPEAHEAD_MS ? state.text + key : key;
    state.at = now;
    // A repeated key cycles through the rows starting with it; a longer string first checks the
    // focused row, which may still match as more is typed.
    const repeated = [...state.text].every((char) => char === key);
    const needle = repeated ? key : state.text;
    const start = repeated ? info.index + 1 : info.index;
    for (let step = 0; step < rows.length; step += 1) {
      const row = rows[(start + step) % rows.length]!;
      if (getLabel(row.entry.node).toLowerCase().startsWith(needle)) {
        if (row.entry.id !== info.row.entry.id) focusRow(row.entry.id);
        event.preventDefault();
        return;
      }
    }
  };

  // Switching layouts remounts every row: give focus back to the row that had it.
  const focusWithinRef = useRef(false);
  const onFocusWithin = (): void => {
    focusWithinRef.current = true;
  };
  const onBlurWithin = (event: FocusEvent<HTMLElement>): void => {
    // A removed row blurs with no `relatedTarget`; only focus moving elsewhere counts as leaving.
    const next = event.relatedTarget;
    if (next instanceof Node && !event.currentTarget.contains(next)) focusWithinRef.current = false;
  };
  const layoutRef = useRef(virtualized);
  useLayoutEffect(() => {
    if (layoutRef.current === virtualized) return;
    layoutRef.current = virtualized;
    const doc = rootRef.current?.ownerDocument;
    const lost = doc !== undefined && (doc.activeElement === null || doc.activeElement === doc.body);
    if (focusWithinRef.current && lost && tabStopId !== null) focusRow(tabStopId);
  });

  const renderItem = (row: VisibleTreeRow<T>, children: ReactNode, measure?: VirtualItemProps): ReactElement => {
    const { entry, depth } = row;
    const open = !entry.leaf && effectiveExpanded.has(entry.id);
    const selected = entry.id === selectedId;
    const selectable = entry.leaf || selectBranches;
    const state: TreeNodeState = { leaf: entry.leaf, expanded: open, selected, depth };
    const labelId = byId.get(entry.id)?.labelId;
    const meta = renderMeta?.(entry.node, state);
    const hasMeta = meta !== undefined && meta !== null && meta !== false && meta !== "";
    const metaId = hasMeta && labelId !== undefined ? `${labelId}-meta` : undefined;
    return (
      <li
        key={entry.id}
        role="treeitem"
        data-tree-id={entry.id}
        {...(measure !== undefined ? { "data-index": measure.index, ref: measure.measure } : {})}
        aria-labelledby={labelId}
        aria-describedby={metaId}
        aria-level={depth + 1}
        aria-setsize={row.setSize}
        aria-posinset={row.posInSet}
        aria-expanded={entry.leaf ? undefined : open}
        aria-selected={selectable ? selected : undefined}
        aria-current={selected ? "true" : undefined}
        tabIndex={entry.id === tabStopId ? 0 : -1}
        onFocus={(event) => {
          if (event.target === event.currentTarget) setActiveId(entry.id);
        }}
        className="outline-none [&:focus-visible>[data-tree-row]]:ring-[3px] [&:focus-visible>[data-tree-row]]:ring-ring/50"
      >
        {/* The row: click target and indentation. Keyboard lives on the treeitem. */}
        <div
          data-tree-row=""
          data-selected={selected ? "" : undefined}
          onClick={() => activate(entry)}
          style={{ "--tree-depth": depth } as CSSProperties}
          className={cn(
            "flex cursor-pointer flex-wrap items-center gap-x-1.5 gap-y-1 rounded-md py-1 pe-2 ps-[calc(var(--tree-depth)*1rem+0.25rem)] text-sm select-none",
            "hover:bg-accent hover:text-accent-foreground",
            selected && "bg-accent font-medium text-accent-foreground",
          )}
        >
          {entry.leaf ? (
            <span className="size-4 shrink-0" />
          ) : (
            <Icon
              name="chevron-right"
              className={cn("shrink-0 text-muted-foreground transition-transform", open && "rotate-90")}
            />
          )}
          {renderIcon !== undefined ? renderIcon(entry.node, state) : defaultIcon(state)}
          <span id={labelId} className="min-w-0 flex-1 truncate">
            {getLabel(entry.node)}
          </span>
          {hasMeta ? (
            <span id={metaId} className="contents">
              {meta}
            </span>
          ) : null}
        </div>
        {children}
      </li>
    );
  };

  const renderLevel = (entries: readonly TreeEntry<T>[]): ReactNode =>
    entries.map((entry) => {
      const info = byId.get(entry.id);
      if (info === undefined) return null;
      const open = !entry.leaf && effectiveExpanded.has(entry.id);
      return renderItem(
        info.row,
        open && entry.children.length > 0 ? (
          <ul role="group" className="m-0 list-none p-0">
            {renderLevel(entry.children)}
          </ul>
        ) : null,
      );
    });

  return (
    <div
      data-slot="tree-view"
      data-virtualized={virtualized ? "" : undefined}
      ref={rootRef}
      onKeyDown={onTreeKeyDown}
      onFocus={onFocusWithin}
      onBlur={onBlurWithin}
      className={cn("min-w-0", className)}
    >
      {tree.entries.length === 0 ? (
        <EmptyState compact icon={filtering ? "search-x" : "inbox"} title={empty ?? (filtering ? "No matches" : "Nothing to show")} />
      ) : virtualized && virtual !== null ? (
        <VirtualTreeBody
          rows={rows}
          config={virtual}
          keepIds={[tabStopId, activeId]}
          focusRef={virtualFocusRef}
          itemEl={itemEl}
          renderItem={(row, measure) => renderItem(row, null, measure)}
          labelling={labelling}
        />
      ) : (
        <ul role="tree" className="m-0 list-none p-0" {...labelling}>
          {renderLevel(tree.entries)}
        </ul>
      )}
    </div>
  );
}

/** How a virtualized row reports its index and rendered height. */
interface VirtualItemProps {
  readonly index: number;
  readonly measure: (node: HTMLElement | null) => void;
}

/**
 * After a scroll to a row, how many commits may re-aim at it once the rows the scroll rendered are
 * measured, and for how long (ms). As in `DataTable`.
 */
const SCROLL_CORRECTION = { passes: 3, ms: 500 } as const;

interface VirtualTreeBodyProps<T> {
  rows: readonly VisibleTreeRow<T>[];
  config: VirtualConfig;
  /** Rows that stay rendered wherever the window is: the Tab stop and the focused row. */
  keepIds: readonly (string | null)[];
  /** Set to "render this row if it is not, then focus it". */
  focusRef: { current: ((id: string) => void) | null };
  itemEl: (id: string) => HTMLElement | null;
  renderItem: (row: VisibleTreeRow<T>, measure: VirtualItemProps) => ReactElement;
  labelling: Pick<TreeViewProps<T>, "aria-label" | "aria-labelledby" | "aria-describedby">;
}

/** An `aria-hidden` spacer standing in for `height` px of rows that are not rendered. */
function Spacer({ height }: { height: number }) {
  return <li aria-hidden="true" role="none" data-slot="tree-view-spacer" style={{ height }} />;
}

/**
 * The virtualized tree: a bounded scroll viewport over `useVirtualizer`, the visible rows as flat
 * treeitems with spacers above and below the rendered window. Modelled on `DataTable`'s.
 */
function VirtualTreeBody<T>({ rows, config, keepIds, focusRef, itemEl, renderItem, labelling }: VirtualTreeBodyProps<T>) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const indexOf = (id: string | null): number => (id === null ? -1 : rows.findIndex((row) => row.entry.id === id));
  // Reports the scroll offset to the virtualizer and re-renders the window now, not on the next
  // `scroll` event: keys pressed faster than frames would otherwise walk off a stale window.
  const syncOffsetRef = useRef<(() => void) | null>(null);
  // A row asked for focus before it was rendered.
  const pendingFocusRef = useRef<string | null>(null);
  // Set while a layout effect focuses a row: React cannot flush a synchronous re-render then.
  const inEffectRef = useRef(false);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => viewportRef.current,
    // The client box, not the border box: the area rows actually show in (see `DataTable`).
    observeElementRect: observeClientRect,
    estimateSize: () => config.rowHeight,
    overscan: config.overscan,
    getItemKey: (index) => rows[index]?.entry.id ?? index,
    // Unrounded, as in `DataTable`; a hidden tree (an inactive tab) measures 0, so keep what is known.
    measureElement: (element, entry, instance) => {
      const box = entry?.borderBoxSize?.[0];
      const size = box !== undefined ? box.blockSize : element.getBoundingClientRect().height;
      if (size > 0) return size;
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
      const extra = [...keepIds, pendingFocusRef.current]
        .map(indexOf)
        .filter((index) => index !== -1 && index < range.count && !indexes.includes(index));
      return extra.length === 0 ? indexes : [...new Set([...indexes, ...extra])].sort((a, b) => a - b);
    },
  });

  // Scroll by offset with a few bounded re-aims once the rendered rows are measured (see
  // `DataTable`'s `scrollToRow`); any user scroll gesture cancels them. Held by row id.
  const pendingScrollRef = useRef<{ id: string; passes: number; until: number } | null>(null);
  const scrollToRow = (index: number): void => {
    pendingScrollRef.current = null;
    const target = virtualizer.getOffsetForIndex(index, "auto");
    const id = rows[index]?.entry.id;
    if (target === undefined || id === undefined || target[0] === virtualizer.scrollOffset) return;
    pendingScrollRef.current = { id, passes: SCROLL_CORRECTION.passes, until: performance.now() + SCROLL_CORRECTION.ms };
    virtualizer.scrollToOffset(target[0], { align: "start" });
  };
  const cancelPendingScroll = (): void => {
    pendingScrollRef.current = null;
  };

  useLayoutEffect(() => {
    const pendingFocus = pendingFocusRef.current;
    if (pendingFocus !== null) {
      const el = itemEl(pendingFocus);
      if (el !== null) {
        pendingFocusRef.current = null;
        inEffectRef.current = true;
        try {
          el.focus();
        } finally {
          inEffectRef.current = false;
        }
      } else if (indexOf(pendingFocus) === -1) {
        pendingFocusRef.current = null;
      }
    }
    const pending = pendingScrollRef.current;
    const viewport = viewportRef.current;
    if (pending === null || viewport === null) return;
    const index = indexOf(pending.id);
    const rendered = index !== -1 && virtualizer.getVirtualItems().some((item) => item.index === index);
    const target = index === -1 ? undefined : virtualizer.getOffsetForIndex(index, "auto");
    const reachable =
      target === undefined ? undefined : Math.min(target[0], viewport.scrollHeight - viewport.clientHeight);
    const expired = pending.passes <= 0 || performance.now() > pending.until;
    if (reachable === undefined || expired) {
      pendingScrollRef.current = null;
      return;
    }
    // Until the virtualizer has seen the scroll (its `scroll` event), the rows around the target are
    // not rendered or measured yet, so "in place" means nothing: wait for that commit.
    if (Math.abs((virtualizer.scrollOffset ?? 0) - viewport.scrollTop) > 1) return;
    if (rendered && Math.abs(viewport.scrollTop - reachable) <= 1) {
      pendingScrollRef.current = null;
      return;
    }
    pending.passes -= 1;
    if (Math.abs(viewport.scrollTop - reachable) > 1) virtualizer.scrollToOffset(reachable, { align: "start" });
  });

  useLayoutEffect(() => {
    focusRef.current = (id) => {
      const el = itemEl(id);
      if (el !== null) {
        el.focus();
        return;
      }
      const index = indexOf(id);
      if (index === -1) return;
      // Rendered on the next commit (`rangeExtractor` keeps it), focused by the effect above.
      pendingFocusRef.current = id;
      scrollToRow(index);
    };
    return () => {
      focusRef.current = null;
    };
  });

  // Keyboard focus moving to a row scrolls it fully into view.
  const onFocus = (event: FocusEvent<HTMLDivElement>): void => {
    const item = (event.target as Element).closest('[role="treeitem"]');
    if (item === null) return;
    const index = indexOf(item.getAttribute("data-tree-id"));
    if (index === -1) return;
    scrollToRow(index);
    if (!inEffectRef.current) syncOffsetRef.current?.();
  };

  const body: ReactNode[] = [];
  let cursor = 0;
  for (const item of virtualizer.getVirtualItems()) {
    const row = rows[item.index];
    if (row === undefined) continue;
    if (item.start > cursor) body.push(<Spacer key={`gap-${item.index}`} height={item.start - cursor} />);
    body.push(renderItem(row, { index: item.index, measure: virtualizer.measureElement }));
    cursor = item.start + item.size;
  }
  const trailing = virtualizer.getTotalSize() - cursor;
  if (trailing > 0) body.push(<Spacer key="gap-end" height={trailing} />);

  return (
    <div
      ref={viewportRef}
      data-slot="tree-view-viewport"
      onFocus={onFocus}
      onWheel={cancelPendingScroll}
      onTouchStart={cancelPendingScroll}
      onPointerDown={cancelPendingScroll}
      className="relative max-h-[70vh] overflow-auto overscroll-contain"
    >
      <ul role="tree" className="m-0 list-none p-0" {...labelling}>
        {body}
      </ul>
    </div>
  );
}
