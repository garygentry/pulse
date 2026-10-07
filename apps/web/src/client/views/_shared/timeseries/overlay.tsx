// Transparent interaction layer over a lane group, the swimlane or a chart. Gesture decisions live in
// overlay-gesture.ts; this component measures the DOM, wires events and draws by direct style writes.
// The cursor is read only inside useSignalEffect bodies and event handlers, never during render.
import type { ReactElement } from "react";
import { useEffect, useRef } from "react";
import { batch, useSignalEffect } from "@preact/signals-react";
import { announce } from "../../../a11y/index.js";
import type { FractionMap, TimeAxis } from "./axis.js";
import { createOverlayGesture, overlayPlacementStyle } from "./overlay-gesture.js";
import type { OverlayGesture, OverlayPlacement } from "./overlay-gesture.js";
import { useSignals } from "@preact/signals-react/runtime";

/** Props for PlotOverlay (tech-spec §3.7 "Overlay", tech-spec §3.10 overlay rows). */
export interface PlotOverlayProps {
  /** The page axis (07) or a per-chart axis (04 engine trends). */
  axis: TimeAxis;
  /** Accessible name of the plotted content, e.g. "Hosts", "Alerts swimlane", "CPU utilization chart". */
  label: string;
  /** Placement; `inert` disables interaction (§5.6). */
  placement: OverlayPlacement;
  /** False in kiosk (REQ-KIOSK-03): renders the passive shield only. */
  interactive: boolean;
  /** Allow brush and +/-/= zoom. Default true; engine trend charts pass false (§6.8). */
  zoomable?: boolean;
  /** x mapping for this box; default `axis` (linear). Charts pass `chartFractionMap(data)` when non-null. */
  xMap?: FractionMap | null;
  /** id of the readout's aria-live summary element (REQ-A11Y-03). */
  describedBy?: string;
  /** Called after a pin is set (true) or cleared (false). Side effects only; pause is derived from axis.pinned (§2.7). */
  onPin?: (pinned: boolean) => void;
}

const KEY_SHORTCUTS = "ArrowLeft ArrowRight Shift+ArrowLeft Shift+ArrowRight Home End + = - Enter Escape";

/** Run a pointer-capture call that is missing or throws under happy-dom. */
function tryCapture(fn: (() => void) | undefined): void {
  try {
    fn?.();
  } catch {
    /* ignored */
  }
}

/** Captures pointer and keyboard input over a plot and draws the cursor line and brush without re-rendering it. */
export function PlotOverlay(props: PlotOverlayProps): ReactElement {
  useSignals();
  const { axis, label, placement, interactive, describedBy } = props;
  const active = interactive && placement.kind !== "inert";
  const rootRef = useRef<HTMLDivElement>(null);
  const cursorRef = useRef<HTMLDivElement>(null);
  const brushRef = useRef<HTMLDivElement>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const activeRef = useRef(active);
  activeRef.current = active;
  const gesture = useRef<OverlayGesture | null>(null);
  gesture.current ??= createOverlayGesture({
    axis: () => propsRef.current.axis,
    map: () => propsRef.current.xMap ?? propsRef.current.axis,
    zoomable: () => propsRef.current.zoomable ?? true,
    active: () => activeRef.current,
    measure: () => rootRef.current?.getBoundingClientRect() ?? null,
    capturePointer: (id) => tryCapture(() => rootRef.current?.setPointerCapture?.(id)),
    releasePointer: (id) => tryCapture(() => rootRef.current?.releasePointerCapture?.(id)),
    showBrush: (left, width) => {
      const b = brushRef.current;
      if (b === null) return;
      b.hidden = false;
      b.style.left = `${left * 100}%`;
      b.style.width = `${width * 100}%`;
    },
    hideBrush,
    announce,
    onPin: (pinned) => propsRef.current.onPin?.(pinned),
    batch,
  });
  const g = gesture.current;

  function hideBrush(): void {
    if (brushRef.current !== null) brushRef.current.hidden = true;
  }

  /** Position the cursor line from the given cursor/pin state (style writes only). */
  const paint = (t: number | null, pinned: boolean): void => {
    const el = cursorRef.current;
    if (el === null) return;
    const f = g.cursorFraction(t);
    el.style.visibility = Number.isNaN(f) ? "hidden" : "visible";
    if (Number.isNaN(f)) return;
    el.style.transform = `translateX(${f * 100}%)`;
    el.dataset.pinned = pinned ? "true" : "false";
  };

  useSignalEffect(() => {
    const t = axis.cursor.value; // tracked
    axis.view.value; // tracked: re-position after zoom
    const pinned = axis.pinned.value; // tracked
    paint(t, pinned);
  });

  // Re-paint when activity or the x mapping changes without a signal change.
  useEffect(() => {
    paint(axis.cursor.peek(), axis.pinned.peek());
    if (!active) hideBrush();
  }, [active, props.xMap]);

  // Invalidate the cached rect on resize; cancel a queued cursor write on unmount.
  useEffect(() => {
    const root = rootRef.current;
    const RO = (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
    let ro: ResizeObserver | null = null;
    if (root !== null && typeof RO === "function") {
      try {
        ro = new RO(() => g.invalidate());
        ro.observe(root);
      } catch {
        ro = null;
      }
    }
    return () => {
      ro?.disconnect();
      g.dispose();
    };
  }, []);

  return (
    <div
      ref={rootRef}
      data-slot="plot-overlay"
      className="cursor-crosshair overflow-hidden focus-visible:outline-1 focus-visible:outline-ring data-[state=inert]:cursor-default"
      data-state={active ? "active" : "inert"}
      role={active ? "group" : undefined}
      tabIndex={active ? 0 : undefined}
      aria-label={active ? `${label} — time cursor` : undefined}
      aria-describedby={active ? describedBy : undefined}
      aria-keyshortcuts={active ? KEY_SHORTCUTS : undefined}
      aria-hidden={active ? undefined : "true"}
      style={overlayPlacementStyle(placement)}
      onPointerDown={active ? g.pointerDown : undefined}
      onPointerMove={active ? g.pointerMove : undefined}
      onPointerUp={active ? g.pointerUp : undefined}
      onPointerCancel={active ? g.pointerCancel : undefined}
      onPointerEnter={active ? g.pointerEnter : undefined}
      onPointerLeave={active ? g.pointerLeave : undefined}
      onKeyDown={active ? (e) => g.keyDown(e) && e.preventDefault() : undefined}
    >
      <div
        ref={cursorRef}
        data-slot="plot-cursor"
        className="pointer-events-none invisible absolute inset-y-0 left-0 w-full border-l border-dashed border-muted-foreground motion-reduce:transition-none data-[pinned=true]:border-solid data-[pinned=true]:border-foreground"
        aria-hidden="true"
      />
      <div
        ref={brushRef}
        data-slot="plot-brush"
        className="pointer-events-none absolute inset-y-0 border-x border-ring bg-muted opacity-40 motion-reduce:transition-none"
        aria-hidden="true"
        hidden
      />
    </div>
  );
}
