// apps/web/tests/overview-kiosk-fit.test.ts — the kiosk page root's viewport-offset hook.
//
// `useViewportTop` measures the root's document top edge (the shell chrome above it) so the kiosk
// page can be `100dvh - offset` tall. Geometry is stubbed: happy-dom has no layout, so the test
// drives `getBoundingClientRect().top`, `scrollY`, the window resize event and a recording
// ResizeObserver directly.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { createElement, useRef } from "react";
import type { ReactElement } from "react";

import { documentTop, useViewportTop } from "../src/client/views/overview/kiosk/useViewportTop.js";
import { isolateDomGlobals } from "./alerts-dom-isolation.js";
import { describeDom } from "./dom.js";
import { act } from "./react-render.js";

isolateDomGlobals();

interface Recorded {
  readonly callback: () => void;
  readonly observed: Element[];
  disconnected: boolean;
}

describeDom("overview kiosk fit — useViewportTop", (dom) => {
  let top = 0;
  let observers: Recorded[] = [];
  let restore: (() => void) | null = null;
  const unmounts: (() => void)[] = [];

  beforeEach(() => {
    top = 56;
    observers = [];
    const proto = (dom.win as unknown as { HTMLElement: typeof HTMLElement }).HTMLElement.prototype;
    const realRect = proto.getBoundingClientRect;
    proto.getBoundingClientRect = function (this: HTMLElement): DOMRect {
      const isRoot = this.hasAttribute("data-fit-root");
      return { top: isRoot ? top : 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
    };
    const g = globalThis as { ResizeObserver?: unknown };
    const realObserver = g.ResizeObserver;
    g.ResizeObserver = class {
      private readonly rec: Recorded;
      constructor(callback: () => void) {
        this.rec = { callback, observed: [], disconnected: false };
        observers.push(this.rec);
      }
      observe(el: Element): void {
        this.rec.observed.push(el);
      }
      unobserve(): void {}
      disconnect(): void {
        this.rec.disconnected = true;
      }
    };
    restore = () => {
      proto.getBoundingClientRect = realRect;
      g.ResizeObserver = realObserver;
    };
  });

  afterEach(async () => {
    while (unmounts.length > 0) await act(async () => unmounts.pop()!());
    restore?.();
    restore = null;
  });

  function Probe(props: { readonly enabled: boolean }): ReactElement {
    const ref = useRef<HTMLElement>(null);
    const offset = useViewportTop(ref, props.enabled);
    return createElement("section", { ref, "data-fit-root": "", "data-offset": String(offset) });
  }

  async function mountProbe(enabled: boolean): Promise<{ root: HTMLElement; rerender(enabled: boolean): Promise<void> }> {
    const shell = document.createElement("div");
    shell.setAttribute("data-shell", "");
    document.body.appendChild(shell);
    const { render } = await import("./react-render.js");
    await act(async () => render(createElement(Probe, { enabled }), shell));
    unmounts.push(() => {
      render(null, shell);
      shell.remove();
    });
    return {
      root: shell.querySelector<HTMLElement>("[data-fit-root]")!,
      rerender: (next) => act(async () => render(createElement(Probe, { enabled: next }), shell)),
    };
  }

  const offsetOf = (root: HTMLElement): number => Number(root.getAttribute("data-offset"));

  test("documentTop adds the scroll position and rounds up to whole pixels", () => {
    const el = document.createElement("div");
    el.setAttribute("data-fit-root", "");
    top = 56.2;
    expect(documentTop(el)).toBe(57);
    top = -10;
    expect(documentTop(el)).toBe(0);
  });

  test("measures the root's top offset before paint", async () => {
    const { root } = await mountProbe(true);
    expect(offsetOf(root)).toBe(56);
  });

  test("re-measures on window resize", async () => {
    const { root } = await mountProbe(true);
    top = 120;
    await act(async () => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(offsetOf(root)).toBe(120);
  });

  test("re-measures when chrome above it changes size (ancestors and the document are observed)", async () => {
    const { root } = await mountProbe(true);
    expect(observers).toHaveLength(1);
    const observed = observers[0]!.observed;
    expect(observed).toContain(root.parentElement!);
    expect(observed).toContain(document.body);
    expect(observed).toContain(document.documentElement);
    // A stale-data callout appears above the root: the shell grows and the observer fires.
    top = 116;
    await act(async () => observers[0]!.callback());
    expect(offsetOf(root)).toBe(116);
    // …and disappears again.
    top = 56;
    await act(async () => observers[0]!.callback());
    expect(offsetOf(root)).toBe(56);
  });

  test("disabled (desk) measures nothing and reports 0; turning it off disconnects", async () => {
    const off = await mountProbe(false);
    expect(offsetOf(off.root)).toBe(0);
    expect(observers).toHaveLength(0);

    const on = await mountProbe(true);
    expect(offsetOf(on.root)).toBe(56);
    await on.rerender(false);
    expect(offsetOf(on.root)).toBe(0);
    expect(observers[0]!.disconnected).toBe(true);
    // A resize after disconnect changes nothing.
    top = 300;
    await act(async () => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(offsetOf(on.root)).toBe(0);
  });
});
