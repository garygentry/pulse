// src/client/views/overview/kiosk/useViewportTop.ts — the page root's offset below the shell chrome.
//
// The kiosk page fills exactly the viewport space left under the shell's top bar (and the stale-data
// callout while it shows), so its height is `100dvh - <offset>`. The offset is the root's document
// top edge, measured in a layout effect (before paint) and re-measured on window resize and whenever
// the root's ancestors or the document change size — which is what happens when chrome above the
// root appears, disappears or resizes. Paging capacity stays with useKioskPaging; this only sizes
// the box it measures.

import type { RefObject } from "react";
import { useLayoutEffect, useState } from "react";

interface ViewportGlobals {
  readonly scrollY?: number;
  readonly addEventListener?: (type: "resize", listener: () => void) => void;
  readonly removeEventListener?: (type: "resize", listener: () => void) => void;
  readonly ResizeObserver?: typeof ResizeObserver;
}

/** The element's top edge in document coordinates, rounded up to whole pixels (never negative). */
export function documentTop(el: Element): number {
  const scrollY = (globalThis as ViewportGlobals).scrollY ?? 0;
  return Math.max(0, Math.ceil(el.getBoundingClientRect().top + scrollY));
}

/** The element itself and every ancestor up to (and including) the document element. */
function selfAndAncestors(el: Element): Element[] {
  const out: Element[] = [];
  for (let node: Element | null = el; node !== null; node = node.parentElement) out.push(node);
  return out;
}

/**
 * Document top offset (px) of `ref`'s element while `enabled`; 0 while disabled or unmounted.
 * Updates only when the measured value changes, so a stable layout re-renders nothing.
 */
export function useViewportTop(ref: RefObject<HTMLElement | null>, enabled: boolean): number {
  const [top, setTop] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!enabled || el === null) {
      setTop(0);
      return undefined;
    }
    const g = globalThis as ViewportGlobals;
    const measure = (): void => setTop(documentTop(el));
    measure();
    g.addEventListener?.("resize", measure);
    const Observer = g.ResizeObserver;
    const observer = typeof Observer === "function" ? new Observer(measure) : null;
    // The root's own size is set from this value; observing its ancestors (not just the document)
    // also catches chrome that disappears while the shell's min-height keeps the document height.
    if (observer !== null) for (const node of selfAndAncestors(el.parentElement ?? el)) observer.observe(node);
    return () => {
      g.removeEventListener?.("resize", measure);
      observer?.disconnect();
    };
  }, [ref, enabled]);
  return top;
}
