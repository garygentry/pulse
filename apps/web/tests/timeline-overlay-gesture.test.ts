// Unit tests for the framework-neutral overlay gesture controller, driven with a fake host over a
// real createTimeAxis axis (no DOM).
import { afterEach, describe, expect, test } from "bun:test";
import { batch, signal } from "@preact/signals-core";
import { CURSOR_BIG_STEP, KEY_ZOOM_FACTOR, createTimeAxis } from "../src/client/views/_shared/timeseries/axis.js";
import type { TimeAxisController, TimeWindow } from "../src/client/views/_shared/timeseries/axis.js";
import {
  BRUSH_MIN_PX,
  TOO_NARROW_TEXT,
  createOverlayGesture,
  overlayPlacementStyle,
} from "../src/client/views/_shared/timeseries/overlay-gesture.js";
import type { GestureKey, GesturePointer, OverlayGesture, OverlayPlacement } from "../src/client/views/_shared/timeseries/overlay-gesture.js";

const DAY = 86_400;
const STEP = 145;
const NOW = 1_800_000_000;
const DOMAIN: TimeWindow = { start: NOW - DAY, end: NOW };
const MID = (DOMAIN.start + DOMAIN.end) / 2;
const LEFT = 100;
const WIDTH = 1000;

interface Harness {
  axis: TimeAxisController;
  g: OverlayGesture;
  log: string[];
  pins: boolean[];
  announced: string[];
  brush: { left: number; width: number } | null;
  frames: (() => void)[];
  setActive(v: boolean): void;
  setZoomable(v: boolean): void;
}

const axes: TimeAxisController[] = [];
afterEach(() => {
  for (const a of axes.splice(0)) a.dispose();
});

function harness(): Harness {
  const axis = createTimeAxis({ domain: signal(DOMAIN), initialZoom: null, initialStepSeconds: STEP });
  axes.push(axis);
  let active = true;
  let zoomable = true;
  const h: Harness = {
    axis,
    g: null as unknown as OverlayGesture,
    log: [],
    pins: [],
    announced: [],
    brush: null,
    frames: [],
    setActive: (v) => {
      active = v;
    },
    setZoomable: (v) => {
      zoomable = v;
    },
  };
  h.g = createOverlayGesture({
    axis: () => axis,
    map: () => axis,
    zoomable: () => zoomable,
    active: () => active,
    measure: () => ({ left: LEFT, width: WIDTH }),
    capturePointer: (id) => h.log.push(`capture:${id}`),
    releasePointer: (id) => h.log.push(`release:${id}`),
    showBrush: (left, width) => {
      h.brush = { left, width };
    },
    hideBrush: () => {
      h.brush = null;
    },
    announce: (text) => h.announced.push(text),
    onPin: (p) => h.pins.push(p),
    batch,
    requestFrame: (cb) => {
      h.frames.push(cb);
      return () => {
        const i = h.frames.indexOf(cb);
        if (i >= 0) h.frames.splice(i, 1);
      };
    },
  });
  return h;
}

function flushFrames(h: Harness): void {
  for (const cb of h.frames.splice(0)) cb();
}

function ptr(type: string, clientX: number, extra: Partial<GesturePointer> = {}): GesturePointer {
  return { type, pointerId: 1, pointerType: "mouse", isPrimary: true, button: 0, clientX, ...extra };
}

function key(k: string, extra: Partial<GestureKey> = {}): GestureKey {
  return { key: k, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...extra };
}

const xAt = (f: number): number => LEFT + f * WIDTH;

