// Framework-neutral pointer/brush/keyboard gesture controller behind PlotOverlay.
// Every decision (brush vs click, cursor writes, pin toggles, zoom intents) lives here; the host
// component supplies DOM measurement, pointer capture, brush drawing and signal batching.
import { brushWindow, clampCursor, CURSOR_BIG_STEP, KEY_ZOOM_FACTOR } from "./axis.js";
import type { FractionMap, TimeAxis } from "./axis.js";

/** Minimum pointer drag distance that counts as a brush, CSS px. */
export const BRUSH_MIN_PX = 4;

/** A measured plot rectangle relative to the overlay's positioned parent, CSS px. */
export interface OverlayRect {
  /** Offset from the parent's left edge. */ readonly left: number;
  /** Offset from the parent's top edge. */ readonly top: number;
  /** Width of the plotting area. */ readonly width: number;
  /** Height of the plotting area. */ readonly height: number;
}

/** Where the overlay sits and whether it is live. */
export type OverlayPlacement =
  /** Cover the whole parent box (lane groups, swimlane). */
  | { readonly kind: "fill" }
  /** Cover a measured rectangle (a chart's `.u-over`). */
  | { readonly kind: "rect"; readonly rect: OverlayRect }
  /** Not yet measurable: a passive shield over the whole box that blocks uPlot's native hover/select. */
  | { readonly kind: "inert" };

