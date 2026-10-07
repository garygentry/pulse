// apps/web/tests/overview-navigation.test.ts — spatial roving controller over synthetic rectangles
// (03-grid-navigation-and-motion.md §7, 08-testing-strategy.md §4.2). Every item stubs
// `getBoundingClientRect`, and `ResizeObserver` is replaced per test by a controllable fake (or
// removed) so geometry caching is deterministic. Elements/events use the ambient lib.dom globals that
// describeDom installs, as in a11y-roving.test.ts.

import { afterEach, beforeEach, expect, test } from "bun:test";

import { createSpatialGridController } from "../src/client/views/overview/grid/navigation.js";
import type { SpatialGridController } from "../src/client/views/overview/model.js";
import { describeDom } from "./dom.js";

const SELECTOR = "[data-overview-target]";

interface Box {
  x: number;
  y: number;
  w?: number;
  h?: number;
}

/** A fake ResizeObserver whose callback the test fires explicitly. */
class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  observed: Element[] = [];
  disconnected = false;
  constructor(readonly callback: () => void) {
    FakeResizeObserver.instances.push(this);
  }
  observe(el: Element): void {
    this.observed.push(el);
  }
  unobserve(): void {}
  disconnect(): void {
    this.disconnected = true;
  }
  fire(): void {
    this.callback();
  }
}