describe("overlay gesture — pointer", () => {
  test("a drag below BRUSH_MIN_PX is a click that pins the cursor", () => {
    const h = harness();
    const x0 = xAt(0.5);
    h.g.pointerDown(ptr("pointerdown", x0));
    h.g.pointerMove(ptr("pointermove", x0 + BRUSH_MIN_PX - 1));
    expect(h.brush).toBeNull();
    h.g.pointerUp(ptr("pointerup", x0 + BRUSH_MIN_PX - 1));
    expect(h.axis.pinned.value).toBe(true);
    expect(h.axis.cursor.value).toBeCloseTo(MID + ((BRUSH_MIN_PX - 1) / WIDTH) * DAY, 6);
    expect(h.axis.zoom.value).toBeNull();
    expect(h.pins).toEqual([true]);
    expect(h.log).toEqual(["capture:1", "release:1"]);
  });

  test("a drag of exactly BRUSH_MIN_PX brushes; a brush narrower than 2 steps is ignored and announced", () => {
    const h = harness();
    const x0 = xAt(0.5);
    const drag = (): void => {
      h.g.pointerDown(ptr("pointerdown", x0));
      h.g.pointerMove(ptr("pointermove", x0 + BRUSH_MIN_PX));
      expect(h.brush?.left).toBeCloseTo(0.5, 9);
      expect(h.brush?.width).toBeCloseTo(BRUSH_MIN_PX / WIDTH, 9);
      h.g.pointerUp(ptr("pointerup", x0 + BRUSH_MIN_PX));
      expect(h.brush).toBeNull();
    };
    // 4 px of a 1000 px box over 24 h ≈ 346 s ≥ 2 × 145 s: zooms.
    drag();
    const zoomed = h.axis.zoom.value;
    expect(zoomed).not.toBeNull();
    expect(h.announced).toEqual([]);
    // Inside that zoom, a 4 px drag is < 2 steps: ignored and announced.
    drag();
    expect(h.axis.zoom.value).toEqual(zoomed);
    expect(h.announced).toEqual([TOO_NARROW_TEXT]);
    expect(h.axis.pinned.value).toBe(false);
    expect(h.pins).toEqual([]);
  });

  test("a wide brush zooms the axis to the brushed window and does not pin", () => {
    const h = harness();
    h.g.pointerDown(ptr("pointerdown", xAt(0.75)));
    h.g.pointerMove(ptr("pointermove", xAt(0.25)));
    expect(h.brush?.left).toBeCloseTo(0.25, 9);
    expect(h.brush?.width).toBeCloseTo(0.5, 9);
    h.g.pointerUp(ptr("pointerup", xAt(0.25)));
    const z = h.axis.zoom.value;
    expect(z).not.toBeNull();
    expect(z?.start).toBeCloseTo(DOMAIN.start + 0.25 * DAY, 3);
    expect(z?.end).toBeCloseTo(DOMAIN.start + 0.75 * DAY, 3);
    expect(h.axis.pinned.value).toBe(false);
    expect(h.announced).toEqual([]);
  });

  test("a non-zoomable overlay never brushes: a long drag is a click", () => {
    const h = harness();
    h.setZoomable(false);
    h.g.pointerDown(ptr("pointerdown", xAt(0.25)));
    h.g.pointerMove(ptr("pointermove", xAt(0.75)));
    expect(h.brush).toBeNull();
    h.g.pointerUp(ptr("pointerup", xAt(0.75)));
    expect(h.axis.zoom.value).toBeNull();
    expect(h.axis.pinned.value).toBe(true);
  });

  test("pointer cancel mid-drag hides the brush, releases capture and ends the gesture", () => {
    const h = harness();
    h.g.pointerDown(ptr("pointerdown", xAt(0.2)));
    h.g.pointerMove(ptr("pointermove", xAt(0.6)));
    expect(h.brush).not.toBeNull();
    h.g.pointerCancel(ptr("pointercancel", xAt(0.6)));
    expect(h.brush).toBeNull();
    expect(h.log).toEqual(["capture:1", "release:1"]);
    h.g.pointerUp(ptr("pointerup", xAt(0.6)));
    expect(h.axis.zoom.value).toBeNull();
    expect(h.axis.pinned.value).toBe(false);
    expect(h.pins).toEqual([]);
  });

  test("hover queues one cursor write per frame (latest wins); leave clears it", () => {
    const h = harness();
    h.g.pointerMove(ptr("pointermove", xAt(0.1)));
    h.g.pointerMove(ptr("pointermove", xAt(0.5)));
    expect(h.frames.length).toBe(1);
    expect(h.axis.cursor.value).toBeNull();
    flushFrames(h);
    expect(h.axis.cursor.value).toBeCloseTo(MID, 6);
    h.g.pointerMove(ptr("pointermove", xAt(0.9)));
    h.g.pointerLeave(ptr("pointerleave", xAt(0.9)));
    expect(h.frames.length).toBe(0);
    expect(h.axis.cursor.value).toBeNull();
  });

  test("secondary mouse buttons, non-primary pointers and an inactive overlay are ignored", () => {
    const h = harness();
    h.g.pointerDown(ptr("pointerdown", xAt(0.5), { button: 2 }));
    h.g.pointerDown(ptr("pointerdown", xAt(0.5), { isPrimary: false }));
    expect(h.log).toEqual([]);
    h.setActive(false);
    h.g.pointerDown(ptr("pointerdown", xAt(0.5)));
    h.g.pointerUp(ptr("pointerup", xAt(0.5)));
    expect(h.log).toEqual([]);
    expect(h.g.keyDown(key("Home"))).toBe(false);
    expect(h.g.cursorFraction(MID)).toBeNaN();
  });

  test("cursorFraction maps inside the box and is NaN outside or for null", () => {
    const h = harness();
    expect(h.g.cursorFraction(MID)).toBeCloseTo(0.5, 9);
    expect(h.g.cursorFraction(null)).toBeNaN();
    expect(h.g.cursorFraction(DOMAIN.end + 3600)).toBeNaN();
  });
});

