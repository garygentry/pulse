// a11y/roving-tabindex.ts — roving tabindex for composite widgets (05-a11y-primitives.md §3,
// REQ-A11Y-01). Makes a widget a single Tab stop: exactly one item is tabindex="0" (the rest
// tabindex="-1") and Arrow/Home/End move the active item. Hand-rolled (CON-02).
//
// SSR / no-document posture (05 §1/§3.3): all controller methods are no-ops and activeIndex()
// returns -1 when `document` is absent; nothing throws. `document` is read as a bare global at CALL
// time so it resolves to whatever DOM is installed when the helper runs.

/** Orientation of arrow-key navigation. */
export type RovingOrientation = "vertical" | "horizontal" | "both";

/** Options for rovingTabindex. */
export interface RovingOptions {
  /** CSS selector (scoped to the container) matching the navigable items.
   *  Default: '[role="option"], [role="menuitem"], [role="tab"], [data-roving-item]'. */
  itemSelector?: string;
  /** Arrow-key axis. Default "vertical" (ArrowUp/ArrowDown). "both" enables all four arrows. */
  orientation?: RovingOrientation;
  /** Wrap from last→first / first→last at the ends. Default true. */
  wrap?: boolean;
  /** Index of the item that starts as the single tab stop. Default 0. */
  initialIndex?: number;
  /** Called when the active item changes (index into the current item list, and the element).
   *  The palette uses this to sync `aria-activedescendant` (07). */
  onActiveChange?: (index: number, el: HTMLElement) => void;
}

/** Controller returned by rovingTabindex. */
export interface RovingController {
  /** Programmatically set the active item by index (clamped); updates tabindex and focus. */
  setActive(index: number): void;
  /** Current active index (−1 when the item list is empty). */
  activeIndex(): number;
  /** Re-scan the container for items, preserving the active element by identity when it still
   *  exists, else clamping the index. */
  refresh(): void;
  /** Remove listeners and restore natural tab order (all items back to their prior tabindex). */
  release(): void;
}

const DEFAULT_ITEM_SELECTOR =
  '[role="option"], [role="menuitem"], [role="tab"], [data-roving-item]';

/**
 * Install roving-tabindex behavior on `container`. Sets one item tabindex="0" and the rest
 * tabindex="-1", and binds a keydown handler moving the active item on Arrow/Home/End
 * (per orientation/wrap), calling `.focus()` on the newly-active item (05 §3.2).
 */
export function rovingTabindex(container: HTMLElement, options?: RovingOptions): RovingController {
  if (typeof document === "undefined") {
    // No DOM: inert controller, never throws (05 §3.3).
    return {
      setActive(): void {},
      activeIndex(): number {
        return -1;
      },
      refresh(): void {},
      release(): void {},
    };
  }

  const opts = options ?? {};
  const itemSelector = opts.itemSelector ?? DEFAULT_ITEM_SELECTOR;
  const orientation = opts.orientation ?? "vertical";
  const wrap = opts.wrap ?? true;
  const onActiveChange = opts.onActiveChange;

  const nextKeys =
    orientation === "horizontal"
      ? ["ArrowRight"]
      : orientation === "vertical"
        ? ["ArrowDown"]
        : ["ArrowDown", "ArrowRight"];
  const prevKeys =
    orientation === "horizontal"
      ? ["ArrowLeft"]
      : orientation === "vertical"
        ? ["ArrowUp"]
        : ["ArrowUp", "ArrowLeft"];

  const priorTabindex = new Map<HTMLElement, string | null>();
  let items: HTMLElement[] = [];
  let index = -1;
  let released = false;

  function query(): HTMLElement[] {
    return Array.from(container.querySelectorAll<HTMLElement>(itemSelector));
  }

  function record(list: HTMLElement[]): void {
    for (const el of list) {
      if (!priorTabindex.has(el)) priorTabindex.set(el, el.getAttribute("tabindex"));
    }
  }

  /** Reflect the current `index` onto tabindex bookkeeping (one "0", rest "-1"). */
  function applyTabindex(): void {
    items.forEach((el, i) => {
      el.setAttribute("tabindex", i === index ? "0" : "-1");
    });
  }

  /** Move active to `target` (clamped), updating tabindex, focus, and firing onActiveChange. */
  function moveTo(target: number, focus: boolean): void {
    if (items.length === 0) {
      index = -1;
      return;
    }
    index = Math.min(Math.max(target, 0), items.length - 1);
    applyTabindex();
    const el = items[index]!;
    if (focus) el.focus();
    if (onActiveChange) onActiveChange(index, el);
  }

  function onKeydown(event: KeyboardEvent): void {
    if (items.length === 0) return;
    const key = event.key;
    let handled = false;
    if (nextKeys.includes(key)) {
      let target = index + 1;
      if (target >= items.length) target = wrap ? 0 : items.length - 1;
      moveTo(target, true);
      handled = true;
    } else if (prevKeys.includes(key)) {
      let target = index - 1;
      if (target < 0) target = wrap ? items.length - 1 : 0;
      moveTo(target, true);
      handled = true;
    } else if (key === "Home") {
      moveTo(0, true);
      handled = true;
    } else if (key === "End") {
      moveTo(items.length - 1, true);
      handled = true;
    }
    // preventDefault ONLY for consumed keys so Tab/Enter/typing pass through (05 §3.2).
    if (handled) event.preventDefault();
  }

  function setActive(target: number): void {
    if (items.length === 0) return;
    moveTo(target, true);
  }

  function activeIndex(): number {
    return items.length === 0 ? -1 : index;
  }

  function refresh(): void {
    const priorActiveEl = index >= 0 && index < items.length ? items[index]! : null;
    items = query();
    record(items);
    if (items.length === 0) {
      index = -1;
      return;
    }
    if (priorActiveEl !== null && items.includes(priorActiveEl)) {
      index = items.indexOf(priorActiveEl);
    } else {
      index = Math.min(Math.max(index, 0), items.length - 1);
    }
    applyTabindex();
  }

  function release(): void {
    if (released) return; // idempotent (05 §3.3)
    released = true;
    container.removeEventListener("keydown", onKeydown);
    for (const [el, prior] of priorTabindex) {
      if (!el.isConnected) continue; // guarded by isConnected (05 §3.3)
      if (prior === null) el.removeAttribute("tabindex");
      else el.setAttribute("tabindex", prior);
    }
    priorTabindex.clear();
  }

  // Install: record prior tabindex, set the initial single tab stop, bind keydown.
  items = query();
  record(items);
  if (items.length > 0) {
    const init = opts.initialIndex ?? 0;
    index = Math.min(Math.max(init, 0), items.length - 1);
  }
  applyTabindex();
  container.addEventListener("keydown", onKeydown);

  return { setActive, activeIndex, refresh, release };
}