describeDom("overview spatial grid navigation", () => {
  // Read `globalThis` at call time: an alias captured in this describe body did not reach the global
  // the controller reads once happy-dom is registered.
  const observerGlobal = (): { ResizeObserver?: unknown } => globalThis as unknown as { ResizeObserver?: unknown };
  let savedObserver: unknown;
  let controllers: SpatialGridController[] = [];
  let hosts: HTMLElement[] = [];

  beforeEach(() => {
    savedObserver = observerGlobal().ResizeObserver;
    observerGlobal().ResizeObserver = FakeResizeObserver;
    FakeResizeObserver.instances = [];
  });

  afterEach(() => {
    for (const c of controllers) c.release();
    for (const h of hosts) h.remove();
    controllers = [];
    hosts = [];
    observerGlobal().ResizeObserver = savedObserver;
  });

  function place(el: HTMLElement, box: Box): void {
    const w = box.w ?? 100;
    const h = box.h ?? 50;
    el.getBoundingClientRect = () =>
      ({
        x: box.x,
        y: box.y,
        left: box.x,
        top: box.y,
        width: w,
        height: h,
        right: box.x + w,
        bottom: box.y + h,
        toJSON: () => ({}),
      }) as DOMRect;
  }

  /** Build a container of button targets `t0..tN` at the given boxes (DOM order = array order). */
  function build(boxes: readonly Box[], ids?: readonly string[]): { grid: HTMLElement; items: HTMLElement[] } {
    const grid = document.createElement("div");
    grid.setAttribute("role", "grid");
    const items = boxes.map((box, i) => {
      const button = document.createElement("button");
      button.setAttribute("data-overview-target", "");
      button.setAttribute("data-target-id", ids?.[i] ?? `t${i}`);
      button.textContent = ids?.[i] ?? `t${i}`;
      place(button, box);
      grid.appendChild(button);
      return button;
    });
    document.body.appendChild(grid);
    hosts.push(grid);
    return { grid, items };
  }

  function control(grid: HTMLElement, onActivate: (id: string) => void = () => {}): SpatialGridController {
    const c = createSpatialGridController(grid, { itemSelector: SELECTOR, onActivate });
    controllers.push(c);
    return c;
  }

  function press(el: Element, key: string): KeyboardEvent {
    const ev = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    el.dispatchEvent(ev);
    return ev;
  }

  /** Assert exactly one eligible item is the tab stop, and that it is `expected`. */
  function expectSingleTabStop(grid: HTMLElement, expected: HTMLElement): void {
    const all = Array.from(grid.querySelectorAll<HTMLElement>(SELECTOR));
    const zeros = all.filter((el) => el.tabIndex === 0);
    expect(zeros).toEqual([expected]);
    for (const el of all) if (el !== expected) expect(el.tabIndex).toBe(-1);
  }

  /** Press `key` on the focused item and assert the move landed on `expected` with one tab stop. */
  function move(grid: HTMLElement, c: SpatialGridController, key: string, expected: HTMLElement): KeyboardEvent {
    const from = document.activeElement ?? grid;
    const ev = press(from, key);
    expect(document.activeElement).toBe(expected);
    expect(c.activeId()).toBe(expected.getAttribute("data-target-id"));
    expectSingleTabStop(grid, expected);
    return ev;
  }

  // 3×3 layout: t0 t1 t2 / t3 t4 t5 / t6 t7 t8 (110px column pitch, 60px row pitch).
  const GRID_3X3: Box[] = [0, 1, 2].flatMap((r) => [0, 1, 2].map((c) => ({ x: c * 110, y: r * 60 })));

  test("starts with exactly one tab stop on the first item", () => {
    const { grid, items } = build(GRID_3X3);
    const c = control(grid);
    expect(c.activeId()).toBe("t0");
    expectSingleTabStop(grid, items[0]!);
  });

  test("all four arrows move spatially from the center of a 3×3 grid", () => {
    const { grid, items } = build(GRID_3X3);
    const c = control(grid);
    c.focus("t4");
    expectSingleTabStop(grid, items[4]!);

    const right = move(grid, c, "ArrowRight", items[5]!);
    expect(right.defaultPrevented).toBe(true);
    move(grid, c, "ArrowLeft", items[4]!);
    // ArrowDown goes to the item below (t7), not the next DOM item (t5) as the linear handler would.
    move(grid, c, "ArrowDown", items[7]!);
    move(grid, c, "ArrowUp", items[4]!);
    move(grid, c, "ArrowUp", items[1]!);
    move(grid, c, "ArrowLeft", items[0]!);
  });

  test("geometry, not DOM order, decides the target when layout reflows to fewer columns", () => {
    // Same six items, first as 3 columns then reflowed to 2 columns.
    const { grid, items } = build([0, 1, 2, 3, 4, 5].map((i) => ({ x: (i % 3) * 110, y: Math.floor(i / 3) * 60 })));
    const c = control(grid);
    c.focus("t1");
    move(grid, c, "ArrowDown", items[4]!);

    items.forEach((el, i) => place(el, { x: (i % 2) * 110, y: Math.floor(i / 2) * 60 }));
    FakeResizeObserver.instances[0]!.fire();
    c.focus("t1");
    move(grid, c, "ArrowDown", items[3]!);
  });

  test("picks the nearest candidate in the requested half-plane", () => {
    // Origin at x=0; candidates to the right at 300 and 150 (DOM order puts the farther one first).
    const { grid, items } = build([
      { x: 0, y: 0 },
      { x: 300, y: 0 },
      { x: 150, y: 0 },
      { x: -200, y: 0 },
    ]);
    const c = control(grid);
    items[0]!.focus();
    move(grid, c, "ArrowRight", items[2]!);
    c.focus("t0");
    move(grid, c, "ArrowLeft", items[3]!);
  });

  test("the strict half-plane excludes items level with the origin on the requested axis", () => {
    // t1 shares t0's x, so ArrowRight must skip it for the item strictly to the right.
    const { grid, items } = build([
      { x: 0, y: 0 },
      { x: 0, y: 60 },
      { x: 400, y: 300 },
    ]);
    const c = control(grid);
    items[0]!.focus();
    move(grid, c, "ArrowRight", items[2]!);
  });

  test("secondary-axis distance breaks an equal weighted score", () => {
    // From origin center: A has primary 110, secondary 40 → score 120; B has primary 115, secondary 20
    // → score 120. Scores tie, so the smaller secondary (B) wins even though A is nearer on-axis and
    // earlier in DOM order.
    const { grid, items } = build([
      { x: 0, y: 100 },
      { x: 110, y: 140 },
      { x: 115, y: 80 },
    ]);
    const c = control(grid);
    items[0]!.focus();
    move(grid, c, "ArrowRight", items[2]!);
  });

  test("DOM order is the final tie-break for geometrically identical candidates", () => {
    // Two candidates symmetric about the origin row: identical (score, secondary, primary).
    const above = { x: 110, y: 60 };
    const below = { x: 110, y: 140 };
    const first = build([{ x: 0, y: 100 }, below, above]);
    const c1 = control(first.grid);
    first.items[0]!.focus();
    move(first.grid, c1, "ArrowRight", first.items[1]!);

    const second = build([{ x: 0, y: 100 }, above, below], ["o", "a", "b"]);
    const c2 = control(second.grid);
    second.items[0]!.focus();
    move(second.grid, c2, "ArrowRight", second.items[1]!);
  });

  test("edges never wrap: arrow is consumed, focus and the single tab stop stay put", () => {
    const { grid, items } = build(GRID_3X3);
    const c = control(grid);

    c.focus("t2");
    const right = move(grid, c, "ArrowRight", items[2]!);
    expect(right.defaultPrevented).toBe(true);
    move(grid, c, "ArrowUp", items[2]!);

    c.focus("t6");
    move(grid, c, "ArrowLeft", items[6]!);
    move(grid, c, "ArrowDown", items[6]!);

    // The shared primitive would have moved t8 → t0 (wrap) or clamped linearly; spatial layer holds.
    c.focus("t8");
    move(grid, c, "ArrowDown", items[8]!);
    move(grid, c, "ArrowRight", items[8]!);
  });

  test("Home/End are left to the shared primitive's first/last behavior", () => {
    const { grid, items } = build(GRID_3X3);
    const c = control(grid);
    c.focus("t4");
    move(grid, c, "End", items[8]!);
    move(grid, c, "Home", items[0]!);
  });

  test("zero-sized items are not candidates", () => {
    const { grid, items } = build([
      { x: 0, y: 0 },
      { x: 110, y: 0, w: 0, h: 0 },
      { x: 220, y: 0 },
    ]);
    const c = control(grid);
    items[0]!.focus();
    move(grid, c, "ArrowRight", items[2]!);
  });

  test("click and non-button Enter/Space activate the canonical id; arrows never activate", () => {
    const activated: string[] = [];
    const { grid, items } = build(GRID_3X3, [0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => `svc:host-00${i}/api`));
    const c = control(grid, (id) => activated.push(id));

    items[4]!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(activated).toEqual(["svc:host-004/api"]);
    // Pointer selection moves the tab stop and focus to the clicked target first.
    expect(c.activeId()).toBe("svc:host-004/api");
    expect(document.activeElement).toBe(items[4]!);
    expectSingleTabStop(grid, items[4]!);

    // A native button's Enter/Space become one synthesized click; the controller adds no second call.
    press(items[4]!, "Enter");
    press(items[4]!, " ");
    press(items[4]!, "ArrowRight");
    expect(activated).toEqual(["svc:host-004/api"]);

    const cell = document.createElement("div");
    cell.setAttribute("role", "gridcell");
    cell.setAttribute("data-overview-target", "");
    cell.setAttribute("data-target-id", "host:host-010");
    place(cell, { x: 0, y: 200 });
    grid.appendChild(cell);
    c.refresh();
    const enter = press(cell, "Enter");
    const space = press(cell, " ");
    expect(enter.defaultPrevented).toBe(true);
    expect(space.defaultPrevented).toBe(true);
    expect(activated).toEqual(["svc:host-004/api", "host:host-010", "host:host-010"]);
  });

  test("focus(unknownId) is a no-op", () => {
    const { grid, items } = build(GRID_3X3);
    const c = control(grid);
    c.focus("t3");
    c.focus("does-not-exist");
    expect(c.activeId()).toBe("t3");
    expectSingleTabStop(grid, items[3]!);
  });

  test("removed active item falls back to a surviving item with focus", () => {
    const { grid, items } = build(GRID_3X3);
    const c = control(grid);
    c.focus("t8");
    expect(document.activeElement).toBe(items[8]!);

    items[8]!.remove();
    c.refresh();
    const survivor = document.activeElement as HTMLElement;
    expect(items.slice(0, 8)).toContain(survivor);
    expect(c.activeId()).toBe(survivor.getAttribute("data-target-id"));
    expectSingleTabStop(grid, survivor);

    // Navigation keeps working over the surviving set: below t5 the removed t8 is gone, so the
    // nearest lower candidate is t7.
    c.focus("t5");
    move(grid, c, "ArrowDown", items[7]!);
    move(grid, c, "ArrowUp", items[4]!);
  });

  test("removing every item (collapse) focuses the grid container and leaves the controller inert", () => {
    const { grid, items } = build([{ x: 0, y: 0 }, { x: 110, y: 0 }]);
    const c = control(grid);
    c.focus("t1");
    for (const el of items) el.remove();
    expect(() => c.refresh()).not.toThrow();
    expect(document.activeElement).toBe(grid);
    expect(c.activeId()).toBeNull();
    expect(() => press(grid, "ArrowRight")).not.toThrow();
    expect(() => c.focus("t0")).not.toThrow();
    expect(c.activeId()).toBeNull();
  });

  test("an empty grid is inert and never throws", () => {
    const { grid } = build([]);
    const activated: string[] = [];
    const c = control(grid, (id) => activated.push(id));
    expect(c.activeId()).toBeNull();
    for (const key of ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter", " ", "Home", "End"]) {
      expect(() => press(grid, key)).not.toThrow();
    }
    expect(() => c.focus("t0")).not.toThrow();
    expect(() => c.refresh()).not.toThrow();
    expect(c.activeId()).toBeNull();
    expect(activated).toEqual([]);
  });

  test("ResizeObserver only invalidates cached geometry, read lazily on the next arrow", () => {
    const { grid, items } = build([
      { x: 0, y: 0 },
      { x: 110, y: 0 },
      { x: 0, y: 60 },
    ]);
    const reads = items.map(() => 0);
    items.forEach((el, i) => {
      const original = el.getBoundingClientRect.bind(el);
      el.getBoundingClientRect = () => {
        reads[i]! += 1;
        return original();
      };
    });
    const c = control(grid);
    const observer = FakeResizeObserver.instances[0]!;
    expect(observer.observed).toEqual([grid]);
    // Construction and invalidation read nothing.
    observer.fire();
    expect(reads).toEqual([0, 0, 0]);

    items[0]!.focus();
    move(grid, c, "ArrowRight", items[1]!);
    expect(reads).toEqual([1, 1, 1]);

    // Layout changes without an observer callback: the cached geometry is still used, so t2 (now
    // nearest to the right of t0) is not yet a candidate.
    let t2Reads = 0;
    place(items[2]!, { x: 60, y: 0 });
    const moved = items[2]!.getBoundingClientRect.bind(items[2]!);
    items[2]!.getBoundingClientRect = () => {
      t2Reads += 1;
      return moved();
    };
    c.focus("t0");
    move(grid, c, "ArrowRight", items[1]!);
    expect(t2Reads).toBe(0);

    // The observer callback only invalidates; the new position is read on the next arrow.
    observer.fire();
    expect(t2Reads).toBe(0);
    c.focus("t0");
    move(grid, c, "ArrowRight", items[2]!);
    expect(t2Reads).toBe(1);
  });

  test("refresh() invalidates geometry for membership/layout changes", () => {
    const { grid, items } = build([
      { x: 0, y: 0 },
      { x: 110, y: 0 },
      { x: 220, y: 0 },
    ]);
    const c = control(grid);
    items[0]!.focus();
    move(grid, c, "ArrowRight", items[1]!);
    place(items[2]!, { x: 55, y: 0 });
    c.refresh();
    c.focus("t0");
    move(grid, c, "ArrowRight", items[2]!);
  });

  test("absent ResizeObserver: arrows read current geometry every time without throwing", () => {
    observerGlobal().ResizeObserver = undefined;
    const { grid, items } = build([
      { x: 0, y: 0 },
      { x: 110, y: 0 },
      { x: 0, y: 60 },
    ]);
    const c = control(grid);
    items[0]!.focus();
    move(grid, c, "ArrowDown", items[2]!);
    // Move t2 to the right without any refresh/observer — the next arrow sees it immediately.
    place(items[2]!, { x: 220, y: 0 });
    c.focus("t1");
    move(grid, c, "ArrowRight", items[2]!);
  });

  test("a throwing ResizeObserver constructor falls back to lazy geometry reads", () => {
    observerGlobal().ResizeObserver = class {
      constructor() {
        throw new Error("unsupported");
      }
    };
    const { grid, items } = build([
      { x: 0, y: 0 },
      { x: 110, y: 0 },
    ]);
    let c: SpatialGridController | null = null;
    expect(() => {
      c = control(grid);
    }).not.toThrow();
    items[0]!.focus();
    move(grid, c!, "ArrowRight", items[1]!);
    place(items[0]!, { x: 220, y: 0 });
    move(grid, c!, "ArrowRight", items[0]!);
  });

  test("release() detaches listeners and the observer, restores tabindex, and is idempotent", () => {
    const activated: string[] = [];
    const { grid, items } = build(GRID_3X3);
    const c = createSpatialGridController(grid, { itemSelector: SELECTOR, onActivate: (id) => activated.push(id) });
    const observer = FakeResizeObserver.instances[0]!;
    c.focus("t4");

    c.release();
    expect(observer.disconnected).toBe(true);
    for (const el of items) expect(el.hasAttribute("tabindex")).toBe(false);
    expect(c.activeId()).toBeNull();

    const ev = press(items[4]!, "ArrowRight");
    expect(ev.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(items[4]!);
    items[4]!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(activated).toEqual([]);

    expect(() => c.release()).not.toThrow();
    expect(() => c.refresh()).not.toThrow();
    expect(() => c.focus("t0")).not.toThrow();
  });
});