describe("overlay gesture — keyboard intents", () => {
  test("ArrowRight starts at view start then steps by one step; Shift steps by CURSOR_BIG_STEP", () => {
    const h = harness();
    expect(h.g.keyDown(key("ArrowRight"))).toBe(true);
    expect(h.axis.cursor.value).toBe(DOMAIN.start);
    h.g.keyDown(key("ArrowRight"));
    expect(h.axis.cursor.value).toBe(DOMAIN.start + STEP);
    h.g.keyDown(key("ArrowRight", { shiftKey: true }));
    expect(h.axis.cursor.value).toBe(DOMAIN.start + STEP + CURSOR_BIG_STEP * STEP);
  });

  test("ArrowLeft starts just inside view end and steps back; Shift steps by CURSOR_BIG_STEP", () => {
    const h = harness();
    expect(h.g.keyDown(key("ArrowLeft"))).toBe(true);
    expect(h.axis.cursor.value).toBeCloseTo(DOMAIN.end - 0.001 - STEP, 6);
    const c = h.axis.cursor.value as number;
    h.g.keyDown(key("ArrowLeft", { shiftKey: true }));
    expect(h.axis.cursor.value).toBeCloseTo(c - CURSOR_BIG_STEP * STEP, 6);
  });

  test("Home and End jump to the view edges", () => {
    const h = harness();
    expect(h.g.keyDown(key("End"))).toBe(true);
    expect(h.axis.cursor.value).toBeCloseTo(DOMAIN.end - 0.001, 6);
    expect(h.g.keyDown(key("Home"))).toBe(true);
    expect(h.axis.cursor.value).toBe(DOMAIN.start);
  });

  test("+ and = zoom in around the cursor (or mid); - zooms out", () => {
    for (const k of ["+", "="]) {
      const h = harness();
      expect(h.g.keyDown(key(k))).toBe(true);
      const z = h.axis.zoom.value;
      expect(z).not.toBeNull();
      expect((z as TimeWindow).end - (z as TimeWindow).start).toBeCloseTo(DAY / KEY_ZOOM_FACTOR, 3);
      expect(((z as TimeWindow).start + (z as TimeWindow).end) / 2).toBeCloseTo(MID, 3);
    }
    const h = harness();
    h.g.keyDown(key("+"));
    h.g.keyDown(key("+"));
    expect(h.g.keyDown(key("-"))).toBe(true);
    const z = h.axis.zoom.value as TimeWindow;
    expect(z.end - z.start).toBeCloseTo(DAY / KEY_ZOOM_FACTOR, 3);
  });

  test("zoom keys are not handled when the overlay is not zoomable", () => {
    const h = harness();
    h.setZoomable(false);
    for (const k of ["+", "=", "-"]) expect(h.g.keyDown(key(k))).toBe(false);
    expect(h.axis.zoom.value).toBeNull();
  });

  test("Enter pins at view end when there is no cursor, and toggles the pin off again", () => {
    const h = harness();
    expect(h.g.keyDown(key("Enter"))).toBe(true);
    expect(h.axis.pinned.value).toBe(true);
    expect(h.axis.cursor.value).toBeCloseTo(DOMAIN.end - 0.001, 6);
    expect(h.g.keyDown(key("Enter"))).toBe(true);
    expect(h.axis.pinned.value).toBe(false);
    expect(h.pins).toEqual([true, false]);
  });

  test("Escape cancels an active brush first, then unpins, else is not handled", () => {
    const h = harness();
    h.g.keyDown(key("Enter"));
    h.g.pointerDown(ptr("pointerdown", xAt(0.2)));
    h.g.pointerMove(ptr("pointermove", xAt(0.6)));
    expect(h.brush).not.toBeNull();
    expect(h.g.keyDown(key("Escape"))).toBe(true);
    expect(h.brush).toBeNull();
    expect(h.axis.pinned.value).toBe(true);
    h.g.pointerUp(ptr("pointerup", xAt(0.6)));
    expect(h.axis.zoom.value).toBeNull();
    expect(h.g.keyDown(key("Escape"))).toBe(true);
    expect(h.axis.pinned.value).toBe(false);
    expect(h.pins).toEqual([true, false]);
    expect(h.g.keyDown(key("Escape"))).toBe(false);
  });

  test("modified keys and unknown keys are not handled", () => {
    const h = harness();
    expect(h.g.keyDown(key("+", { ctrlKey: true }))).toBe(false);
    expect(h.g.keyDown(key("ArrowRight", { metaKey: true }))).toBe(false);
    expect(h.g.keyDown(key("Home", { altKey: true }))).toBe(false);
    expect(h.g.keyDown(key("a"))).toBe(false);
    expect(h.axis.cursor.value).toBeNull();
    expect(h.axis.zoom.value).toBeNull();
  });
});

describe("overlay placement style", () => {
  test("fill and inert cover the box; rect is positioned in px", () => {
    const fill: OverlayPlacement = { kind: "fill" };
    expect(overlayPlacementStyle(fill).inset).toBe("0");
    expect(overlayPlacementStyle({ kind: "inert" }).inset).toBe("0");
    const s = overlayPlacementStyle({ kind: "rect", rect: { left: 1, top: 2, width: 3, height: 4 } });
    expect([s.left, s.top, s.width, s.height]).toEqual(["1px", "2px", "3px", "4px"]);
  });
});
