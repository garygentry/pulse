/**
 * Pure tree logic for `TreeView`: filtering (a match keeps its ancestors, which
 * auto-expand) and the ancestry lookups the keyboard needs. No DOM, no React.
 */

export interface TreeAccessors<T> {
  getId: (node: T) => string;
  /** A node's children; `undefined`/empty for a leaf. */
  getChildren?: ((node: T) => readonly T[] | undefined) | undefined;
  /** Overrides the default "no children ⇒ leaf" (e.g. an empty folder is still a branch). */
  isLeaf?: ((node: T) => boolean) | undefined;
}

/** One node after filtering, with its surviving children. */
export interface TreeEntry<T> {
  readonly node: T;
  readonly id: string;
  readonly leaf: boolean;
  readonly children: readonly TreeEntry<T>[];
}

export interface FilteredTree<T> {
  readonly entries: readonly TreeEntry<T>[];
  /** Ancestors of every match: expanded automatically while the filter is active. */
  readonly autoExpanded: ReadonlySet<string>;
  /** Number of nodes that matched the predicate (0 with no predicate). */
  readonly matchCount: number;
}

export function isLeafNode<T>(node: T, accessors: TreeAccessors<T>): boolean {
  if (accessors.isLeaf !== undefined) return accessors.isLeaf(node);
  const children = accessors.getChildren?.(node);
  return children === undefined || children.length === 0;
}

function entryOf<T>(node: T, accessors: TreeAccessors<T>, children: readonly TreeEntry<T>[]): TreeEntry<T> {
  return { node, id: accessors.getId(node), leaf: isLeafNode(node, accessors), children };
}

function unfiltered<T>(nodes: readonly T[], accessors: TreeAccessors<T>): TreeEntry<T>[] {
  return nodes.map((node) => entryOf(node, accessors, unfiltered(accessors.getChildren?.(node) ?? [], accessors)));
}

/**
 * Filter a tree by a predicate.
 * - A node survives when it matches or has a surviving descendant.
 * - A matching branch keeps its whole subtree (you find a folder, you see what is in it).
 * - Every ancestor of a match lands in `autoExpanded`, so matches are visible.
 * With no predicate the tree is returned whole and nothing auto-expands.
 */
export function filterTreeNodes<T>(
  nodes: readonly T[],
  accessors: TreeAccessors<T>,
  predicate?: (node: T) => boolean,
): FilteredTree<T> {
  if (predicate === undefined) {
    return { entries: unfiltered(nodes, accessors), autoExpanded: new Set(), matchCount: 0 };
  }
  const autoExpanded = new Set<string>();
  let matchCount = 0;

  const visit = (list: readonly T[]): TreeEntry<T>[] => {
    const out: TreeEntry<T>[] = [];
    for (const node of list) {
      const children = accessors.getChildren?.(node) ?? [];
      const matched = predicate(node);
      if (matched) matchCount += 1;
      const kept = visit(children);
      if (kept.length > 0) autoExpanded.add(accessors.getId(node));
      if (matched) {
        // Keep the whole subtree, but only the matches inside it expand their ancestors.
        out.push(entryOf(node, accessors, unfiltered(children, accessors)));
      } else if (kept.length > 0) {
        out.push(entryOf(node, accessors, kept));
      }
    }
    return out;
  };

  return { entries: visit(nodes), autoExpanded, matchCount };
}

/** A case-insensitive substring predicate over a node's text. Blank text means "no filter". */
export function textPredicate<T>(query: string, getText: (node: T) => string): ((node: T) => boolean) | undefined {
  const needle = query.trim().toLowerCase();
  if (needle === "") return undefined;
  return (node) => getText(node).toLowerCase().includes(needle);
}

/**
 * A visible row: an entry with its depth (0 = top level), its parent's id, and its place among its
 * siblings (`posInSet` is 1-based; `setSize` counts them). The position comes from the model, so it
 * is right for `aria-posinset`/`aria-setsize` even when the siblings are not rendered.
 */
export interface VisibleTreeRow<T> {
  readonly entry: TreeEntry<T>;
  readonly depth: number;
  readonly parentId: string | null;
  readonly posInSet: number;
  readonly setSize: number;
}

/** The rows a screen shows, in order: descends only into expanded branches. */
export function visibleTreeRows<T>(
  entries: readonly TreeEntry<T>[],
  expanded: ReadonlySet<string>,
): VisibleTreeRow<T>[] {
  const out: VisibleTreeRow<T>[] = [];
  const walk = (list: readonly TreeEntry<T>[], depth: number, parentId: string | null): void => {
    list.forEach((entry, index) => {
      out.push({ entry, depth, parentId, posInSet: index + 1, setSize: list.length });
      if (!entry.leaf && expanded.has(entry.id)) walk(entry.children, depth + 1, entry.id);
    });
  };
  walk(entries, 0, null);
  return out;
}

/** Ids of every ancestor of `id` (nearest first), or `[]` when it is top-level or absent. */
export function ancestorIds<T>(entries: readonly TreeEntry<T>[], id: string): string[] {
  const path: string[] = [];
  const find = (list: readonly TreeEntry<T>[]): boolean => {
    for (const entry of list) {
      if (entry.id === id) return true;
      path.push(entry.id);
      if (find(entry.children)) return true;
      path.pop();
    }
    return false;
  };
  return find(entries) ? path.reverse() : [];
}
