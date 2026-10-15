import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { isEditableTarget } from "@/ui/lib/dom";
import {
  nextGPending,
  nextListIndex,
  resolveListIntent,
  type ListNavConfig,
  type ListNavIntent,
  type ListNavOrigin,
  type ListNavPreset,
} from "@/ui/lib/list-navigation";

export interface UseListNavigationOptions {
  /** The navigable items, in visual order. Called on every keystroke, so it is always current. */
  getItems: () => ArrayLike<HTMLElement>;
  /** Key preset; default `"vim"`. */
  keys?: ListNavPreset;
  /**
   * 2-D grid: ←/→ (and h/l for vim) move within a row, ↑/↓ by `columns`. For a layout no column
   * count describes (a spatial grid whose rows wrap per group), pass `move` instead: it returns the
   * index a move intent (`move-left`/`-right`/`-previous`/`-next`/`-first`/`-last`) lands on from
   * `index` (-1 when no item has focus), `index` itself to stay put and still claim the key, or
   * `null` to leave the key alone.
   */
  grid?:
    | { columns: number | (() => number) }
    | { move: (intent: ListNavIntent, index: number, items: ArrayLike<HTMLElement>) => number | null };
  /**
   * `"window"` (default) listens on `window`, for a page's main list.
   * `"element"` listens on `containerRef` only, for a widget inside a page.
   */
  scope?: "window" | "element";
  /** The element to listen on when `scope` is `"element"`. */
  containerRef?: RefObject<HTMLElement | null>;
  /** The list's search field: `/` and Ctrl/Cmd-K focus it, and it may use Escape and Enter. */
  getSearch?: () => HTMLElement | null;
  /**
   * Escape (from the list or the search field): clear the filter, search text or
   * scope. Return `false` when there was nothing to clear, so the key is not consumed.
   */
  onEscape?: () => boolean | void;
  /** Enter in the search field activates the first item. */
  activateFirstFromSearch?: boolean;
  /**
   * Enter (and Space under `"arrows"`) on an item. Default: `item.click()`. Return `false` when it
   * did nothing for this item, so the key is not consumed (as with `onEscape`); the same holds for
   * `onExpand`, `onCollapse` and `onToggle`.
   */
  onActivate?: (item: HTMLElement, index: number) => boolean | void;
  /** Tree items: → expands, ← collapses, Space toggles (`"arrows"` preset, no grid). */
  onExpand?: (item: HTMLElement, index: number) => boolean | void;
  onCollapse?: (item: HTMLElement, index: number) => boolean | void;
  onToggle?: (item: HTMLElement, index: number) => boolean | void;
  /**
   * A virtualized list renders only some of its items, so moves (↑/↓, Home/End, …) are worked out
   * over the whole list instead of `getItems()`: `count()` is the number of items, `activeIndex()`
   * the focused one's index among them (-1 for none), and `focus(index)` renders that item if it
   * must and focuses it (called for every move, also one clamped at an end). The other intents still act on the focused element in `getItems()`.
   */
  virtual?: {
    count: () => number;
    activeIndex: () => number;
    focus: (index: number) => void;
  };
  /**
   * True while the list's own type-ahead search is live: a printable key (j/k included) is then
   * text for that search, so the hook leaves it alone instead of moving.
   */
  typeaheadActive?: () => boolean;
  /**
   * Home/End (and vim `gg`/`G`) call this instead of focusing the first or last of
   * `getItems()`. For a list that renders only a window of its items, such as a virtualized
   * `DataTable`, whose first and last items are not in the DOM:
   * `focusEdge: (edge) => void tableRef.current?.focusIndex(edge === "first" ? 0 : data.length - 1)`.
   */
  focusEdge?: (edge: "first" | "last") => void;
  /**
   * Roving tabindex: the list is one Tab stop. After every render of the calling component the
   * hook sets `tabindex="0"` on one of `getItems()` and `tabindex="-1"` on the rest. The tab stop
   * follows focus (an item focused by a key, a click or code becomes it), stays on the same
   * element across renders, and, when that element is gone, falls to the item now at its index
   * (clamped). `initialIndex()` picks the first tab stop (default 0). The items must not render a
   * `tabIndex` of their own; when the option is dropped, disabled or the hook unmounts, the
   * `tabindex` attributes it set are removed.
   */
  rovingTabIndex?: { initialIndex?: () => number };
  /**
   * Called with each key the hook would act on and what it means; return `false` to leave that
   * key alone (not consumed, a pending `g` disarmed). For a page-level list that claims some keys
   * only in some places, e.g. arrows only while focus is in the list, letters anywhere.
   */
  acceptKey?: (event: KeyboardEvent, intent: ListNavIntent) => boolean;
  /** Turn the listener off without unmounting. Default `true`. */
  enabled?: boolean;
}

