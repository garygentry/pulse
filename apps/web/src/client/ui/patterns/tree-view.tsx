// Pulse divergence from deck: `renderMeta` output is the treeitem's accessible description.
import { useId, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
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
import { EmptyState } from "@/ui/patterns/empty-state";
import { Icon } from "@/ui/patterns/icon";

export interface TreeNodeState {
  readonly leaf: boolean;
  readonly expanded: boolean;
  readonly selected: boolean;
  readonly depth: number;
}

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
   *  the treeitem's accessible description, read after the label. */
  renderMeta?: (node: T, state: TreeNodeState) => ReactNode;
  /**
   * Filter: text (case-insensitive substring of the label) or a predicate. A
   * match keeps its ancestors, which expand automatically. Memoize a predicate:
   * a new identity resets any branches collapsed while filtering.
   */
  filter?: string | ((node: T) => boolean);
  /** Shown (as a compact EmptyState) when there is nothing to show. */
  empty?: ReactNode;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  className?: string;
}

interface RowInfo<T> {
  readonly row: VisibleTreeRow<T>;
  readonly labelId: string;
}

const EMPTY_SET: ReadonlySet<string> = new Set();

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
 * selects a leaf. One item is in the Tab order (the last focused, else the
 * selected, else the first).
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
    rows.forEach((row, index) => map.set(row.entry.id, { row, labelId: `${baseId}-label-${index}` }));
    return map;
  }, [rows, baseId]);

  const [activeId, setActiveId] = useState<string | null>(null);
  const tabStopId =
    activeId !== null && byId.has(activeId)
      ? activeId
      : selectedId !== null && byId.has(selectedId)
        ? selectedId
        : (rows[0]?.entry.id ?? null);

  const setBranch = (id: string, open: boolean): void => {
    if (open) {
      if (collapsedWhileFiltering.has(id)) {
        const ids = new Set(collapsedWhileFiltering);
        ids.delete(id);
        setFilterCollapsed({ key: filter, ids });
      }
      if (!effectiveExpanded.has(id)) setExpanded(new Set(expanded).add(id));
      return;
    }
    if (expanded.has(id)) {
      const next = new Set(expanded);
      next.delete(id);
      setExpanded(next);
    }
    if (filtering && tree.autoExpanded.has(id)) {
      setFilterCollapsed({ key: filter, ids: new Set(collapsedWhileFiltering).add(id) });
    }
  };

  const activate = (entry: TreeEntry<T>): void => {
    if (entry.leaf || selectBranches) onSelect?.(entry.node);
    if (!entry.leaf) setBranch(entry.id, !effectiveExpanded.has(entry.id));
  };

  const itemEl = (id: string): HTMLElement | null =>
    rootRef.current?.querySelector<HTMLElement>(`[role="treeitem"][data-tree-id="${cssEscape(id)}"]`) ?? null;
  const entryOfEl = (el: HTMLElement): RowInfo<T> | undefined => byId.get(el.dataset.treeId ?? "");

  useListNavigation({
    scope: "element",
    containerRef: rootRef,
    keys: "arrows",
    getItems: () => rootRef.current?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? [],
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
      else if (entry.children[0] !== undefined) itemEl(entry.children[0].id)?.focus();
    },
    onCollapse: (el) => {
      const info = entryOfEl(el);
      if (info === undefined) return;
      const { entry, parentId } = info.row;
      if (!entry.leaf && effectiveExpanded.has(entry.id)) setBranch(entry.id, false);
      else if (parentId !== null) itemEl(parentId)?.focus();
    },
  });

  const renderLevel = (entries: readonly TreeEntry<T>[], depth: number): ReactNode =>
    entries.map((entry, index) => {
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
          aria-labelledby={labelId}
          aria-describedby={metaId}
          aria-level={depth + 1}
          aria-setsize={entries.length}
          aria-posinset={index + 1}
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
              "flex cursor-pointer items-center gap-1.5 rounded-md py-1 pe-2 ps-[calc(var(--tree-depth)*1rem+0.25rem)] text-sm select-none",
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
          {open && entry.children.length > 0 ? (
            <ul role="group" className="m-0 list-none p-0">
              {renderLevel(entry.children, depth + 1)}
            </ul>
          ) : null}
        </li>
      );
    });

  return (
    <div data-slot="tree-view" ref={rootRef} className={cn("min-w-0", className)}>
      {tree.entries.length === 0 ? (
        <EmptyState compact icon={filtering ? "search-x" : "inbox"} title={empty ?? (filtering ? "No matches" : "Nothing to show")} />
      ) : (
        <ul role="tree" className="m-0 list-none p-0" {...labelling}>
          {renderLevel(tree.entries, 0)}
        </ul>
      )}
    </div>
  );
}
