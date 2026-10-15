// Pulse-only pattern (not in deck). A horizontal scroller for fixed-width content (a StatusTimeline SVG in a narrow pane). While its
// content overflows it is a labelled, focusable region, so a keyboard user can reach it and scroll
// it with the arrow keys (DataTable's scroll-region convention); while everything fits it is a plain
// box and adds no tab stop (#51).
import type { ReactElement, ReactNode } from "react";
import { useLayoutEffect, useRef, useState } from "react";

import { cn } from "@/ui/lib/utils";

export interface ScrollRegionProps {
  /** The region's accessible name while it scrolls, e.g. "Firing history chart". */
  readonly label: string;
  /** Extra classes for the root (`data-slot="scroll-region"`). */
  readonly className?: string;
  readonly children: ReactNode;
}

/** True while `el`'s content is wider than its box. */
function overflowsX(el: HTMLElement): boolean {
  return el.scrollWidth > el.clientWidth;
}

/** A horizontally scrolling box that is a keyboard-reachable, named region only while it overflows. */
export function ScrollRegion({ label, className, children }: ScrollRegionProps): ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  const [overflowing, setOverflowing] = useState(false);

  // Re-measure after every commit (the content may have changed width) …
  useLayoutEffect(() => {
    const el = ref.current;
    if (el !== null) setOverflowing(overflowsX(el));
  });

  // … and whenever the box or its content is resized (a pane or viewport resize).
  useLayoutEffect(() => {
    const el = ref.current;
    const Observer = el?.ownerDocument.defaultView?.ResizeObserver;
    if (el === null || Observer === undefined) return undefined;
    const observer = new Observer(() => setOverflowing(overflowsX(el)));
    observer.observe(el);
    for (const child of Array.from(el.children)) observer.observe(child);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      data-slot="scroll-region"
      data-overflowing={String(overflowing)}
      {...(overflowing ? { role: "region", "aria-label": label, tabIndex: 0 } : {})}
      className={cn(
        // An outline, not a ring: an inset box-shadow would paint under the chart.
        "max-w-full overflow-x-auto focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
        className,
      )}
    >
      {children}
    </div>
  );
}