interface RovingState {
  /** The current tab stop, and its index when it was last placed. */
  el: HTMLElement | null;
  index: number;
  /** Every element the hook gave a `tabindex`, so it can take them back. */
  touched: Set<HTMLElement>;
}

/** Place the roving tab stop: on `focusedIndex` when given, else where it was (or `initialIndex`). */
function syncTabStop(opts: UseListNavigationOptions, state: RovingState, focusedIndex: number): void {
  const items = opts.getItems();
  for (const el of state.touched) if (!el.isConnected) state.touched.delete(el);
  if (items.length === 0) return;
  let index = focusedIndex;
  if (index < 0 && state.el !== null) {
    for (let i = 0; i < items.length; i += 1) if (items[i] === state.el) index = i;
  }
  if (index < 0) {
    index = state.el === null && state.index < 0 ? (opts.rovingTabIndex?.initialIndex?.() ?? 0) : state.index;
  }
  index = Math.min(Math.max(index, 0), items.length - 1);
  for (let i = 0; i < items.length; i += 1) {
    const el = items[i]!;
    const value = i === index ? "0" : "-1";
    if (el.getAttribute("tabindex") !== value) el.setAttribute("tabindex", value);
    state.touched.add(el);
  }
  state.el = items[index]!;
  state.index = index;
}

/** Duck-typed, so it holds across windows (an element from another realm, a test DOM). */
function isElement(target: EventTarget | null): target is Element {
  return target !== null && typeof (target as Partial<Element>).closest === "function";
}

function indexOfActive(items: ArrayLike<HTMLElement>, active: Element | null): number {
  if (active === null) return -1;
  // Exact match first: items can nest (tree items own their children), so the
  // first item that merely contains focus may be an ancestor of the focused one.
  for (let i = 0; i < items.length; i += 1) if (items[i] === active) return i;
  // Otherwise the innermost item containing focus (the last one in document order).
  for (let i = items.length - 1; i >= 0; i -= 1) if (items[i]!.contains(active)) return i;
  return -1;
}

function originOf(
  target: EventTarget | null,
  items: ArrayLike<HTMLElement>,
  search: HTMLElement | null,
): ListNavOrigin {
  if (search !== null && target instanceof Node && search.contains(target)) return "search";
  // An item is always "list", even when it is itself a button or link-like control.
  for (let i = 0; i < items.length; i += 1) if (items[i] === target) return "list";
  return isEditableTarget(target) ? "editable" : "list";
}

/**
 * Keyboard navigation over a list, table or grid of focusable items. It moves
 * real DOM focus (`item.focus()`). Without `rovingTabIndex` the items keep their
 * own tab order, so they must be focusable themselves (links, buttons, or
 * `tabIndex={-1}`); with it the list is a single Tab stop.
 *
 * Built in:
 * - Keys from editable controls other than the search field are ignored.
 * - Modifier chords pass through, except Ctrl/Cmd-K when there is a search field.
 * - A key is consumed (`preventDefault`) only when it did something.
 */
