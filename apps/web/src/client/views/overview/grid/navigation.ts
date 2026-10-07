// apps/web/src/client/views/overview/grid/navigation.ts — geometry-based arrow navigation over the
// overview grid's target triggers.
//
// The shared `rovingTabindex` primitive stays the sole writer of target `tabindex` and the sole
// programmatic focus path; this layer only decides WHICH index an arrow key should move to, using
// measured candidate centers, and hands that index to `RovingController.setActive`. Geometry is read
// lazily on arrow input and cached until a `ResizeObserver` callback or `refresh()` invalidates it;
// without a working observer every arrow reads current geometry. Pure DOM — no React.

import { rovingTabindex } from "../../../a11y/index.js";
import type { RovingController } from "../../../a11y/index.js";
import type { SpatialGridController, SpatialGridOptions } from "../model.js";

/** Attribute carrying a target trigger's canonical `drilldownId`. */
export const TARGET_ID_ATTRIBUTE = "data-target-id";

/** Weight of the off-axis distance in the spatial score. */
const SECONDARY_WEIGHT = 0.25;

type Direction = "left" | "right" | "up" | "down";

const ARROW_DIRECTION: Readonly<Record<string, Direction>> = {
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  ArrowDown: "down",
};

/** Center point of one visible candidate; `null` for zero-sized or detached items. */
interface Center {
  readonly x: number;
  readonly y: number;
}

/** Compose shared tabindex ownership with geometry-based arrow navigation. */
export function createSpatialGridController(
  container: HTMLElement,
  options: SpatialGridOptions,
): SpatialGridController {
  const { itemSelector, onActivate } = options;

  let items: HTMLElement[] = [];
  let geometry: (Center | null)[] | null = null;
  let released = false;
  let addedContainerTabindex = false;

  function query(): HTMLElement[] {
    return Array.from(container.querySelectorAll<HTMLElement>(itemSelector));
  }

  items = query();
  const roving: RovingController = rovingTabindex(container, {
    itemSelector,
    orientation: "both",
    wrap: false,
  });

  const observer = createObserver(() => {
    geometry = null;
  });
  if (observer !== null) {
    try {
      observer.observe(container);
    } catch {
      // An observer that cannot observe is treated as absent: geometry is read on every arrow.
    }
  }

  function activeElement(): HTMLElement | null {
    const index = roving.activeIndex();
    return index >= 0 ? (items[index] ?? null) : null;
  }

  function measure(): (Center | null)[] {
    if (geometry !== null && observer !== null) return geometry;
    const next = items.map((el) => center(el));
    geometry = next;
    return next;
  }

  function focusLost(): boolean {
    const focused = document.activeElement;
    return focused === null || focused === document.body || !focused.isConnected;
  }

  function focusContainer(): void {
    if (!container.isConnected) return;
    if (!container.hasAttribute("tabindex")) {
      container.setAttribute("tabindex", "-1");
      addedContainerTabindex = true;
    }
    container.focus();
  }

  function targetOf(event: Event): HTMLElement | null {
    const origin = event.target;
    if (origin === null || typeof (origin as Element).closest !== "function") return null;
    const item = (origin as Element).closest<HTMLElement>(itemSelector);
    return item !== null && container.contains(item) ? item : null;
  }

  function indexOf(item: HTMLElement): number {
    let index = items.indexOf(item);
    if (index < 0) {
      refresh();
      index = items.indexOf(item);
    }
    return index;
  }

  function onKeydown(event: KeyboardEvent): void {
    const origin = targetOf(event);
    if (origin === null) return;

    const direction = ARROW_DIRECTION[event.key];
    if (direction !== undefined) {
      // Consume every arrow from a target so the shared linear handler never runs.
      event.stopPropagation();
      event.preventDefault();
      const from = indexOf(origin);
      if (from < 0) return;
      const chosen = nearest(measure(), from, direction);
      if (chosen !== null) roving.setActive(chosen);
      return;
    }

    // Native buttons synthesize a click for Enter/Space, which `onClick` activates exactly once.
    if ((event.key === "Enter" || event.key === " ") && origin.tagName !== "BUTTON") {
      const id = origin.getAttribute(TARGET_ID_ATTRIBUTE);
      if (id === null || id === "") return;
      event.preventDefault();
      onActivate(id);
    }
  }

  function onClick(event: MouseEvent): void {
    const origin = targetOf(event);
    if (origin === null) return;
    const id = origin.getAttribute(TARGET_ID_ATTRIBUTE);
    if (id === null || id === "") return;
    const index = indexOf(origin);
    // Pointer selection moves the tab stop first so the drawer has a deterministic return target.
    // An already-active, focused target (keyboard Enter/Space) needs no tabindex rewrite or refocus.
    if (index >= 0 && !(roving.activeIndex() === index && document.activeElement === origin)) roving.setActive(index);
    onActivate(id);
  }

  function refresh(): void {
    if (released) return;
    const prior = activeElement();
    roving.refresh();
    items = query();
    geometry = null;
    if (prior === null || items.includes(prior) || !focusLost()) return;
    // The focused target vanished: fall back to the shared surviving item, else the container.
    const survivor = roving.activeIndex();
    if (survivor >= 0) roving.setActive(survivor);
    else focusContainer();
  }

  function focus(id: string): void {
    if (released) return;
    const index = items.findIndex((el) => el.getAttribute(TARGET_ID_ATTRIBUTE) === id);
    if (index >= 0) roving.setActive(index);
  }

  function activeId(): string | null {
    if (released) return null;
    const el = activeElement();
    const id = el === null ? null : el.getAttribute(TARGET_ID_ATTRIBUTE);
    return id === null || id === "" ? null : id;
  }

  function release(): void {
    if (released) return;
    released = true;
    container.removeEventListener("keydown", onKeydown, true);
    container.removeEventListener("click", onClick);
    if (observer !== null) {
      try {
        observer.disconnect();
      } catch {
        // Nothing left to detach.
      }
    }
    if (addedContainerTabindex) container.removeAttribute("tabindex");
    geometry = null;
    items = [];
    roving.release();
  }

  container.addEventListener("keydown", onKeydown, true);
  container.addEventListener("click", onClick);

  return { activeId, focus, refresh, release };
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
