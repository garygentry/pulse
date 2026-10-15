// apps/web/src/client/views/overview/grid/navigation.ts — geometry-based arrow navigation over the
// overview grid's target triggers.
//
// The keyboard is `useListNavigation` (`@/ui`): its roving tabindex keeps the grid a single Tab stop
// and is the sole writer of target `tabindex`, and its `grid.move` option asks this module WHICH item
// a move lands on. This layer answers from measured candidate centers (a spatial grid: groups wrap to
// different column counts, so no fixed column count describes it). Geometry is read lazily on arrow
// input and cached until a `ResizeObserver` callback or a render of the grid invalidates it; without a
// working observer every arrow reads current geometry.

import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

import { useListNavigation, type ListNavIntent } from "@/ui";

/** Attribute carrying a target trigger's canonical `drilldownId`. */
export const TARGET_ID_ATTRIBUTE = "data-target-id";

/** Weight of the off-axis distance in the spatial score. */
const SECONDARY_WEIGHT = 0.25;

type Direction = "left" | "right" | "up" | "down";

/** The hook's 2-D move intents, as directions on screen. */
const INTENT_DIRECTION: Partial<Readonly<Record<ListNavIntent, Direction>>> = {
  "move-left": "left",
  "move-right": "right",
  "move-previous": "up",
  "move-next": "down",
};

/** Center point of one visible candidate; `null` for zero-sized or detached items. */
interface Center {
  readonly x: number;
  readonly y: number;
}

/** Options for `useSpatialGrid`. */
export interface SpatialGridOptions {
  /** CSS selector matching every roving target trigger. */
  readonly itemSelector: string;
  /** Invoked with the target id when a trigger is activated (a click, or Enter/Space on a non-button). */
  readonly onActivate: (id: string) => void;
  /** Whether the grid is mounted and navigable. Default `true`. */
  readonly enabled?: boolean;
}

/** What `useSpatialGrid` exposes: the tab stop's target id, and moving focus to a target by id. */
export interface SpatialGridHandle {
  /** The target id owning the roving tab stop, or null when none (or not mounted). */
  activeId(): string | null;
  /** Move DOM focus (and with it the roving tab stop) to `id`; a no-op for an unknown id. */
  focus(id: string): void;
}

/**
 * Arrow navigation over the grid in `gridRef`: one Tab stop, ←/→/↑/↓ (and j/k as ↓/↑) to the
 * nearest target on screen in that direction (never wrapping; an arrow at an edge is still claimed),
 * Home/End to the first/last target in DOM order. A click on a target moves focus there before it
 * activates, so the drawer has a deterministic return target; Enter/Space stay with native buttons.
 * After a render, a focused target that vanished hands focus to the surviving tab stop, else to the
 * grid itself.
 */
