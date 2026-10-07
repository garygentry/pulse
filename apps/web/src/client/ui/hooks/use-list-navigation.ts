import { useEffect, useRef, type RefObject } from "react";
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
  /** 2-D grid: ←/→ (and h/l for vim) move within a row, ↑/↓ by `columns`. */
  grid?: { columns: number | (() => number) };
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
  /** Enter (and Space under `"arrows"`) on an item. Default: `item.click()`. */
  onActivate?: (item: HTMLElement, index: number) => void;
  /** Tree items: → expands, ← collapses, Space toggles (`"arrows"` preset, no grid). */
  onExpand?: (item: HTMLElement, index: number) => void;
  onCollapse?: (item: HTMLElement, index: number) => void;
  onToggle?: (item: HTMLElement, index: number) => void;
  /** Turn the listener off without unmounting. Default `true`. */
  enabled?: boolean;
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
 * real DOM focus (`item.focus()`); there is no roving tabindex, so the items
 * must be focusable themselves (links, buttons, or `tabIndex={-1}`).
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
      const origin = originOf(event.target, items, search);

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
      const intent = resolveListIntent(event, config, {
        origin,
        gPending: gPendingRef.current,
      });
      gPendingRef.current = nextGPending(intent);

      const doc = (event.target as Node | null)?.ownerDocument ?? document;
      const index = indexOfActive(items, doc.activeElement);
      if (apply(intent, opts, items, index, search)) event.preventDefault();
    };

    target.addEventListener("keydown", onKeyDown as EventListener);
    return () => target.removeEventListener("keydown", onKeyDown as EventListener);
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
    if (opts.onActivate !== undefined) opts.onActivate(item, i);
    else item.click();
    return true;
  };
  const onItem = (handler: ((item: HTMLElement, i: number) => void) | undefined): boolean => {
    const item = index >= 0 ? items[index] : undefined;
    if (item === undefined || handler === undefined) return false;
    handler(item, index);
    return true;
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
    default: {
      const raw = opts.grid?.columns ?? 1;
      const columns = typeof raw === "function" ? raw() : raw;
      const next = nextListIndex(index, intent, items.length, columns);
      const item = next >= 0 ? items[next] : undefined;
      if (item === undefined) return false;
      item.focus();
      return true;
    }
  }
}