export function useListNavigation(options: UseListNavigationOptions): void {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const gPendingRef = useRef(false);
  const scope = options.scope ?? "window";
  const enabled = options.enabled ?? true;
  const roving = enabled && options.rovingTabIndex !== undefined;
  const rovingRef = useRef<RovingState>({ el: null, index: -1, touched: new Set() });

  // The roving tab stop is re-placed after every render, so new and re-ordered items are covered.
  useLayoutEffect(() => {
    if (roving) syncTabStop(optionsRef.current, rovingRef.current, -1);
  });
  // Leaving roving mode gives the items their natural tab order back.
  useLayoutEffect(() => {
    if (!roving) return undefined;
    const state = rovingRef.current;
    return () => {
      for (const el of state.touched) if (el.isConnected) el.removeAttribute("tabindex");
      state.touched.clear();
      state.el = null;
      state.index = -1;
    };
  }, [roving]);

  useEffect(() => {
    if (!enabled) return;
    const target: EventTarget | null =
      scope === "element" ? (optionsRef.current.containerRef?.current ?? null) : window;
    if (target === null) return;

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.isComposing) return;
      const opts = optionsRef.current;
      const items = opts.getItems();
      const search = opts.getSearch?.() ?? null;
      const doc = (event.target as Node | null)?.ownerDocument ?? document;
      // The element the key was pressed on; a key dispatched on the document itself acts on
      // whatever has focus.
      const from = isElement(event.target) ? event.target : doc.activeElement;
      const origin = originOf(from, items, search);

      const config: ListNavConfig = {
        keys: opts.keys ?? "vim",
        grid: opts.grid !== undefined,
        search: opts.getSearch !== undefined,
        escape: opts.onEscape !== undefined,
        activateFirstFromSearch: opts.activateFirstFromSearch ?? false,
        expandable:
          opts.onExpand !== undefined ||
          opts.onCollapse !== undefined ||
          opts.onToggle !== undefined,
      };
      const typing =
        origin === "list" &&
        opts.typeaheadActive?.() === true &&
        event.key.length === 1 &&
        event.key !== " " &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey;
      const resolved = typing
        ? "none"
        : resolveListIntent(event, config, {
            origin,
            gPending: gPendingRef.current,
          });
      const intent = resolved !== "none" && opts.acceptKey?.(event, resolved) === false ? "none" : resolved;
      gPendingRef.current = nextGPending(intent);

      const index = indexOfActive(items, from);
      if (apply(intent, opts, items, index, search)) event.preventDefault();
    };

    // Roving: whichever item gains focus becomes the tab stop.
    const onFocusIn = (event: FocusEvent): void => {
      const opts = optionsRef.current;
      if (opts.rovingTabIndex === undefined) return;
      const items = opts.getItems();
      for (let i = 0; i < items.length; i += 1) {
        if (items[i] === event.target) return syncTabStop(opts, rovingRef.current, i);
      }
    };

    target.addEventListener("keydown", onKeyDown as EventListener);
    target.addEventListener("focusin", onFocusIn as EventListener);
    return () => {
      target.removeEventListener("keydown", onKeyDown as EventListener);
      target.removeEventListener("focusin", onFocusIn as EventListener);
    };
  }, [scope, enabled]);
}

/** Carry out an intent. Returns whether it did something (and so consumes the key). */
function apply(
  intent: ListNavIntent,
  opts: UseListNavigationOptions,
  items: ArrayLike<HTMLElement>,
  index: number,
  search: HTMLElement | null,
): boolean {
  const activate = (i: number): boolean => {
    const item = items[i];
    if (item === undefined) return false;
    if (opts.onActivate !== undefined) return opts.onActivate(item, i) !== false;
    item.click();
    return true;
  };
  const onItem = (handler: ((item: HTMLElement, i: number) => boolean | void) | undefined): boolean => {
    const item = index >= 0 ? items[index] : undefined;
    if (item === undefined || handler === undefined) return false;
    return handler(item, index) !== false;
  };

  switch (intent) {
    case "none":
      return false;
    case "g-prefix":
      return true;
    case "focus-search":
      if (search === null) return false;
      search.focus();
      return true;
    case "clear":
      return opts.onEscape?.() !== false;
    case "activate":
      return index >= 0 && activate(index);
    case "activate-first":
      return activate(0);
    case "expand":
      return onItem(opts.onExpand);
    case "collapse":
      return onItem(opts.onCollapse);
    case "toggle":
      return opts.onToggle !== undefined ? onItem(opts.onToggle) : index >= 0 && activate(index);
    case "move-first":
    case "move-last":
      if (opts.focusEdge === undefined) return moveTo(intent, opts, items, index);
      opts.focusEdge(intent === "move-first" ? "first" : "last");
      return true;
    default:
      return moveTo(intent, opts, items, index);
  }
}

/** Focus the item `intent` moves to (over every item when `virtual` is set). Returns whether there was one. */
function moveTo(intent: ListNavIntent, opts: UseListNavigationOptions, items: ArrayLike<HTMLElement>, index: number): boolean {
  if (opts.grid !== undefined && "move" in opts.grid) {
    const to = opts.grid.move(intent, index, items);
    const target = to === null ? undefined : items[to];
    if (target === undefined) return false;
    target.focus();
    return true;
  }
  const raw = opts.grid !== undefined && "columns" in opts.grid ? opts.grid.columns : 1;
  const columns = typeof raw === "function" ? raw() : raw;
  if (opts.virtual !== undefined) {
    const from = opts.virtual.activeIndex();
    const to = nextListIndex(from, intent, opts.virtual.count(), columns);
    if (to < 0) return false;
    // Also when the move is clamped (to === from): focus comes back to the active item, as
    // `item.focus()` does for a rendered list.
    opts.virtual.focus(to);
    return true;
  }
  const next = nextListIndex(index, intent, items.length, columns);
  const item = next >= 0 ? items[next] : undefined;
  if (item === undefined) return false;
  item.focus();
  return true;
}