/** Inline positioning for the overlay root under a placement. */
export function overlayPlacementStyle(placement: OverlayPlacement): Record<string, string> {
  const base = { position: "absolute", overflow: "hidden", touchAction: "pan-y", pointerEvents: "auto" };
  if (placement.kind === "rect") {
    const r = placement.rect;
    return { ...base, left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` };
  }
  return { ...base, inset: "0" };
}

/** Announced when a brush is narrower than the minimum zoom width. */
export const TOO_NARROW_TEXT = "Selection too narrow to zoom — minimum 2 steps";

/** The horizontal extent of the overlay root in client coordinates. */
export interface OverlaySpan {
  readonly left: number;
  readonly width: number;
}

/** The subset of a PointerEvent the controller reads. */
export interface GesturePointer {
  readonly type: string;
  readonly pointerId: number;
  readonly pointerType: string;
  readonly isPrimary: boolean;
  readonly button: number;
  readonly clientX: number;
}

/** The subset of a KeyboardEvent the controller reads. */
export interface GestureKey {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
}

/** Everything the controller needs from its host; getters are read at event time. */
export interface OverlayGestureHost {
  /** The time axis to drive. */ axis(): TimeAxis;
  /** x mapping for the overlay box (defaults to the axis itself). */ map(): FractionMap;
  /** Whether brush and keyboard zoom are allowed. */ zoomable(): boolean;
  /** Whether the overlay is live; every input is ignored when false. */ active(): boolean;
  /** Measure the overlay root, or null when it is not mounted. */ measure(): OverlaySpan | null;
  /** Capture the pointer on the overlay root. */ capturePointer(pointerId: number): void;
  /** Release a captured pointer. */ releasePointer(pointerId: number): void;
  /** Draw the brush from box fraction `left`, `width` wide. */ showBrush(left: number, width: number): void;
  /** Hide the brush. */ hideBrush(): void;
  /** Politely announce a message to assistive tech. */ announce(text: string): void;
  /** Notify that a pin was set (true) or cleared (false). */ onPin(pinned: boolean): void;
  /** Run `fn` so that its signal writes notify once. */ batch(fn: () => void): void;
  /** Schedule `cb` for the next frame; returns a canceller. Default: rAF with a microtask fallback. */
  requestFrame?(cb: () => void): () => void;
}

/** The controller PlotOverlay feeds its DOM events to. */
export interface OverlayGesture {
  pointerEnter(e: GesturePointer): void;
  pointerDown(e: GesturePointer): void;
  pointerMove(e: GesturePointer): void;
  pointerUp(e: GesturePointer): void;
  pointerCancel(e: GesturePointer): void;
  pointerLeave(e: GesturePointer): void;
  /** Returns true when the key was handled (the host should preventDefault). */
  keyDown(e: GestureKey): boolean;
  /** Box fraction at which to draw the cursor line for `t`, or NaN when it should be hidden. */
  cursorFraction(t: number | null): number;
  /** Forget the cached measurement (on resize). */
  invalidate(): void;
  /** Cancel any queued cursor write. */
  dispose(): void;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Run `cb` on the next animation frame; microtask fallback when rAF is missing or throws. */
export function requestFrame(cb: () => void): () => void {
  let cancelled = false;
  const run = (): void => {
    if (!cancelled) cb();
  };
  const raf = (globalThis as { requestAnimationFrame?: (cb: FrameRequestCallback) => number }).requestAnimationFrame;
  let scheduled = false;
  if (typeof raf === "function") {
    try {
      raf(() => run());
      scheduled = true;
    } catch {
      /* fall through to the microtask fallback */
    }
  }
  if (!scheduled) queueMicrotask(run);
  return () => {
    cancelled = true;
  };
}

function isPrimary(e: GesturePointer): boolean {
  return e.isPrimary && !(e.pointerType === "mouse" && e.button !== 0 && e.type === "pointerdown");
}

/** Create the gesture controller for one overlay. Mutable state stays inside; nothing re-renders. */
export function createOverlayGesture(host: OverlayGestureHost): OverlayGesture {
  const frame = host.requestFrame ?? requestFrame;
  let rect: OverlaySpan | null = null;
  let pressing = false;
  let brushing = false;
  let startX = 0;
  let startF = Number.NaN;
  let queued: number | null = null;
  let cancelFrame: (() => void) | null = null;

  function readRect(): void {
    const r = host.measure();
    if (r !== null) rect = { left: r.left, width: r.width };
  }

  function frac(clientX: number): number {
    if (rect === null) readRect();
    const r = rect;
    if (r === null || !(r.width > 0) || !Number.isFinite(clientX)) return Number.NaN;
    return clamp01((clientX - r.left) / r.width);
  }

  /** Queue one cursor write for the next frame; the latest position wins. */
  function queueCursor(t: number | null): void {
    queued = t;
    if (cancelFrame !== null) return;
    cancelFrame = frame(() => {
      cancelFrame = null;
      const axis = host.axis();
      if (axis.pinned.peek()) return;
      axis.cursor.value = queued;
    });
  }

  function endPress(): void {
    pressing = false;
    brushing = false;
  }

  return {
    pointerEnter(e) {
      if (!host.active() || !e.isPrimary) return;
      readRect();
    },

    pointerDown(e) {
      if (!host.active() || !isPrimary(e)) return;
      readRect();
      host.capturePointer(e.pointerId);
      startX = e.clientX;
      startF = frac(e.clientX);
      pressing = true;
      brushing = false;
    },

    pointerMove(e) {
      if (!host.active() || !e.isPrimary) return;
      const f = frac(e.clientX);
      if (Number.isNaN(f)) return;
      if (pressing && host.zoomable() && Math.abs(e.clientX - startX) >= BRUSH_MIN_PX && !Number.isNaN(startF)) {
        brushing = true;
        const lo = Math.min(startF, f);
        host.showBrush(lo, Math.max(startF, f) - lo);
      }
      const axis = host.axis();
      if (!axis.pinned.peek()) queueCursor(clampCursor(host.map().fromFraction(f), axis.view.peek()));
    },

    pointerUp(e) {
      if (!host.active() || !e.isPrimary) return;
      host.releasePointer(e.pointerId);
      if (!pressing) return;
      const wasBrushing = brushing;
      endPress();
      const f = frac(e.clientX);
      const axis = host.axis();
      if (wasBrushing) {
        host.hideBrush();
        if (Number.isNaN(f) || Number.isNaN(startF)) return;
        const m = host.map();
        const fa0 = axis.toFraction(m.fromFraction(startF));
        const fa1 = axis.toFraction(m.fromFraction(f));
        const r = brushWindow(axis.view.peek(), axis.domain.peek(), axis.stepSeconds.peek(), fa0, fa1);
        if (r.kind === "ignored") host.announce(TOO_NARROW_TEXT);
        else axis.brush(fa0, fa1);
        return;
      }
      if (Number.isNaN(f)) return;
      const view = axis.view.peek();
      host.batch(() => {
        axis.cursor.value = clampCursor(host.map().fromFraction(f), view);
        axis.pinned.value = true;
      });
      host.onPin(true);
    },

    pointerCancel(e) {
      if (!host.active()) return;
      host.releasePointer(e.pointerId);
      host.hideBrush();
      endPress();
    },

    pointerLeave(e) {
      if (!host.active() || !e.isPrimary) return;
      const axis = host.axis();
      if (pressing || axis.pinned.peek()) return;
      cancelFrame?.();
      cancelFrame = null;
      axis.cursor.value = null;
    },

    keyDown(e) {
      if (!host.active()) return false;
      if (e.ctrlKey || e.metaKey || e.altKey) return false; // browser zoom etc. keep working
      const axis = host.axis();
      const V = axis.view.peek();
      const step = axis.stepSeconds.peek();
      const c = axis.cursor.peek();
      const mid = (V.start + V.end) / 2;
      const setCursor = (t: number): void => {
        axis.cursor.value = clampCursor(t, V);
      };
      switch (e.key) {
        case "ArrowLeft":
        case "ArrowRight": {
          const delta = (e.shiftKey ? CURSOR_BIG_STEP : 1) * step;
          if (e.key === "ArrowLeft") setCursor((c ?? V.end - 0.001) - delta);
          else setCursor(c === null ? V.start : c + delta);
          return true;
        }
        case "Home":
          setCursor(V.start);
          return true;
        case "End":
          setCursor(V.end);
          return true;
        case "+":
        case "=":
          if (!host.zoomable()) return false;
          axis.zoomAround(c ?? mid, KEY_ZOOM_FACTOR);
          return true;
        case "-":
          if (!host.zoomable()) return false;
          axis.zoomAround(c ?? mid, 1 / KEY_ZOOM_FACTOR);
          return true;
        case "Enter": {
          const next = !axis.pinned.peek();
          host.batch(() => {
            if (next && c === null) setCursor(V.end);
            axis.pinned.value = next;
          });
          host.onPin(next);
          return true;
        }
        case "Escape":
          if (brushing) {
            host.hideBrush();
            endPress();
            return true;
          }
          if (axis.pinned.peek()) {
            axis.pinned.value = false;
            host.onPin(false);
            return true;
          }
          return false; // not prevented: bubbles to other handlers
        default:
          return false;
      }
    },

    cursorFraction(t) {
      if (t === null || !host.active()) return Number.NaN;
      const f = host.map().toFraction(t);
      return f >= 0 && f <= 1 ? f : Number.NaN;
    },

    invalidate() {
      rect = null;
    },

    dispose() {
      cancelFrame?.();
      cancelFrame = null;
    },
  };
}