export function useSpatialGrid(gridRef: RefObject<HTMLElement | null>, options: SpatialGridOptions): SpatialGridHandle {
  const enabled = options.enabled ?? true;
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const state = useRef({
    geometry: null as (Center | null)[] | null,
    observed: false,
    lastFocused: null as HTMLElement | null,
    addedContainerTabindex: false,
    mounted: false,
  });

  const items = (): HTMLElement[] =>
    Array.from(gridRef.current?.querySelectorAll<HTMLElement>(optionsRef.current.itemSelector) ?? []);

  useListNavigation({
    enabled,
    scope: "element",
    containerRef: gridRef,
    keys: "arrows",
    getItems: items,
    rovingTabIndex: {},
    grid: {
      move: (intent, index, list) => {
        if (index < 0 || list.length === 0) return null;
        if (intent === "move-first") return 0;
        if (intent === "move-last") return list.length - 1;
        const direction = INTENT_DIRECTION[intent];
        if (direction === undefined) return null;
        const s = state.current;
        if (s.geometry === null || !s.observed) s.geometry = Array.from(list, center);
        // No candidate in that direction: stay put, but the arrow is still claimed.
        return nearest(s.geometry, index, direction) ?? index;
      },
    },
    // Native buttons synthesize a click for Enter/Space, which the click handler activates once.
    onActivate: (item) => {
      if (item.tagName === "BUTTON") return false;
      const id = item.getAttribute(TARGET_ID_ATTRIBUTE);
      if (id === null || id === "") return false;
      optionsRef.current.onActivate(id);
      return true;
    },
  });

  // Mounted: the geometry observer, the delegated click and focus tracking.
  useEffect(() => {
    const container = gridRef.current;
    const s = state.current;
    if (!enabled || container === null) return undefined;
    s.mounted = true;
    const observer = createObserver(() => {
      s.geometry = null;
    });
    s.observed = false;
    if (observer !== null) {
      try {
        observer.observe(container);
        s.observed = true;
      } catch {
        // An observer that cannot observe is treated as absent: geometry is read on every arrow.
      }
    }
    const targetOf = (event: Event): HTMLElement | null => {
      const origin = event.target as Element | null;
      if (origin === null || typeof origin.closest !== "function") return null;
      const item = origin.closest<HTMLElement>(optionsRef.current.itemSelector);
      return item !== null && container.contains(item) ? item : null;
    };
    const onClick = (event: MouseEvent): void => {
      const item = targetOf(event);
      const id = item?.getAttribute(TARGET_ID_ATTRIBUTE);
      if (item === null || id === null || id === undefined || id === "") return;
      // Pointer selection moves focus (and the tab stop) first.
      if (item.ownerDocument.activeElement !== item) item.focus();
      optionsRef.current.onActivate(id);
    };
    const onFocusIn = (event: FocusEvent): void => {
      const item = targetOf(event);
      if (item !== null) s.lastFocused = item;
    };
    container.addEventListener("click", onClick);
    container.addEventListener("focusin", onFocusIn);
    return () => {
      s.mounted = false;
      container.removeEventListener("click", onClick);
      container.removeEventListener("focusin", onFocusIn);
      if (observer !== null) {
        try {
          observer.disconnect();
        } catch {
          // Nothing left to detach.
        }
      }
      if (s.addedContainerTabindex) container.removeAttribute("tabindex");
      s.addedContainerTabindex = false;
      s.geometry = null;
      s.lastFocused = null;
    };
  }, [gridRef, enabled]);

  // After every render (membership or layout may have changed): forget geometry, and if the focused
  // target vanished, hand focus to the surviving tab stop (placed by the hook's own layout effect,
  // which runs first), else to the grid itself.
  useLayoutEffect(() => {
    const s = state.current;
    s.geometry = null;
    const container = gridRef.current;
    const lost = s.lastFocused;
    if (!enabled || container === null || lost === null || lost.isConnected) return;
    s.lastFocused = null;
    const doc = container.ownerDocument;
    const focused = doc.activeElement;
    if (focused !== null && focused !== doc.body && focused.isConnected) return;
    const stop = items().find((el) => el.getAttribute("tabindex") === "0");
    if (stop !== undefined) {
      stop.focus();
      return;
    }
    if (!container.isConnected) return;
    if (!container.hasAttribute("tabindex")) {
      container.setAttribute("tabindex", "-1");
      s.addedContainerTabindex = true;
    }
    container.focus();
  });

  return {
    activeId: () => {
      if (!state.current.mounted) return null;
      const id = items().find((el) => el.getAttribute("tabindex") === "0")?.getAttribute(TARGET_ID_ATTRIBUTE);
      return id === undefined || id === null || id === "" ? null : id;
    },
    focus: (id) => {
      if (!state.current.mounted) return;
      items()
        .find((el) => el.getAttribute(TARGET_ID_ATTRIBUTE) === id)
        ?.focus();
    },
  };
}

/** Construct a `ResizeObserver` if the environment provides a working one, else `null`. */
function createObserver(invalidate: () => void): ResizeObserver | null {
  const Observer = globalThis.ResizeObserver;
  if (typeof Observer !== "function") return null;
  try {
    return new Observer(invalidate);
  } catch {
    return null;
  }
}

/** Visible center of `el`, or `null` for detached, zero-sized or non-finite rectangles. */
function center(el: HTMLElement): Center | null {
  if (!el.isConnected) return null;
  let rect: DOMRect;
  try {
    rect = el.getBoundingClientRect();
  } catch {
    return null;
  }
  const { left, top, width, height } = rect;
  if (![left, top, width, height].every(Number.isFinite)) return null;
  if (width <= 0 || height <= 0) return null;
  return { x: left + width / 2, y: top + height / 2 };
}

/**
 * Pick the candidate for an arrow from `from`: strict half-plane, then the
 * minimum `(primary + secondary * 0.25, secondary, primary, DOM index)`. `null` when the origin is
 * unmeasurable or no candidate lies in the requested direction — focus never wraps.
 */
function nearest(centers: readonly (Center | null)[], from: number, direction: Direction): number | null {
  const origin = centers[from];
  if (origin === undefined || origin === null) return null;
  const horizontal = direction === "left" || direction === "right";

  let best: number | null = null;
  let bestKey: readonly [number, number, number] = [Infinity, Infinity, Infinity];
  centers.forEach((candidate, index) => {
    if (index === from || candidate === null) return;
    const dx = candidate.x - origin.x;
    const dy = candidate.y - origin.y;
    const inHalfPlane =
      direction === "left" ? dx < 0 : direction === "right" ? dx > 0 : direction === "up" ? dy < 0 : dy > 0;
    if (!inHalfPlane) return;
    const primary = Math.abs(horizontal ? dx : dy);
    const secondary = Math.abs(horizontal ? dy : dx);
    const key = [primary + secondary * SECONDARY_WEIGHT, secondary, primary] as const;
    // Candidates are visited in DOM order, so a strict `<` keeps the earliest on a full tie.
    if (lexLess(key, bestKey)) {
      best = index;
      bestKey = key;
    }
  });
  return best;
}

function lexLess(a: readonly number[], b: readonly number[]): boolean {
  for (let i = 0; i < a.length; i++) {
    if (a[i]! < b[i]!) return true;
    if (a[i]! > b[i]!) return false;
  }
  return false;
}
