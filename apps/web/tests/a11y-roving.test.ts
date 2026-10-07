// apps/web/tests/a11y-roving.test.ts — roving-tabindex unit tests (05-a11y-primitives.md §3/§9,
// REQ-A11Y-01). Wrapped in describeDom (tests/dom.ts) so happy-dom is registered per file.
//
// Elements/events use the ambient `document`/`KeyboardEvent` globals (lib.dom-typed, and installed on
// `globalThis` by describeDom's beforeAll) rather than `dom.win.*` (happy-dom-typed) so the file both
// typechecks and reads the live window at call time.

import { expect, test } from "bun:test";

import { rovingTabindex } from "../src/client/a11y/roving-tabindex.js";
import { describeDom } from "./dom.js";

describeDom("a11y roving-tabindex", () => {
  function build(n: number): { list: HTMLElement; items: HTMLElement[] } {
    const list = document.createElement("ul");
    const items: HTMLElement[] = [];
    for (let i = 0; i < n; i++) {
      const li = document.createElement("li");
      li.setAttribute("role", "option");
      li.textContent = `item ${i}`;
      list.appendChild(li);
      items.push(li);
    }
    document.body.appendChild(list);
    return { list, items };
  }

  test("exactly one item is tabindex=0 and the rest are -1", () => {
    const { list, items } = build(3);
    const ctrl = rovingTabindex(list);

    const zeros = items.filter((el) => el.getAttribute("tabindex") === "0");
    const negs = items.filter((el) => el.getAttribute("tabindex") === "-1");
    expect(zeros.length).toBe(1);
    expect(negs.length).toBe(2);
    expect(items[0]!.getAttribute("tabindex")).toBe("0");
    expect(ctrl.activeIndex()).toBe(0);

    ctrl.release();
  });

  test("ArrowDown moves active, focuses next item, and updates tabindex", () => {
    const { list, items } = build(3);
    const ctrl = rovingTabindex(list);

    const ev = new KeyboardEvent("keydown", {
      key: "ArrowDown",
      bubbles: true,
      cancelable: true,
    });
    list.dispatchEvent(ev);

    expect(ctrl.activeIndex()).toBe(1);
    expect(items[1]!.getAttribute("tabindex")).toBe("0");
    expect(items[0]!.getAttribute("tabindex")).toBe("-1");
    expect(document.activeElement).toBe(items[1]!);
    expect(ev.defaultPrevented).toBe(true);

    ctrl.release();
  });

  test("Home and End jump to first and last", () => {
    const { list, items } = build(4);
    const ctrl = rovingTabindex(list);

    list.dispatchEvent(
      new KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true }),
    );
    expect(ctrl.activeIndex()).toBe(3);
    expect(items[3]!.getAttribute("tabindex")).toBe("0");

    list.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Home", bubbles: true, cancelable: true }),
    );
    expect(ctrl.activeIndex()).toBe(0);
    expect(items[0]!.getAttribute("tabindex")).toBe("0");

    ctrl.release();
  });

  test("refresh() after removing the active item clamps the index", () => {
    const { list, items } = build(3);
    const ctrl = rovingTabindex(list);

    ctrl.setActive(2);
    expect(ctrl.activeIndex()).toBe(2);

    items[2]!.remove();
    ctrl.refresh();
    expect(ctrl.activeIndex()).toBe(1); // clamped to the last remaining item

    ctrl.release();
  });

  test("release() restores the prior tabindex (items had none)", () => {
    const { list, items } = build(2);
    const ctrl = rovingTabindex(list);
    expect(items[0]!.getAttribute("tabindex")).toBe("0");
    expect(items[1]!.getAttribute("tabindex")).toBe("-1");

    ctrl.release();
    expect(items[0]!.hasAttribute("tabindex")).toBe(false);
    expect(items[1]!.hasAttribute("tabindex")).toBe(false);
  });

  test("empty item set yields activeIndex() === -1 and Arrow keys are ignored", () => {
    const { list } = build(0);
    const ctrl = rovingTabindex(list);
    expect(ctrl.activeIndex()).toBe(-1);
    expect(() =>
      list.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }),
      ),
    ).not.toThrow();
    expect(ctrl.activeIndex()).toBe(-1);
    ctrl.release();
  });
});
