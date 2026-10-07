// apps/web/tests/timeline-view-keyboard.test.ts — keyboard and pointer bindings of /timeline
// (08 §4.2; REQ-A11Y-02/03, REQ-ZOOM-01/02). Item 013 seeds it with the 06 §5.4 overlay keys and
// the 06 §5.3 pointer model, rendering PlotOverlay directly over a createTimeAxis axis; items
// 018–020 add the controls, lane-tree and swimlane cases, and item 023 repeats every binding
// against the mounted TimelineView (08 §4.1 router setup, installHistoryStub + TIMELINE_INCIDENT).
//
// Harness per 08 §4.1: the lazy chart is stubbed through the shared StubChart (one top-level
// mock.module, real module re-mocked in afterAll, resetChartStub in afterEach). happy-dom's
// getBoundingClientRect returns zeros, so the overlay root's rect is stubbed; rAF runs on
// microtasks for this file and flushes run inside act().

import { afterAll, afterEach, beforeAll, beforeEach, expect, jest, mock, setSystemTime, spyOn, test } from "bun:test";
import { createElement } from "react";
import type { ReactElement } from "react";
import { signal } from "@preact/signals-core";

import { createAppStore } from "../src/client/store/index.js";
import { createEstateClock } from "../src/client/format.js";
import { CURSOR_BIG_STEP, KEY_ZOOM_FACTOR, createTimeAxis } from "../src/client/views/_shared/timeseries/axis.js";
import type { TimeAxisController, TimeWindow } from "../src/client/views/_shared/timeseries/axis.js";
import { PlotOverlay } from "../src/client/views/_shared/timeseries/overlay.js";
import { BRUSH_MIN_PX } from "../src/client/views/_shared/timeseries/overlay-gesture.js";
import type { OverlayPlacement } from "../src/client/views/_shared/timeseries/overlay-gesture.js";
import { SyncedChart } from "../src/client/views/_shared/timeseries/chart.js";
import { CursorReadout, createReadoutRegistry } from "../src/client/views/_shared/timeseries/readout.js";
import { READOUT_ANNOUNCE_DEBOUNCE_MS } from "../src/client/views/_shared/timeseries/readout-model.js";
import { RangeSelector } from "../src/client/views/timeline/controls.js";
import { TIMELINE_KEY_BINDINGS, TimelineKeyboardHints, installTimelineKeyboard } from "../src/client/views/timeline/keyboard.js";
import { TIMELINE_RANGES } from "../src/client/views/_shared/timeseries/query-meta.js";
import type { RangeId } from "@pulse/web-data/wire";
import { isolateDomGlobals } from "./alerts-dom-isolation.js";
import { describeDom, restoreRealTimers } from "./dom.js";
import { installUiStubs } from "./rtl.js";
import { StubChart, resetChartStub } from "./chart-stub.js";
import { TIMELINE_NOW_S, installHistoryStub, makeHierarchySnapshot, makeSeriesHistory, makeTimelineIndex } from "./timeline-fixtures.js";
import { LaneTree } from "../src/client/views/timeline/lanes.js";
import { buildLaneBlocks, laneEvidence } from "../src/client/views/timeline/lanes-model.js";
import type { LaneEvidenceContext } from "../src/client/views/timeline/lanes-model.js";
import { buildLaneTree, targetKey } from "../src/client/views/timeline/model.js";
import type { LaneNode, TargetKey } from "../src/client/views/timeline/model.js";
import { createLaneEvidenceCache } from "../src/client/views/timeline/evidence.js";
import { AlertSwimlane } from "../src/client/views/timeline/swimlane.js";
import type { IntervalHistoryPayload } from "@pulse/web-data/wire";
import { TIMELINE_INCIDENT, makeAlertHistory, makeAlertLane } from "./timeline-fixtures.js";
import type { StubRoute } from "./timeline-fixtures.js";
import { brushWindow, zoomWindow } from "../src/client/views/_shared/timeseries/axis.js";
import { formatCursorTime } from "../src/client/views/_shared/timeseries/readout-model.js";
import { HOST_CHART_QUERIES } from "../src/client/views/_shared/timeseries/query-meta.js";
import { createPathRouter } from "../src/client/router.js";
import type { PathRouter } from "../src/client/router.js";
import type { AppStore } from "../src/client/store/index.js";
import { delivery, makeObservation } from "./engine-fixtures.js";
import { useSignals } from "@preact/signals-react/runtime";
import { act } from "./react-render.js";

isolateDomGlobals();

const CHART = "../src/client/ui/viz/uplot-chart.js";
const realChart = { ...(await import(CHART)) };
mock.module(CHART, () => ({ default: StubChart }));
afterEach(() => {
  resetChartStub();
});
afterAll(() => {
  mock.module(CHART, () => realChart);
});

/** `createElement` typed to return a plain element (exactOptionalPropertyTypes rejects ReactElement<P> → ReactElement<{}>). */
const el = createElement as unknown as (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) => ReactElement;

const DAY = 86_400;
const STEP = 145; // 24h effective step
const DOMAIN: TimeWindow = { start: TIMELINE_NOW_S - DAY, end: TIMELINE_NOW_S };
const MID = (DOMAIN.start + DOMAIN.end) / 2;
/** Overlay root geometry (px): a 1000 px wide box starting at x = 100. */
const OVERLAY_LEFT = 100;
const OVERLAY_WIDTH = 1000;
const FILL: OverlayPlacement = { kind: "fill" };
const CLOCK = createEstateClock({ name: "", timezone: "America/Chicago", tzFallback: false });

/** flush() plus one timer turn (Radix roving focus moves focus in a setTimeout). */
async function tick(): Promise<void> {
  await act(async () => {
    await new Promise<void>((r) => setTimeout(r, 0));
  });
  await flush();
}

async function flush(rounds = 60): Promise<void> {
  // React runs non-urgent updates on a scheduler task; act() flushes them with the microtasks.
  await act(async () => {
    for (let i = 0; i < rounds; i++) await Promise.resolve();
  });
}

function newAxis(): TimeAxisController {
  return createTimeAxis({ domain: signal(DOMAIN), initialZoom: null, initialStepSeconds: STEP });
}

describeDom("timeline keyboard — PlotOverlay (item 013)", (dom) => {
  let savedGlobalRaf: PropertyDescriptor | undefined;
  let rectSpy: { mockRestore(): void } | null = null;
  const mounted: { unmount(): void }[] = [];
  const axes: TimeAxisController[] = [];

  beforeAll(() => {
    const g = globalThis as unknown as { requestAnimationFrame?: unknown };
    savedGlobalRaf = Object.getOwnPropertyDescriptor(g, "requestAnimationFrame");
    g.requestAnimationFrame = (cb: (t: number) => void): number => {
      queueMicrotask(() => cb(0));
      return 0;
    };
    const proto = (dom.win as unknown as { HTMLElement: { prototype: HTMLElement } }).HTMLElement.prototype;
    rectSpy = spyOn(proto, "getBoundingClientRect").mockImplementation(function (this: HTMLElement): DOMRect {
      const r = this.dataset["slot"] === "plot-overlay" || this.classList.contains("u-over")
        ? { left: OVERLAY_LEFT, top: 0, width: OVERLAY_WIDTH, height: 200 }
        : { left: 0, top: 0, width: this.dataset["slot"] === "timeseries-plot" ? OVERLAY_WIDTH + 200 : 0, height: 260 };
      return { ...r, x: r.left, y: r.top, right: r.left + r.width, bottom: r.top + r.height, toJSON: () => r } as DOMRect;
    });
  });

  afterEach(() => {
    while (mounted.length > 0) mounted.pop()!.unmount();
    while (axes.length > 0) axes.pop()!.dispose();
    restoreRealTimers();
  });

  afterAll(() => {
    const g = globalThis as unknown as { requestAnimationFrame?: unknown };
    if (savedGlobalRaf === undefined) delete g.requestAnimationFrame;
    else Object.defineProperty(g, "requestAnimationFrame", savedGlobalRaf);
    rectSpy?.mockRestore();
  });

  async function mountOverlay(extra: Record<string, unknown> = {}): Promise<{ axis: TimeAxisController; overlay: HTMLElement; pins: boolean[] }> {
    const axis = newAxis();
    axes.push(axis);
    const pins: boolean[] = [];
    const m = await dom.mount(
      el("div", { style: { position: "relative" } },
        el(PlotOverlay, { axis, label: "Hosts", placement: FILL, interactive: true, describedBy: "pulse-timeline-readout", onPin: (p: boolean) => pins.push(p), ...extra })),
    );
    mounted.push(m);
    await flush();
    const overlay = m.container.querySelector<HTMLElement>("[data-slot=plot-overlay]")!;
    overlay.focus();
    return { axis, overlay, pins };
  }

  function key(target: HTMLElement, k: string, mods: { shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean } = {}): KeyboardEvent {
    const e = new dom.win.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...mods }) as unknown as KeyboardEvent;
    target.dispatchEvent(e);
    return e;
  }

  // React derives pointerenter/pointerleave from pointerover/pointerout with a relatedTarget, so an
  // enter or leave is dispatched as the over/out event a browser fires alongside it.
  const BOUNDARY_EVENT: Record<string, string> = { pointerenter: "pointerover", pointerleave: "pointerout" };

  function pointer(target: HTMLElement, type: string, clientX: number, extra: Record<string, unknown> = {}): void {
    const boundary: Record<string, unknown> = type in BOUNDARY_EVENT ? { relatedTarget: null } : {};
    const e = new dom.win.PointerEvent(BOUNDARY_EVENT[type] ?? type, {
      clientX, clientY: 10, pointerId: 1, isPrimary: true, pointerType: "mouse", button: 0, bubbles: true, cancelable: true, ...boundary, ...extra,
    });
    target.dispatchEvent(e as unknown as Event);
  }

  const xAt = (f: number): number => OVERLAY_LEFT + f * OVERLAY_WIDTH;

  // --- DOM and accessibility (06 §5.2, §5.7) -------------------------------------------------------

  test("REQ-A11Y-02: an active overlay is a focusable named group with key shortcuts and a description", async () => {
    const { overlay } = await mountOverlay();
    expect(overlay.getAttribute("data-state")).toBe("active");
    expect(overlay.getAttribute("role")).toBe("group");
    expect(overlay.getAttribute("tabindex")).toBe("0");
    expect(overlay.getAttribute("aria-label")).toBe("Hosts — time cursor");
    expect(overlay.getAttribute("aria-describedby")).toBe("pulse-timeline-readout");
    expect(overlay.getAttribute("aria-keyshortcuts")).toContain("Shift+ArrowLeft");
    expect(overlay.hasAttribute("aria-hidden")).toBe(false);
    expect(overlay.querySelector("[data-slot=plot-cursor]")!.getAttribute("aria-hidden")).toBe("true");
    expect(overlay.querySelector<HTMLElement>("[data-slot=plot-brush]")!.hidden).toBe(true);
  });

  test("REQ-KIOSK-03: interactive=false renders the passive shield (no role, tabindex or keys; aria-hidden)", async () => {
    const { axis, overlay } = await mountOverlay({ interactive: false });
    expect(overlay.getAttribute("data-state")).toBe("inert");
    expect(overlay.hasAttribute("role")).toBe(false);
    expect(overlay.hasAttribute("tabindex")).toBe(false);
    expect(overlay.hasAttribute("aria-keyshortcuts")).toBe(false);
    expect(overlay.getAttribute("aria-hidden")).toBe("true");
    const e = key(overlay, "ArrowRight");
    expect(e.defaultPrevented).toBe(false);
    pointer(overlay, "pointerdown", xAt(0.5));
    pointer(overlay, "pointerup", xAt(0.5));
    await flush();
    expect(axis.cursor.value).toBeNull();
    expect(axis.pinned.value).toBe(false);
  });

  // --- Keyboard map (06 §5.4) ----------------------------------------------------------------------

  test("REQ-A11Y-02: ArrowRight/ArrowLeft move the cursor one step (null starts at the view start / end)", async () => {
    const { axis, overlay } = await mountOverlay();
    const e1 = key(overlay, "ArrowRight");
    expect(e1.defaultPrevented).toBe(true);
    expect(axis.cursor.value).toBe(DOMAIN.start);
    key(overlay, "ArrowRight");
    expect(axis.cursor.value).toBe(DOMAIN.start + STEP);
    key(overlay, "ArrowLeft");
    expect(axis.cursor.value).toBe(DOMAIN.start);
    key(overlay, "ArrowLeft"); // clamped at the view start
    expect(axis.cursor.value).toBe(DOMAIN.start);
    axis.cursor.value = null;
    key(overlay, "ArrowLeft");
    expect(axis.cursor.value).toBeCloseTo(DOMAIN.end - 0.001 - STEP, 6);
    expect(axis.pinned.value).toBe(false);
  });

  test("REQ-A11Y-02: Shift+ArrowRight/Left move CURSOR_BIG_STEP steps", async () => {
    const { axis, overlay } = await mountOverlay();
    axis.cursor.value = MID;
    const e = key(overlay, "ArrowRight", { shiftKey: true });
    expect(e.defaultPrevented).toBe(true);
    expect(axis.cursor.value).toBe(MID + CURSOR_BIG_STEP * STEP);
    key(overlay, "ArrowLeft", { shiftKey: true });
    key(overlay, "ArrowLeft", { shiftKey: true });
    expect(axis.cursor.value).toBe(MID - CURSOR_BIG_STEP * STEP);
  });

  test("REQ-A11Y-02: Home/End jump to the view start / the latest instant of the view", async () => {
    const { axis, overlay } = await mountOverlay();
    expect(key(overlay, "End").defaultPrevented).toBe(true);
    expect(axis.cursor.value).toBeCloseTo(DOMAIN.end - 0.001, 6);
    expect(key(overlay, "Home").defaultPrevented).toBe(true);
    expect(axis.cursor.value).toBe(DOMAIN.start);
  });

  test("REQ-ZOOM-02: + and = zoom in KEY_ZOOM_FACTOR× around the cursor (or the midpoint); - zooms out", async () => {
    const { axis, overlay } = await mountOverlay();
    const e = key(overlay, "+");
    expect(e.defaultPrevented).toBe(true);
    const z1 = axis.zoom.value!;
    expect(z1).not.toBeNull();
    expect(z1.end - z1.start).toBeCloseTo(DAY / KEY_ZOOM_FACTOR, -1);
    expect((z1.start + z1.end) / 2).toBeCloseTo(MID, -1);
    key(overlay, "=", { shiftKey: false });
    const z2 = axis.zoom.value!;
    expect(z2.end - z2.start).toBeCloseTo(DAY / KEY_ZOOM_FACTOR ** 2, -1);
    expect(key(overlay, "-").defaultPrevented).toBe(true);
    const z3 = axis.zoom.value!;
    expect(z3.end - z3.start).toBeCloseTo(DAY / KEY_ZOOM_FACTOR, -1);
    key(overlay, "-");
    expect(axis.zoom.value).toBeNull(); // back to the full domain
    // With a cursor, the zoom is anchored on it.
    axis.cursor.value = DOMAIN.start + DAY / 4;
    key(overlay, "+");
    const z4 = axis.zoom.value!;
    expect(z4.start).toBeLessThanOrEqual(DOMAIN.start + DAY / 4);
    expect(z4.end).toBeGreaterThanOrEqual(DOMAIN.start + DAY / 4);
    expect(z4.start).toBeLessThan(MID - DAY / 4);
  });

  test("REQ-A11Y-02: Ctrl+=, Meta+- and Alt+ArrowLeft are ignored and never preventDefault-ed", async () => {
    const { axis, overlay } = await mountOverlay();
    const c = key(overlay, "=", { ctrlKey: true });
    expect(c.defaultPrevented).toBe(false);
    expect(key(overlay, "-", { metaKey: true }).defaultPrevented).toBe(false);
    expect(key(overlay, "ArrowLeft", { altKey: true }).defaultPrevented).toBe(false);
    expect(axis.zoom.value).toBeNull();
    expect(axis.cursor.value).toBeNull();
  });

  test("REQ-ZOOM-02: + and - are ignored (not prevented) with zoomable=false", async () => {
    const { axis, overlay } = await mountOverlay({ zoomable: false });
    expect(key(overlay, "+").defaultPrevented).toBe(false);
    expect(key(overlay, "=").defaultPrevented).toBe(false);
    expect(key(overlay, "-").defaultPrevented).toBe(false);
    expect(axis.zoom.value).toBeNull();
    // Cursor keys still work.
    expect(key(overlay, "Home").defaultPrevented).toBe(true);
  });

  test("REQ-A11Y-02: Enter pins (setting the cursor at the view end when null) and toggles; Escape unpins", async () => {
    const { axis, overlay, pins } = await mountOverlay();
    const e = key(overlay, "Enter");
    expect(e.defaultPrevented).toBe(true);
    expect(axis.pinned.value).toBe(true);
    expect(axis.cursor.value).toBeCloseTo(DOMAIN.end - 0.001, 6);
    // A pinned cursor can still be moved by keyboard.
    key(overlay, "Home");
    expect(axis.cursor.value).toBe(DOMAIN.start);
    expect(axis.pinned.value).toBe(true);
    key(overlay, "Enter");
    expect(axis.pinned.value).toBe(false);
    key(overlay, "Enter");
    expect(axis.cursor.value).toBe(DOMAIN.start); // an existing cursor is kept
    const esc = key(overlay, "Escape");
    expect(esc.defaultPrevented).toBe(true);
    expect(axis.pinned.value).toBe(false);
    expect(pins).toEqual([true, false, true, false]);
  });

  test("REQ-A11Y-02: Escape while not pinned is not handled, not prevented, and bubbles", async () => {
    const { axis, overlay, pins } = await mountOverlay();
    let bubbled = 0;
    const onKey = (): void => {
      bubbled++;
    };
    document.addEventListener("keydown", onKey);
    try {
      const e = key(overlay, "Escape");
      expect(e.defaultPrevented).toBe(false);
      expect(bubbled).toBe(1);
      // Handled keys are not stopped either (they bubble, only preventDefault is called).
      key(overlay, "ArrowRight");
      expect(bubbled).toBe(2);
    } finally {
      document.removeEventListener("keydown", onKey);
    }
    expect(axis.pinned.value).toBe(false);
    expect(pins).toEqual([]);
  });

  test("REQ-A11Y-02: an unrelated key is not prevented", async () => {
    const { overlay } = await mountOverlay();
    expect(key(overlay, "a").defaultPrevented).toBe(false);
    expect(key(overlay, "0").defaultPrevented).toBe(false);
  });

  // --- Cursor line (06 §5.5) -----------------------------------------------------------------------

  test("REQ-ZOOM-01: the cursor line follows axis.cursor by transform, dashed vs pinned, hidden when null or outside the view", async () => {
    const { axis, overlay } = await mountOverlay();
    const line = overlay.querySelector<HTMLElement>("[data-slot=plot-cursor]")!;
    axis.cursor.value = DOMAIN.start + DAY / 4;
    await flush();
    expect(line.style.visibility).toBe("visible");
    expect(line.style.transform).toBe("translateX(25%)");
    expect(line.dataset.pinned).toBe("false");
    axis.pinned.value = true;
    await flush();
    expect(line.dataset.pinned).toBe("true");
    axis.zoom.value = { start: MID, end: DOMAIN.end };
    await flush();
    expect(line.style.visibility).toBe("hidden"); // outside the zoomed view
    axis.cursor.value = null;
    await flush();
    expect(line.style.visibility).toBe("hidden");
  });

  // --- Pointer model (06 §5.3) ---------------------------------------------------------------------

  test("REQ-ZOOM-01: pointermove writes the cursor once per frame (latest wins); pointerleave clears it", async () => {
    const { axis, overlay } = await mountOverlay();
    pointer(overlay, "pointerenter", xAt(0.1));
    pointer(overlay, "pointermove", xAt(0.1));
    pointer(overlay, "pointermove", xAt(0.5));
    expect(axis.cursor.value).toBeNull(); // coalesced to the next frame
    await flush();
    expect(axis.cursor.value).toBe(MID);
    pointer(overlay, "pointerleave", xAt(1.2));
    expect(axis.cursor.value).toBeNull();
    // A non-primary pointer is ignored.
    pointer(overlay, "pointermove", xAt(0.25), { isPrimary: false });
    await flush();
    expect(axis.cursor.value).toBeNull();
  });

  test(`REQ-ZOOM-02: a pointer drag of ≥ BRUSH_MIN_PX (${BRUSH_MIN_PX}px) zooms the axis via brush and issues no history request`, async () => {
    const stub = installHistoryStub([]);
    try {
      const { axis, overlay, pins } = await mountOverlay();
      const brushSpy = spyOn(axis, "brush");
      pointer(overlay, "pointerdown", xAt(0.25));
      pointer(overlay, "pointermove", xAt(0.25) + BRUSH_MIN_PX);
      pointer(overlay, "pointermove", xAt(0.75));
      const brush = overlay.querySelector<HTMLElement>("[data-slot=plot-brush]")!;
      expect(brush.hidden).toBe(false);
      expect(brush.style.left).toBe("25%");
      expect(brush.style.width).toBe("50%");
      pointer(overlay, "pointerup", xAt(0.75));
      await flush();
      expect(brush.hidden).toBe(true);
      expect(brushSpy).toHaveBeenCalledTimes(1);
      const z = axis.zoom.value!;
      expect(z).toEqual({ start: DOMAIN.start + DAY / 4, end: DOMAIN.start + (3 * DAY) / 4 });
      expect(axis.pinned.value).toBe(false);
      expect(pins).toEqual([]);
      expect(stub.calls.length).toBe(0);
    } finally {
      stub.restore();
    }
  });

  test("REQ-ZOOM-02: a drag of exactly BRUSH_MIN_PX brushes; a brush narrower than 2 steps is ignored and announced", async () => {
    const { axis, overlay } = await mountOverlay();
    // 4 px of a 1000 px box over 24 h ≈ 346 s ≥ 2 × 145 s: zooms.
    pointer(overlay, "pointerdown", xAt(0.5));
    pointer(overlay, "pointermove", xAt(0.5) + BRUSH_MIN_PX);
    pointer(overlay, "pointerup", xAt(0.5) + BRUSH_MIN_PX);
    await flush();
    expect(axis.zoom.value).not.toBeNull();
    // Inside that ~6 min zoom, a 4 px drag is < 2 steps: ignored, with a polite announcement.
    const before = axis.zoom.value;
    pointer(overlay, "pointerdown", xAt(0.5));
    pointer(overlay, "pointermove", xAt(0.5) + BRUSH_MIN_PX);
    pointer(overlay, "pointerup", xAt(0.5) + BRUSH_MIN_PX);
    await flush();
    await flush();
    expect(axis.zoom.value).toEqual(before);
    expect(axis.pinned.value).toBe(false);
    // announce() resolves `globalThis.document` at call time; across a full `bun test` run that can be
    // a window leaked by an earlier file rather than this file's `document`, so read both. The text is
    // set on the next frame: poll briefly with real timers.
    const docs = [document, (globalThis as { document?: Document }).document];
    const announced = (): string => docs.map((d) => d?.getElementById("pulse-a11y-announcer")?.textContent ?? "").join(" ");
    for (let i = 0; i < 50 && !announced().includes("Selection too narrow"); i++) {
      await new Promise<void>((r) => setTimeout(r, 10));
    }
    expect(announced()).toContain("Selection too narrow to zoom — minimum 2 steps");
  });

  test(`REQ-ZOOM-02: a drag < ${BRUSH_MIN_PX}px is a click that pins the cursor (and a second click moves the pin)`, async () => {
    const { axis, overlay, pins } = await mountOverlay();
    pointer(overlay, "pointerdown", xAt(0.5));
    pointer(overlay, "pointermove", xAt(0.5) + BRUSH_MIN_PX - 1);
    pointer(overlay, "pointerup", xAt(0.5) + BRUSH_MIN_PX - 1);
    await flush();
    expect(axis.zoom.value).toBeNull();
    expect(axis.pinned.value).toBe(true);
    expect(axis.cursor.value).toBeCloseTo(MID + ((BRUSH_MIN_PX - 1) / OVERLAY_WIDTH) * DAY, 6);
    expect(pins).toEqual([true]);
    // Hover no longer moves a pinned cursor; a click moves the pin.
    pointer(overlay, "pointermove", xAt(0.1));
    await flush();
    expect(axis.cursor.value).toBeCloseTo(MID + ((BRUSH_MIN_PX - 1) / OVERLAY_WIDTH) * DAY, 6);
    pointer(overlay, "pointerdown", xAt(0.25));
    pointer(overlay, "pointerup", xAt(0.25));
    expect(axis.cursor.value).toBe(DOMAIN.start + DAY / 4);
    expect(axis.pinned.value).toBe(true);
  });

  test("REQ-ZOOM-02: zoomable=false never brushes (a long drag pins); pointercancel and Escape cancel a brush", async () => {
    const { axis, overlay } = await mountOverlay({ zoomable: false });
    pointer(overlay, "pointerdown", xAt(0.2));
    pointer(overlay, "pointermove", xAt(0.6));
    pointer(overlay, "pointerup", xAt(0.6));
    await flush();
    expect(axis.zoom.value).toBeNull();
    expect(axis.pinned.value).toBe(true);

    const z = await mountOverlay();
    const brush = z.overlay.querySelector<HTMLElement>("[data-slot=plot-brush]")!;
    pointer(z.overlay, "pointerdown", xAt(0.2));
    pointer(z.overlay, "pointermove", xAt(0.6));
    expect(brush.hidden).toBe(false);
    pointer(z.overlay, "pointercancel", xAt(0.6));
    expect(brush.hidden).toBe(true);
    pointer(z.overlay, "pointerup", xAt(0.6));
    expect(z.axis.zoom.value).toBeNull();

    pointer(z.overlay, "pointerdown", xAt(0.2));
    pointer(z.overlay, "pointermove", xAt(0.6));
    expect(key(z.overlay, "Escape").defaultPrevented).toBe(true);
    expect(brush.hidden).toBe(true);
    pointer(z.overlay, "pointerup", xAt(0.6));
    expect(z.axis.zoom.value).toBeNull();
    expect(z.axis.pinned.value).toBe(false);
  });

  test("REQ-ZOOM-02: a missing or throwing setPointerCapture is caught and the drag still works", async () => {
    const { axis, overlay } = await mountOverlay();
    (overlay as unknown as { setPointerCapture: () => void }).setPointerCapture = () => {
      throw new Error("no capture");
    };
    pointer(overlay, "pointerdown", xAt(0.25));
    pointer(overlay, "pointermove", xAt(0.75));
    pointer(overlay, "pointerup", xAt(0.75));
    await flush();
    expect(axis.zoom.value).toEqual({ start: DOMAIN.start + DAY / 4, end: DOMAIN.start + (3 * DAY) / 4 });
  });

  test("REQ-ZOOM-02: a brush on a chart zooms the shared page axis, so every overlay over it follows", async () => {
    const axis = newAxis();
    axes.push(axis);
    const registry = createReadoutRegistry();
    const m = await dom.mount(
      el("div", null,
        el("div", { style: { position: "relative" } }, el(PlotOverlay, { axis, label: "Hosts", placement: FILL, interactive: true })),
        el(SyncedChart, {
          chartId: "c", title: "CPU utilization", unit: "percent", range: "24h",
          payload: makeSeriesHistory("host.cpu.utilization", "24h"), axis, clock: CLOCK, interactive: true,
          readout: { mode: "page", registry, summaryId: "s" },
        })),
    );
    mounted.push(m);
    for (let i = 0; i < 4; i++) {
      await flush();
      await new Promise<void>((r) => setTimeout(r, 0));
    }
    const chartOverlay = m.container.querySelector<HTMLElement>("[data-slot=timeseries-plot] [data-slot=plot-overlay]")!;
    expect(chartOverlay.getAttribute("data-state")).toBe("active");
    pointer(chartOverlay, "pointerdown", xAt(0.5));
    pointer(chartOverlay, "pointermove", xAt(1));
    pointer(chartOverlay, "pointerup", xAt(1));
    await flush();
    expect(axis.zoom.value).toEqual({ start: MID, end: DOMAIN.end });
    // The lane overlay's cursor line maps through the same (now zoomed) view.
    axis.cursor.value = MID + DAY / 4;
    await flush();
    const laneLine = m.container.querySelector<HTMLElement>("[data-slot=plot-cursor]")!;
    expect(laneLine.style.transform).toBe("translateX(50%)");
  });

  // --- Readout debounce (06 §9) --------------------------------------------------------------------

  test("REQ-A11Y-03: after an overlay cursor move the aria-live summary is unchanged at 249 ms and updated at 250 ms", async () => {
    jest.useFakeTimers();
    const axis = newAxis();
    axes.push(axis);
    const registry = createReadoutRegistry();
    registry.register({ id: "lanes", read: () => [{ label: "web01", status: "ok", text: "ok", partial: null }] });
    const m = await dom.mount(
      el("div", null,
        el("div", { style: { position: "relative" } },
          el(PlotOverlay, { axis, label: "Hosts", placement: FILL, interactive: true, describedBy: "pulse-timeline-readout" })),
        el(CursorReadout, { axis, registry, clock: CLOCK, summaryId: "pulse-timeline-readout" })),
    );
    mounted.push(m);
    await flush();
    const overlay = m.container.querySelector<HTMLElement>("[data-slot=plot-overlay]")!;
    const summary = m.container.querySelector("#pulse-timeline-readout")!;
    key(overlay, "Home");
    await flush();
    jest.advanceTimersByTime(READOUT_ANNOUNCE_DEBOUNCE_MS - 1);
    await flush();
    expect(summary.textContent).toBe("");
    jest.advanceTimersByTime(1);
    await flush();
    expect(summary.textContent).toContain("Cursor ");
    expect(summary.textContent).toContain("1 lanes OK.");
  });
});

describeDom("timeline keyboard — RangeSelector, view shortcuts and hints (item 018)", (dom) => {
  const mounted: { unmount(): void }[] = [];
  const cleanups: (() => void)[] = [];

  beforeAll(() => {
    // Effects (the roving-tabindex install) flush inside act().
  });

  afterEach(() => {
    while (mounted.length > 0) mounted.pop()!.unmount();
    while (cleanups.length > 0) cleanups.pop()!();
  });

  afterAll(() => {
  });

  async function mount(vnode: ReactElement): Promise<HTMLElement> {
    const m = await dom.mount(vnode);
    mounted.push(m);
    await flush();
    return m.container;
  }

  function keydown(target: EventTarget, k: string): KeyboardEvent {
    const e = new dom.win.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }) as unknown as KeyboardEvent;
    target.dispatchEvent(e);
    return e;
  }

  test("REQ-A11Y-02: RangeSelector is the 'Time range' radiogroup of 4 radio buttons with one tab stop and the checked option equal to value", async () => {
    const c = await mount(el(RangeSelector, { value: "24h", onChange: () => {} }));
    const group = c.querySelector<HTMLElement>('[role="radiogroup"]')!;
    expect(group.getAttribute("aria-label")).toBe("Time range");
    expect(group.getAttribute("data-slot")).toBe("segmented-control");
    expect(group.closest("[aria-keyshortcuts]")!.getAttribute("aria-keyshortcuts")).toBe("[ ]");
    const radios = Array.from(group.querySelectorAll<HTMLElement>('[role="radio"]'));
    expect(radios.length).toBe(4);
    expect(radios.map((r) => r.tagName)).toEqual(["BUTTON", "BUTTON", "BUTTON", "BUTTON"]);
    expect(radios.map((r) => r.getAttribute("type"))).toEqual(["button", "button", "button", "button"]);
    expect(radios.map((r) => r.textContent)).toEqual(["1h", "6h", "24h", "7d"]);
    expect(radios.some((r) => r.hasAttribute("aria-label"))).toBe(false);
    // Roving tabindex: entering the group (Radix forwards focus from the group) lands on the checked
    // option, which is then the only radio in the tab order.
    const stops = (): string[] =>
      radios.filter((n) => n.getAttribute("tabindex") === "0").map((n) => n.textContent ?? "");
    const checked = radios.filter((r) => r.getAttribute("aria-checked") === "true");
    expect(checked.map((r) => r.textContent)).toEqual(["24h"]);
    group.focus();
    await tick();
    expect(globalThis.document.activeElement === checked[0]!).toBe(true);
    expect(stops()).toEqual(["24h"]);
    expect(group.querySelector("input")).toBeNull();
  });

  test("REQ-A11Y-02: arrow keys move focus between range options without changing the range; activating the focused option (Enter/Space → click) selects it", async () => {
    const calls: RangeId[] = [];
    const value = signal<RangeId>("6h");
    const Host = (): ReactElement => {
      useSignals();
      return el(RangeSelector, { value: value.value, onChange: (r: RangeId) => { calls.push(r); value.value = r; } });
    };
    const c = await mount(el(Host, null));
    const doc = globalThis.document;
    const radios = (): HTMLElement[] => Array.from(c.querySelectorAll<HTMLElement>('[role="radio"]'));
    const focused = (): string | null => (doc.activeElement as HTMLElement | null)?.textContent ?? null;
    const checked = (): string | null => c.querySelector('[role="radio"][aria-checked="true"]')?.textContent ?? null;
    const press = async (k: string): Promise<void> => {
      keydown(doc.activeElement!, k);
      await tick(); // the roving group moves focus on a timer
    };

    radios()[1]!.focus();
    expect(focused()).toBe("6h");
    await press("ArrowRight");
    expect(focused()).toBe("24h");
    expect(calls).toEqual([]); // focus only: the range is unchanged
    expect(checked()).toBe("6h");
    await press("ArrowLeft");
    await press("ArrowLeft");
    expect(focused()).toBe("1h");
    await press("End");
    expect(focused()).toBe("7d");
    await press("Home");
    expect(focused()).toBe("1h");
    expect(calls).toEqual([]);

    // Enter / Space on a native button activate it (click): that checks the focused option.
    (doc.activeElement as HTMLElement).click();
    await flush();
    expect(calls).toEqual(["1h"]);
    expect(checked()).toBe("1h");
    expect(radios().filter((r) => r.getAttribute("tabindex") === "0").map((r) => r.textContent)).toEqual(["1h"]);

    // Activating the already-checked option changes nothing (it cannot be deselected).
    radios()[0]!.click();
    await flush();
    expect(calls).toEqual(["1h"]);
    expect(checked()).toBe("1h");
  });

  test("REQ-A11Y-02: clicking an option calls onChange with that range; a new onChange identity is honoured", async () => {
    const first: RangeId[] = [];
    const second: RangeId[] = [];
    const which = signal(0);
    const Host = (): ReactElement => {
      useSignals();
      return el(RangeSelector, { value: "24h", onChange: which.value === 0 ? (r: RangeId) => first.push(r) : (r: RangeId) => second.push(r) });
    };
    const c = await mount(el(Host, null));
    const radios = Array.from(c.querySelectorAll<HTMLElement>('[role="radio"]'));
    radios[0]!.click();
    which.value = 1;
    await flush();
    Array.from(c.querySelectorAll<HTMLElement>('[role="radio"]'))[3]!.click();
    expect(first).toEqual(["1h"]);
    expect(second).toEqual(["7d"]);
  });

  test("REQ-A11Y-02: installTimelineKeyboard maps 0, l, [ and ] to their callbacks, skips inputs and is removed by its disposer", async () => {
    const counts = { resetZoom: 0, toggleLive: 0, previousRange: 0, nextRange: 0 };
    const dispose = installTimelineKeyboard({
      resetZoom: () => counts.resetZoom++,
      toggleLive: () => counts.toggleLive++,
      previousRange: () => counts.previousRange++,
      nextRange: () => counts.nextRange++,
    });
    cleanups.push(dispose);
    const doc = globalThis.document;

    for (const k of ["0", "l", "[", "]"]) expect(keydown(doc, k).defaultPrevented).toBe(true);
    expect(counts).toEqual({ resetZoom: 1, toggleLive: 1, previousRange: 1, nextRange: 1 });

    // Modified combos do not match (Ctrl+0 is browser zoom reset).
    doc.dispatchEvent(new dom.win.KeyboardEvent("keydown", { key: "0", ctrlKey: true, bubbles: true, cancelable: true }) as unknown as Event);
    expect(counts.resetZoom).toBe(1);

    // None fires while focus is in an <input>.
    const input = doc.createElement("input");
    doc.body.appendChild(input);
    input.focus();
    for (const k of ["0", "l", "[", "]"]) keydown(input, k);
    expect(counts).toEqual({ resetZoom: 1, toggleLive: 1, previousRange: 1, nextRange: 1 });
    input.remove();

    // After the disposer (called twice: idempotent) none fires.
    dispose();
    dispose();
    for (const k of ["0", "l", "[", "]"]) keydown(doc, k);
    expect(counts).toEqual({ resetZoom: 1, toggleLive: 1, previousRange: 1, nextRange: 1 });
  });

  test("REQ-A11Y-02: view shortcuts fire while a range option button has focus", async () => {
    let next = 0;
    const dispose = installTimelineKeyboard({ resetZoom: () => {}, toggleLive: () => {}, previousRange: () => {}, nextRange: () => next++ });
    cleanups.push(dispose);
    const c = await mount(el(RangeSelector, { value: "24h", onChange: () => {} }));
    const radio = c.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]')!;
    radio.focus();
    keydown(radio, "]");
    expect(next).toBe(1);
  });

  test("REQ-A11Y-02: TimelineKeyboardHints renders all 19 TIMELINE_KEY_BINDINGS rows with Kbd keycaps", async () => {
    expect(TIMELINE_KEY_BINDINGS.length).toBe(19);
    const c = await mount(el(TimelineKeyboardHints, null));
    const details = c.querySelector("details[data-slot=timeline-kbd-hints]")!;
    expect(details).not.toBeNull();
    expect(details.querySelector("summary")!.textContent).toBe("Keyboard shortcuts");
    const caption = details.querySelector("table caption")!;
    expect(caption.textContent).toBe("Timeline keyboard shortcuts");
    const heads = Array.from(details.querySelectorAll("thead th"));
    expect(heads.map((th) => th.textContent)).toEqual(["Where", "Keys", "Action"]);
    expect(heads.every((th) => th.getAttribute("scope") === "col")).toBe(true);

    const rows = Array.from(details.querySelectorAll("tbody tr"));
    expect(rows.length).toBe(19);
    rows.forEach((row, i) => {
      const hint = TIMELINE_KEY_BINDINGS[i]!;
      const cells = row.querySelectorAll("td");
      expect(cells[0]!.textContent).toBe(hint.context);
      expect(cells[2]!.textContent).toBe(hint.action);
      const caps = Array.from(cells[1]!.querySelectorAll("kbd[data-slot=kbd]"));
      expect(caps.map((k) => k.textContent)).toEqual(hint.combos.flat());
      expect(cells[1]!.querySelectorAll("[data-slot=kbd-group]").length).toBe(hint.combos.length);
    });
    const contexts = new Set(TIMELINE_KEY_BINDINGS.map((b) => b.context));
    expect([...contexts]).toEqual(["Plot (lanes, alert history, charts)", "Alert history row", "Lane list", "Range selector", "Anywhere"]);
    const anywhere = TIMELINE_KEY_BINDINGS.filter((b) => b.context === "Anywhere").map((b) => b.combos);
    expect(anywhere).toEqual([[["0"]], [["L"]], [["["], ["]"]]]);
    const range = TIMELINE_KEY_BINDINGS.filter((b) => b.context === "Range selector").map((b) => [b.combos, b.action]);
    expect(range).toEqual([
      [[["←"], ["→"]], "Move between ranges"],
      [[["Enter"], ["Space"]], "Select the focused range"],
    ]);
    expect(TIMELINE_RANGES.length).toBe(4);
  });
});

describeDom("timeline keyboard — lane tree (item 019)", (dom) => {
  const mounted: { unmount(): void }[] = [];
  const axes: TimeAxisController[] = [];

  beforeAll(() => {
    // Effects (the roving-tabindex install and refresh) flush inside act().
  });

  afterEach(() => {
    while (mounted.length > 0) mounted.pop()!.unmount();
    while (axes.length > 0) axes.pop()!.dispose();
  });

  afterAll(() => {
  });

  function keydown(target: EventTarget, k: string): KeyboardEvent {
    const e = new dom.win.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }) as unknown as KeyboardEvent;
    target.dispatchEvent(e);
    return e;
  }

  /** data-lane-key of the focused element in the row's own document (compared as a string, never as a node). */
  function focusedKey(rowEl: HTMLElement): string | null {
    const active = rowEl.ownerDocument.activeElement as HTMLElement | null;
    return active?.getAttribute("data-lane-key") ?? null;
  }

  /** Two declared domains (09 §3), so the Domains group is present. */
  const TREE_DOMAINS = [
    { domain: "a.example", endpoint: "dns:a.example" },
    { domain: "b.example", endpoint: "dns:b.example" },
  ] as const;

  /** A stateful harness: onToggle flips expansion like the view does; onSelect is recorded. */
  async function mountTree(): Promise<{
    c: HTMLElement;
    hosts: readonly LaneNode[];
    toggles: (TargetKey | "domains")[];
    selects: LaneNode[];
    active: () => HTMLElement;
    row: (key: string) => HTMLElement;
  }> {
    const snapshot = makeHierarchySnapshot({ hosts: 3, servicesPerHost: 2 });
    const hosts = buildLaneTree(snapshot, makeTimelineIndex(snapshot)).hosts;
    const expanded = signal<ReadonlySet<TargetKey>>(new Set());
    const domainsExpanded = signal(false);
    const toggles: (TargetKey | "domains")[] = [];
    const selects: LaneNode[] = [];
    const axis = newAxis();
    axes.push(axis);
    const readouts = createReadoutRegistry();
    const cache = createLaneEvidenceCache();
    const Host = (): ReactElement => {
      useSignals();
      const blocks = buildLaneBlocks(hosts, expanded.value, TREE_DOMAINS, domainsExpanded.value);
      const ctx: LaneEvidenceContext = { alertLanes: [], noData: [], lookup: () => undefined, expanded: expanded.value, window: DOMAIN, cache, reachable: () => false };
      const evidence = new Map(blocks.flatMap((b) => b.rows).map((row) => [row.key, laneEvidence(row, ctx)] as const));
      return el(LaneTree, {
        reachable: () => false,
        blocks,
        evidence,
        selected: null,
        axis,
        readouts,
        clock: CLOCK,
        interactive: true,
        readoutId: "pulse-timeline-readout",
        status: null,
        onToggle: (key: TargetKey | "domains") => {
          toggles.push(key);
          if (key === "domains") domainsExpanded.value = !domainsExpanded.value;
          else {
            const next = new Set(expanded.value);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            expanded.value = next;
          }
        },
        onSelect: (node: LaneNode) => selects.push(node),
      });
    };
    const m = await dom.mount(el(Host, null));
    mounted.push(m);
    await flush();
    const c = m.container;
    return {
      c,
      hosts,
      toggles,
      selects,
      active: () => c.querySelector<HTMLElement>('[role="treeitem"][tabindex="0"]')!,
      row: (key: string) => c.querySelector<HTMLElement>(`[data-lane-key="${key}"]`)!,
    };
  }

  test("REQ-A11Y-02: lane tree ↑/↓/Home/End move the single tab stop and focus between rows", async () => {
    const t = await mountTree();
    const keys = [...t.hosts.map((n) => targetKey(n.target)), "domains"];
    const items = (): HTMLElement[] => Array.from(t.c.querySelectorAll<HTMLElement>('[role="treeitem"]'));
    expect(items().filter((r) => r.getAttribute("tabindex") === "0").length).toBe(1);
    expect(t.active().getAttribute("data-lane-key")).toBe(keys[0]!);

    expect(keydown(t.active(), "ArrowDown").defaultPrevented).toBe(true);
    expect(t.active().getAttribute("data-lane-key")).toBe(keys[1]!);
    expect(focusedKey(t.active())).toBe(keys[1]!);
    keydown(t.active(), "ArrowUp");
    expect(t.active().getAttribute("data-lane-key")).toBe(keys[0]!);
    keydown(t.active(), "ArrowUp"); // no wrap
    expect(t.active().getAttribute("data-lane-key")).toBe(keys[0]!);
    keydown(t.active(), "End");
    expect(t.active().getAttribute("data-lane-key")).toBe("domains");
    keydown(t.active(), "ArrowDown"); // no wrap
    expect(t.active().getAttribute("data-lane-key")).toBe("domains");
    keydown(t.active(), "Home");
    expect(t.active().getAttribute("data-lane-key")).toBe(keys[0]!);
    expect(items().filter((r) => r.getAttribute("tabindex") === "0").length).toBe(1);
  });

  test("REQ-A11Y-02: → expands a collapsed host (onToggle) and then moves to its first child; ← moves to the parent and then collapses", async () => {
    const t = await mountTree();
    const host = targetKey(t.hosts[0]!.target);
    const firstChild = targetKey(t.hosts[0]!.children[0]!.target);

    expect(keydown(t.row(host), "ArrowRight").defaultPrevented).toBe(true);
    expect(t.toggles).toEqual([host]);
    await flush();
    expect(t.row(host).getAttribute("aria-expanded")).toBe("true");
    expect(t.row(firstChild)).not.toBeNull();
    expect(t.active().getAttribute("data-lane-key")).toBe(host);

    expect(keydown(t.row(host), "ArrowRight").defaultPrevented).toBe(true);
    expect(t.toggles).toEqual([host]);
    expect(t.active().getAttribute("data-lane-key")).toBe(firstChild);
    expect(focusedKey(t.row(firstChild))).toBe(firstChild);

    // ← on a service moves to the parent without toggling.
    expect(keydown(t.row(firstChild), "ArrowLeft").defaultPrevented).toBe(true);
    expect(t.toggles).toEqual([host]);
    expect(t.active().getAttribute("data-lane-key")).toBe(host);

    // ← on the expanded host collapses it; focus stays on the host.
    expect(keydown(t.row(host), "ArrowLeft").defaultPrevented).toBe(true);
    expect(t.toggles).toEqual([host, host]);
    await flush();
    expect(t.row(host).getAttribute("aria-expanded")).toBe("false");
    expect(t.c.querySelector(`[data-lane-key="${firstChild}"]`)).toBeNull();
    expect(t.active().getAttribute("data-lane-key")).toBe(host);

    // ← on a collapsed host does nothing (not prevented).
    expect(keydown(t.row(host), "ArrowLeft").defaultPrevented).toBe(false);
    expect(t.toggles).toEqual([host, host]);
  });

  test("REQ-A11Y-02 / REQ-ECR-C3: Enter selects a host or service and toggles Domains; domain rows are reachable, ← returns to Domains, Enter/Space/click never select", async () => {
    const t = await mountTree();
    const host = targetKey(t.hosts[1]!.target);
    expect(keydown(t.row(host), "Enter").defaultPrevented).toBe(true);
    expect(t.selects.map((n) => targetKey(n.target))).toEqual([host]);

    keydown(t.row(host), "ArrowRight");
    await flush();
    const svc = targetKey(t.hosts[1]!.children[1]!.target);
    expect(keydown(t.row(svc), "Enter").defaultPrevented).toBe(true);
    expect(t.selects.map((n) => targetKey(n.target))).toEqual([host, svc]);

    expect(keydown(t.row("domains"), "Enter").defaultPrevented).toBe(true);
    expect(t.toggles).toEqual([host, "domains"]);
    await flush();
    expect(t.c.querySelector('[data-lane-key="domains-note"]')).toBeNull();
    expect(t.c.textContent).not.toContain("Check history is not available for domain checks.");
    const a = t.row("endpoint:dns:a.example");
    const b = t.row("endpoint:dns:b.example");
    expect(a.querySelector("[data-slot=timeline-lane-name]")!.textContent).toBe("a.example");
    for (const k of ["Enter", " "]) {
      expect(keydown(a, k).defaultPrevented).toBe(false);
      expect(keydown(b, k).defaultPrevented).toBe(false);
    }
    a.click();
    expect(t.selects.length).toBe(2); // host + service only
    expect(t.toggles).toEqual([host, "domains"]);
    expect(a.hasAttribute("aria-selected")).toBe(false);
    // → on the expanded Domains header moves to the first domain row; ↓ reaches the next; End the last.
    keydown(t.row("domains"), "ArrowRight");
    expect(t.active().getAttribute("data-lane-key")).toBe("endpoint:dns:a.example");
    keydown(t.active(), "ArrowDown");
    expect(t.active().getAttribute("data-lane-key")).toBe("endpoint:dns:b.example");
    expect(focusedKey(b)).toBe("endpoint:dns:b.example");
    // → on a domain row does nothing; ← returns to the Domains header.
    expect(keydown(b, "ArrowRight").defaultPrevented).toBe(false);
    expect(keydown(b, "ArrowLeft").defaultPrevented).toBe(true);
    expect(t.active().getAttribute("data-lane-key")).toBe("domains");
  });

  test("REQ-A11Y-02: clicking a host row selects it and makes it the tab stop; the twisty toggles without selecting", async () => {
    const t = await mountTree();
    const host = targetKey(t.hosts[2]!.target);
    t.row(host).click();
    expect(t.selects.map((n) => targetKey(n.target))).toEqual([host]);
    expect(t.active().getAttribute("data-lane-key")).toBe(host);
    t.row(host).querySelector<HTMLElement>("[data-slot=timeline-lane-twisty]")!.click();
    expect(t.toggles).toEqual([host]);
    expect(t.selects.length).toBe(1);
    t.row("domains").click();
    expect(t.toggles).toEqual([host, "domains"]);
  });
});

describeDom("timeline keyboard — alert swimlane tracks (item 020)", (dom) => {
  const mounted: { unmount(): void }[] = [];
  const axes: TimeAxisController[] = [];
  const tree = buildLaneTree(TIMELINE_INCIDENT.snapshot, TIMELINE_INCIDENT.index);
  // The per-row help is a Radix tooltip portalled into document.body: install the happy-dom gaps Radix needs.
  let restoreUiStubs: (() => void) | null = null;

  beforeAll(() => {
    restoreUiStubs = installUiStubs();
  });

  afterEach(() => {
    while (mounted.length > 0) mounted.pop()!.unmount();
    while (axes.length > 0) axes.pop()!.dispose();
  });

  afterAll(() => {
    restoreUiStubs?.();
    restoreUiStubs = null;
  });

  function keydown(target: EventTarget, k: string, init: { readonly ctrlKey?: boolean } = {}): KeyboardEvent {
    const e = new dom.win.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }) as unknown as KeyboardEvent;
    target.dispatchEvent(e);
    return e;
  }

  const iso = (s: number): string => new Date(s * 1000).toISOString();

  async function mountSwim(payload: IntervalHistoryPayload): Promise<{ c: HTMLElement; axis: TimeAxisController; hrefs: string[] }> {
    const axis = newAxis();
    axes.push(axis);
    const hrefs: string[] = [];
    const m = await dom.mount(
      el(AlertSwimlane, {
        state: { phase: "ready", data: payload },
        onRetry: () => {},
        onShorterRange: null,
        tree,
        axis,
        readouts: createReadoutRegistry(),
        clock: CLOCK,
        interactive: true,
        readoutId: "pulse-timeline-readout",
        onNavigate: (href: string) => hrefs.push(href),
      }),
    );
    mounted.push(m);
    await flush();
    return { c: m.container, axis, hrefs };
  }

  function track(c: HTMLElement, sev: string): HTMLElement {
    return c.querySelector<HTMLElement>(`[data-swim-track][data-severity="${sev}"]`)!;
  }

  /** The open tooltip's text: the trigger wrapping the track points aria-describedby at the portalled role=tooltip node. */
  function tooltipText(t: HTMLElement): string | null {
    const id = t.closest("[data-slot=tooltip-trigger]")?.getAttribute("aria-describedby");
    if (id === null || id === undefined) return null;
    const tip = t.ownerDocument.body.querySelector(`[role="tooltip"][id="${id}"]`);
    // Portalled: the bubble lives in document.body, outside the swimlane.
    return tip === null || t.closest("[data-slot=timeline-swimlane]")?.contains(tip) === true ? null : tip.textContent;
  }

  test("REQ-SWIM-04/REQ-A11Y-02: →/←/Home/End move the active interval and the page cursor without pinning; the tooltip reads it in estate time", async () => {
    const { c, axis } = await mountSwim(TIMELINE_INCIDENT.alerts);
    const crit = track(c, "critical");
    crit.focus();
    crit.dispatchEvent(new dom.win.FocusEvent("focusin", { bubbles: true }) as unknown as Event);
    await flush();
    const hosts = tree.hosts;
    const expected = (i: number): string => {
      const start = TIMELINE_NOW_S - 9_000 + i * 300;
      const end = TIMELINE_NOW_S - 6_000 + i * 120;
      return `HostDown — ${hosts[i]!.label} — ${CLOCK.format(iso(start))} → ${CLOCK.format(iso(end))}`;
    };
    // Focus: active = first visible interval; the tooltip names it.
    expect(tooltipText(crit)).toBe(expected(0));
    expect(crit.querySelectorAll("[data-deco=active]").length).toBe(1);

    let e = keydown(crit, "ArrowRight");
    await flush();
    expect(e.defaultPrevented).toBe(true);
    expect(axis.cursor.value).toBe(TIMELINE_NOW_S - 9_000 + 300);
    expect(axis.pinned.value).toBe(false);
    expect(tooltipText(crit)).toBe(expected(1));

    e = keydown(crit, "End");
    await flush();
    expect(e.defaultPrevented).toBe(true);
    expect(axis.cursor.value).toBe(TIMELINE_NOW_S - 9_000 + 5 * 300);
    expect(tooltipText(crit)).toBe(expected(5));
    keydown(crit, "ArrowRight"); // clamped at the last interval
    await flush();
    expect(axis.cursor.value).toBe(TIMELINE_NOW_S - 9_000 + 5 * 300);

    keydown(crit, "ArrowLeft");
    await flush();
    expect(axis.cursor.value).toBe(TIMELINE_NOW_S - 9_000 + 4 * 300);
    keydown(crit, "Home");
    await flush();
    expect(axis.cursor.value).toBe(TIMELINE_NOW_S - 9_000);
    expect(tooltipText(crit)).toBe(expected(0));
    expect(axis.pinned.value).toBe(false);

    // Unhandled and modified keys are left alone.
    expect(keydown(crit, "a").defaultPrevented).toBe(false);
    expect(keydown(crit, "ArrowRight", { ctrlKey: true }).defaultPrevented).toBe(false);
  });

  test("REQ-SWIM-04: the cursor never moves before the visible window start when the interval began earlier", async () => {
    const { c, axis } = await mountSwim(TIMELINE_INCIDENT.alerts);
    axis.zoom.value = { start: TIMELINE_NOW_S - 8_000, end: TIMELINE_NOW_S - 4_000 };
    await flush();
    const crit = track(c, "critical");
    crit.focus();
    keydown(crit, "Home");
    await flush();
    expect(axis.cursor.value).toBe(TIMELINE_NOW_S - 8_000);
  });

  test("REQ-SWIM-04/REQ-SEC-04: Enter navigates to /alerts?hs=<encoded kind:id>, or /alerts?sev=<severity> for a null target", async () => {
    const { c, hrefs } = await mountSwim(TIMELINE_INCIDENT.alerts);
    const crit = track(c, "critical");
    crit.focus();
    const e = keydown(crit, "Enter");
    expect(e.defaultPrevented).toBe(true);
    expect(hrefs).toEqual([`/alerts?hs=${encodeURIComponent(`host:${tree.hosts[0]!.target.id}`)}`]);

    // Warning row: the first interval by start is DomainExpiring (target null).
    const warn = track(c, "warning");
    warn.focus();
    keydown(warn, "Home");
    keydown(warn, "Enter");
    expect(hrefs[1]).toBe("/alerts?sev=warning");

    // A target id carrying &, / and # stays inside one percent-encoded hs value.
    const hostileId = "host:a&x=1/b#c";
    const other = await mountSwim(
      makeAlertHistory("24h", [makeAlertLane({ alertname: "Odd", severity: "critical", target: { kind: "host", id: hostileId }, intervals: [[-600, -300]] })]),
    );
    const t = track(other.c, "critical");
    t.focus();
    keydown(t, "Enter");
    const href = other.hrefs[0]!;
    expect(href).toBe("/alerts?hs=host%3Ahost%3Aa%26x%3D1%2Fb%23c");
    expect(href).not.toContain("&");
    expect(href).not.toContain("#");
    const params = new URLSearchParams(href.slice(href.indexOf("?")));
    expect([...params.keys()]).toEqual(["hs"]);
    expect(params.get("hs")).toBe(`host:${hostileId}`);
  });

  test("REQ-SWIM-04: a row with no intervals in view ignores the keys and its tooltip says so", async () => {
    const { c, axis, hrefs } = await mountSwim(TIMELINE_INCIDENT.alerts);
    axis.zoom.value = { start: TIMELINE_NOW_S - 600, end: TIMELINE_NOW_S };
    await flush();
    const crit = track(c, "critical");
    crit.focus();
    crit.dispatchEvent(new dom.win.FocusEvent("focusin", { bubbles: true }) as unknown as Event);
    await flush();
    expect(tooltipText(crit)).toBe("No intervals in view");
    expect(keydown(crit, "ArrowRight").defaultPrevented).toBe(false);
    expect(keydown(crit, "Enter").defaultPrevented).toBe(false);
    expect(axis.cursor.value).toBeNull();
    expect(hrefs).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------
// Item 023 — every binding on the mounted TimelineView (07 §9, 06 §5.3–§5.4 and §7.3; 08 §4.1 setup)
// ---------------------------------------------------------------------------------------------------

describeDom("timeline keyboard — mounted TimelineView (item 023)", (dom) => {
  interface Mounted {
    readonly container: HTMLElement;
    readonly store: AppStore;
    readonly router: PathRouter;
    readonly stub: ReturnType<typeof installHistoryStub>;
    /** Every router.navigate call: [path, replace]. */ readonly navs: (readonly [string, boolean])[];
    unmount(): void;
  }

  let savedGlobalRaf: PropertyDescriptor | undefined;
  let rectSpy: { mockRestore(): void } | null = null;
  const live: Mounted[] = [];
  const cleanups: (() => void)[] = [];

  beforeAll(() => {
    const g = globalThis as unknown as { requestAnimationFrame?: unknown };
    savedGlobalRaf = Object.getOwnPropertyDescriptor(g, "requestAnimationFrame");
    g.requestAnimationFrame = (cb: (t: number) => void): number => {
      queueMicrotask(() => cb(0));
      return 0;
    };
    // Every overlay root (lane blocks, swimlane, charts) and each chart's .u-over is a 1000 px box at x = 100.
    const proto = (dom.win as unknown as { HTMLElement: { prototype: HTMLElement } }).HTMLElement.prototype;
    rectSpy = spyOn(proto, "getBoundingClientRect").mockImplementation(function (this: HTMLElement): DOMRect {
      const r = this.dataset["slot"] === "plot-overlay" || this.classList.contains("u-over")
        ? { left: OVERLAY_LEFT, top: 0, width: OVERLAY_WIDTH, height: 200 }
        : { left: 0, top: 0, width: this.dataset["slot"] === "timeseries-plot" ? OVERLAY_WIDTH + 200 : 0, height: 260 };
      return { ...r, x: r.left, y: r.top, right: r.left + r.width, bottom: r.top + r.height, toJSON: () => r } as DOMRect;
    });
  });

  beforeEach(() => {
    setSystemTime(new Date(TIMELINE_NOW_S * 1000));
  });

  afterEach(() => {
    while (live.length > 0) live.pop()!.unmount();
    while (cleanups.length > 0) cleanups.pop()!();
    restoreRealTimers();
    setSystemTime();
  });

  afterAll(() => {
    const g = globalThis as unknown as { requestAnimationFrame?: unknown };
    if (savedGlobalRaf === undefined) delete g.requestAnimationFrame;
    else Object.defineProperty(g, "requestAnimationFrame", savedGlobalRaf);
    rectSpy?.mockRestore();
  });

  const SNAP = TIMELINE_INCIDENT.snapshot;
  const VIEW_CLOCK = createEstateClock(SNAP.estate);
  const STEP_24H = TIMELINE_INCIDENT.alerts.effectiveStepSeconds;
  const D: TimeWindow = { start: TIMELINE_NOW_S - DAY, end: TIMELINE_NOW_S };
  const mid = (w: TimeWindow): number => (w.start + w.end) / 2;
  const ALERTS = "/api/history/alerts";
  const COVERAGE = "/api/history/estate/engine.active-series";
  const HOST0 = SNAP.hosts[0]!;
  const HOST0_SEL = `host:${HOST0.drilldownId}`;

  function routes(alerts: IntervalHistoryPayload = TIMELINE_INCIDENT.alerts): StubRoute[] {
    return [
      { path: ALERTS, reply: { status: 200, body: alerts } },
      { path: COVERAGE, reply: { status: 200, body: makeSeriesHistory("engine.active-series", "24h") } },
      ...HOST_CHART_QUERIES.map((q) => ({
        path: `/api/history/target/${encodeURIComponent(HOST0.drilldownId)}/${q}`,
        reply: { status: 200, body: makeSeriesHistory(q, "24h") },
      })),
    ];
  }

  /** Real-timer settle: microtasks plus macrotasks (lazy chart resolution, MutationObserver). */
  async function settle(): Promise<void> {
    // Inside act() so a lazy chunk that resolves here is revealed without React's fallback throttle.
    await act(async () => {
      for (let i = 0; i < 4; i++) {
        await flush();
        await new Promise<void>((r) => setTimeout(r, 0));
      }
      await flush();
    });
  }

  /** 08 §4.1 router and kiosk setup for /timeline. */
  async function mountView(search = "", alerts?: IntervalHistoryPayload): Promise<Mounted> {
    const { default: TimelineView } = await import("../src/client/views/timeline/view.js");
    const stub = installHistoryStub(routes(alerts));
    const win = dom.win as unknown as Window;
    win.history.replaceState({}, "", "/timeline" + search);
    const router = createPathRouter({ routes: [{ pattern: "/timeline", view: "timeline" }], fallback: "/timeline", win });
    const store = createAppStore({ storage: null, initialQuery: search.includes("kiosk=1") ? { kiosk: "1" } : {} });
    store.route.value = router.current();
    const off = router.subscribe((m) => {
      store.route.value = m;
    });
    store.snapshot.value = SNAP;
    store.timeline.value = TIMELINE_INCIDENT.index;
    store.connection.value = {
      ...store.connection.value,
      phase: "live",
      observation: makeObservation({ generation: "gen-1" }),
      views: { ...store.connection.value.views, timeline: delivery("current") },
    };
    const navs: (readonly [string, boolean])[] = [];
    const realNavigate = router.navigate.bind(router);
    (router as { navigate: PathRouter["navigate"] }).navigate = (path, opts) => {
      navs.push([path, opts?.replace === true]);
      realNavigate(path, opts);
    };
    const { container, unmount } = await dom.mount(el(TimelineView, { store, router, rotation: null }));
    await settle();
    const m: Mounted = {
      container, store, router, stub, navs,
      unmount(): void {
        unmount();
        off();
        router.stop();
        stub.restore();
      },
    };
    live.push(m);
    return m;
  }

  function dropMounted(m: Mounted): void {
    m.unmount();
    live.splice(live.indexOf(m), 1);
  }

  const all = (c: ParentNode, sel: string): HTMLElement[] => Array.from(c.querySelectorAll<HTMLElement>(sel));
  const query = (): URLSearchParams => new URLSearchParams((dom.win as unknown as Window).location.search);
  const doc = (): Document => globalThis.document;
  const at = (t: number): string => formatCursorTime(t, VIEW_CLOCK);
  /** The cursor readout's visible time line (formatCursorTime of axis.cursor, + " (pinned)"). */
  const readoutTime = (c: ParentNode): string => c.querySelector("[data-slot=cursor-readout-time]")!.textContent ?? "";
  /** The first lane block's overlay (the hosts block). */
  const laneOverlay = (c: ParentNode): HTMLElement =>
    c.querySelector<HTMLElement>('[data-block] [data-slot=plot-overlay][data-state="active"]')!;
  const activeOverlays = (c: ParentNode): HTMLElement[] => all(c, '[data-slot=plot-overlay][data-state="active"]');
  /** Cursor-line position of one overlay as a fraction of its width (NaN when hidden). */
  function cursorFraction(overlay: HTMLElement): number {
    const line = overlay.querySelector<HTMLElement>("[data-slot=plot-cursor]")!;
    if (line.style.visibility === "hidden") return Number.NaN;
    const m = /translateX\((-?[\d.e+-]+)%\)/.exec(line.style.transform);
    return m === null ? Number.NaN : Number(m[1]) / 100;
  }
  const button = (c: ParentNode, label: string): HTMLButtonElement =>
    all(c, "button").find((b) => (b.textContent ?? "").trim() === label) as HTMLButtonElement;
  const checkedRange = (c: ParentNode): string | null =>
    c.querySelector('[role="radio"][aria-checked="true"]')?.textContent ?? null;

  function key(target: EventTarget, k: string, mods: { readonly shiftKey?: boolean; readonly ctrlKey?: boolean } = {}): KeyboardEvent {
    const e = new dom.win.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...mods }) as unknown as KeyboardEvent;
    target.dispatchEvent(e);
    return e;
  }

  function pointer(target: HTMLElement, type: string, clientX: number): void {
    const e = new dom.win.PointerEvent(type, {
      clientX, clientY: 10, pointerId: 1, isPrimary: true, pointerType: "mouse", button: 0, bubbles: true, cancelable: true,
    });
    target.dispatchEvent(e as unknown as Event);
  }

  const xAt = (f: number): number => OVERLAY_LEFT + f * OVERLAY_WIDTH;

  // --- overlay keys (06 §5.4) --------------------------------------------------------------------------

  test("REQ-A11Y-02 / REQ-ZOOM-01: on a focused lane overlay ←/→ move one step, Shift+←/→ CURSOR_BIG_STEP steps, Home/End the view ends", async () => {
    const m = await mountView();
    const c = m.container;
    expect(STEP_24H).toBe(145);
    const o = laneOverlay(c);
    o.focus();

    let e = key(o, "ArrowRight");
    await flush();
    expect(e.defaultPrevented).toBe(true);
    expect(readoutTime(c)).toBe(at(D.start)); // a null cursor starts at the view start
    key(o, "ArrowRight");
    await flush();
    expect(readoutTime(c)).toBe(at(D.start + STEP_24H));
    e = key(o, "ArrowRight", { shiftKey: true });
    await flush();
    expect(e.defaultPrevented).toBe(true);
    expect(readoutTime(c)).toBe(at(D.start + STEP_24H + CURSOR_BIG_STEP * STEP_24H));
    key(o, "ArrowLeft", { shiftKey: true });
    await flush();
    expect(readoutTime(c)).toBe(at(D.start + STEP_24H));
    key(o, "ArrowLeft");
    await flush();
    expect(readoutTime(c)).toBe(at(D.start));

    e = key(o, "End");
    await flush();
    expect(e.defaultPrevented).toBe(true);
    expect(readoutTime(c)).toBe(at(D.end - 0.001));
    e = key(o, "Home");
    await flush();
    expect(e.defaultPrevented).toBe(true);
    expect(readoutTime(c)).toBe(at(D.start));

    // The cursor is page-wide: every overlay (the host lane block and the swimlane; TIMELINE_INCIDENT
    // declares no domains, so there is no Domains block, 09 §3) draws it at the start.
    const overlays = activeOverlays(c);
    expect(overlays.length).toBe(2);
    for (const ov of overlays) expect(cursorFraction(ov)).toBeCloseTo(0, 6);
    // Cursor moves never write the URL and never pin.
    expect(m.navs).toEqual([]);
    expect(readoutTime(c)).not.toContain("(pinned)");
  });

  test("REQ-ZOOM-01 / REQ-URL-01: + and = zoom in KEY_ZOOM_FACTOR× and - zooms out; the URL zoom is written with replace", async () => {
    const m = await mountView();
    const c = m.container;
    laneOverlay(c).focus();

    const z1 = zoomWindow(D, D, STEP_24H, mid(D), KEY_ZOOM_FACTOR)!;
    expect(z1.end - z1.start).toBe(DAY / KEY_ZOOM_FACTOR);
    let e = key(laneOverlay(c), "+");
    await settle();
    expect(e.defaultPrevented).toBe(true);
    expect(query().get("zoom")).toBe(`${z1.start}-${z1.end}`);
    expect(query().get("end")).toBe(String(TIMELINE_NOW_S)); // zooming while live pauses at the domain end
    expect(m.navs.length).toBe(1);
    expect(m.navs[0]![1]).toBe(true);
    expect(button(c, "Reset zoom").disabled).toBe(false);

    const z2 = zoomWindow(z1, D, STEP_24H, mid(z1), KEY_ZOOM_FACTOR)!;
    laneOverlay(c).focus();
    e = key(laneOverlay(c), "=");
    await settle();
    expect(e.defaultPrevented).toBe(true);
    expect(query().get("zoom")).toBe(`${z2.start}-${z2.end}`);

    const z3 = zoomWindow(z2, D, STEP_24H, mid(z2), 1 / KEY_ZOOM_FACTOR)!;
    laneOverlay(c).focus();
    e = key(laneOverlay(c), "-");
    await settle();
    expect(e.defaultPrevented).toBe(true);
    expect(query().get("zoom")).toBe(`${z3.start}-${z3.end}`);
    expect(z3.end - z3.start).toBe(z1.end - z1.start);

    expect(m.navs.length).toBe(3);
    expect(m.navs.every(([, replace]) => replace)).toBe(true);
  });

  test("REQ-A11Y-02: Enter pins (URL end written with replace) and Escape unpins; Ctrl+= and an unpinned Escape are not prevented", async () => {
    const m = await mountView();
    const c = m.container;
    const o = laneOverlay(c);
    o.focus();

    expect(key(o, "Escape").defaultPrevented).toBe(false);
    expect(key(o, "=", { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(key(o, "0", { ctrlKey: true }).defaultPrevented).toBe(false); // browser zoom reset is not ours
    await settle();
    expect(query().get("zoom")).toBeNull();
    expect(m.navs).toEqual([]);

    let e = key(laneOverlay(c), "Enter");
    await settle();
    expect(e.defaultPrevented).toBe(true);
    expect(readoutTime(c)).toBe(`${at(D.end - 0.001)} (pinned)`); // a null cursor pins at the view end
    expect(query().get("end")).toBe(String(TIMELINE_NOW_S));
    expect(m.navs.length).toBe(1);
    expect(m.navs[0]![1]).toBe(true);
    for (const ov of activeOverlays(c)) {
      expect(ov.querySelector<HTMLElement>("[data-slot=plot-cursor]")!.dataset["pinned"]).toBe("true");
    }

    e = key(laneOverlay(c), "Escape");
    await settle();
    expect(e.defaultPrevented).toBe(true);
    expect(readoutTime(c)).toBe(at(D.end - 0.001));
    expect(laneOverlay(c).querySelector<HTMLElement>("[data-slot=plot-cursor]")!.dataset["pinned"]).toBe("false");
    expect(query().get("end")).toBe(String(TIMELINE_NOW_S)); // unpinning does not resume live
    expect(m.navs.length).toBe(1);
  });

  // --- pointer: brush vs pin (06 §5.3) -------------------------------------------------------------------

  test(`REQ-ZOOM-02: a drag of ≥ BRUSH_MIN_PX (${BRUSH_MIN_PX}px) on one lane block zooms the whole page — every lane block, the swimlane and every chart — with no new history request`, async () => {
    const m = await mountView(`?sel=${encodeURIComponent(HOST0_SEL)}`);
    const c = m.container;
    await settle();
    const chartOverlays = (): HTMLElement[] => all(c, '[data-slot=timeseries-plot][data-overlay-state="measured"] [data-slot=plot-overlay][data-state="active"]');
    expect(chartOverlays().length).toBe(HOST_CHART_QUERIES.length);
    const callsBefore = m.stub.calls.length;
    const rects = (sel: string): string =>
      all(c.querySelector(sel)!, 'svg[role="img"] rect').map((r) => `${r.getAttribute("x")},${r.getAttribute("width")}`).join(" ");
    const hostBlockBefore = rects("[data-block]");
    const swimBefore = rects("[data-slot=timeline-swimlane]");
    expect(hostBlockBefore).not.toBe("");
    expect(swimBefore).not.toBe("");

    const o = laneOverlay(c);
    pointer(o, "pointerdown", xAt(0.25));
    pointer(o, "pointermove", xAt(0.5));
    pointer(o, "pointerup", xAt(0.5));
    await settle();

    const brushed = brushWindow(D, D, STEP_24H, 0.25, 0.5);
    if (brushed.kind !== "zoom" || brushed.window === null) throw new Error("expected a zoom brush");
    const w: TimeWindow = brushed.window;
    expect(query().get("zoom")).toBe(`${w.start}-${w.end}`);
    expect(m.navs.at(-1)![1]).toBe(true);
    expect(button(c, "Reset zoom").disabled).toBe(false);
    expect(readoutTime(c)).not.toContain("(pinned)"); // a brush is not a click
    // Every lane block and the swimlane are redrawn over the zoom window …
    expect(rects("[data-block]")).not.toBe(hostBlockBefore);
    expect(rects("[data-slot=timeline-swimlane]")).not.toBe(swimBefore);
    // … and every overlay (lane blocks, swimlane, the four charts) maps through the same axis.zoom:
    // a cursor at the zoom window's midpoint sits at 50 % of each of them.
    pointer(laneOverlay(c), "pointermove", xAt(0.5));
    await flush();
    expect(readoutTime(c)).toBe(at(mid(w)));
    const overlays = activeOverlays(c);
    expect(overlays.length).toBe(2 + HOST_CHART_QUERIES.length); // lane block + swimlane + charts (no Domains block)
    for (const ov of overlays) expect(cursorFraction(ov)).toBeCloseTo(0.5, 3);
    // The zoom reuses the loaded window: no new history request.
    await settle();
    expect(m.stub.calls.length).toBe(callsBefore);
  });

  test(`REQ-ZOOM-02: a drag < BRUSH_MIN_PX is a click that pins the cursor (axis.pinned, URL end with replace) and never zooms`, async () => {
    const m = await mountView();
    const c = m.container;
    const callsBefore = m.stub.calls.length;
    const o = laneOverlay(c);
    pointer(o, "pointerdown", xAt(0.5));
    pointer(o, "pointermove", xAt(0.5) + BRUSH_MIN_PX - 1);
    pointer(o, "pointerup", xAt(0.5) + BRUSH_MIN_PX - 1);
    await settle();
    const f = (0.5 * OVERLAY_WIDTH + BRUSH_MIN_PX - 1) / OVERLAY_WIDTH;
    expect(readoutTime(c)).toBe(`${at(D.start + f * DAY)} (pinned)`);
    expect(o.querySelector<HTMLElement>("[data-slot=plot-cursor]")!.dataset["pinned"]).toBe("true");
    expect(query().get("zoom")).toBeNull();
    expect(query().get("end")).toBe(String(TIMELINE_NOW_S));
    expect(m.navs).toEqual([[`/timeline?end=${TIMELINE_NOW_S}`, true]]);
    expect(button(c, "Reset zoom").disabled).toBe(true);
    expect(m.stub.calls.length).toBe(callsBefore);
  });

  // --- view shortcuts (07 §9) ------------------------------------------------------------------------------

  test("REQ-A11Y-02 / REQ-ZOOM-02: 0 resets zoom on the mounted view (replace); Ctrl+0 does not", async () => {
    const m = await mountView();
    const c = m.container;
    laneOverlay(c).focus();
    key(laneOverlay(c), "+");
    await settle();
    expect(query().get("zoom")).not.toBeNull();
    const navs = m.navs.length;

    expect(key(doc(), "0", { ctrlKey: true }).defaultPrevented).toBe(false);
    await settle();
    expect(query().get("zoom")).not.toBeNull();
    expect(m.navs.length).toBe(navs);

    expect(key(doc(), "0").defaultPrevented).toBe(true);
    await settle();
    expect(query().get("zoom")).toBeNull();
    expect(query().get("end")).toBe(String(TIMELINE_NOW_S)); // reset keeps the pause
    expect(m.navs.length).toBe(navs + 1);
    expect(m.navs.at(-1)![1]).toBe(true);
    expect(button(c, "Reset zoom").disabled).toBe(true);
  });

  test("REQ-A11Y-02 / REQ-FOLLOW-02: l pauses (push, end = domain end) and l resumes (push, end and zoom removed)", async () => {
    const m = await mountView();
    const c = m.container;
    expect(key(doc(), "l").defaultPrevented).toBe(true);
    await settle();
    expect(query().get("end")).toBe(String(TIMELINE_NOW_S));
    expect(m.navs).toEqual([[`/timeline?end=${TIMELINE_NOW_S}`, false]]);
    expect(c.querySelector("[data-live]")!.textContent).toContain("Showing until");

    laneOverlay(c).focus();
    key(laneOverlay(c), "+");
    await settle();
    expect(query().get("zoom")).not.toBeNull();

    expect(key(doc(), "l").defaultPrevented).toBe(true);
    await settle();
    expect(query().get("end")).toBeNull();
    expect(query().get("zoom")).toBeNull();
    expect(m.navs.at(-1)).toEqual(["/timeline", false]);
    expect(c.querySelector("[data-live]")!.textContent).toContain("Live");
    expect(button(c, "Pause")).toBeDefined();
  });

  test("REQ-A11Y-02 / REQ-RANGE-01: [ and ] step the range (push) and clamp at 1h and 7d", async () => {
    const m = await mountView();
    const c = m.container;
    const press = async (k: string): Promise<void> => {
      key(doc(), k);
      await settle();
    };
    expect(checkedRange(c)).toBe("24h");
    await press("]");
    expect(checkedRange(c)).toBe("7d");
    expect(query().get("range")).toBe("7d");
    await press("]"); // clamped: no wrap, no navigation
    expect(checkedRange(c)).toBe("7d");
    expect(m.navs.length).toBe(1);

    await press("[");
    expect(checkedRange(c)).toBe("24h");
    expect(query().get("range")).toBeNull(); // the default is omitted
    await press("[");
    expect(checkedRange(c)).toBe("6h");
    await press("[");
    expect(checkedRange(c)).toBe("1h");
    expect(query().get("range")).toBe("1h");
    await press("[");
    expect(checkedRange(c)).toBe("1h");
    expect(m.navs.length).toBe(4);
    expect(m.navs.every(([, replace]) => !replace)).toBe(true);
  });

  test("REQ-A11Y-02: no view shortcut fires while focus is in an <input>, and none fires after unmount", async () => {
    const m = await mountView();
    const input = doc().createElement("input");
    doc().body.appendChild(input);
    cleanups.push(() => input.remove());
    input.focus();
    for (const k of ["0", "l", "[", "]"]) expect(key(input, k).defaultPrevented).toBe(false);
    await settle();
    expect(m.navs).toEqual([]);
    expect(query().get("range")).toBeNull();
    expect(query().get("end")).toBeNull();

    // The same keys outside the input are handled while mounted …
    input.blur();
    input.remove();
    expect(key(doc(), "]").defaultPrevented).toBe(true);
    await settle();
    expect(m.navs.length).toBe(1);

    // … and every shortcut is removed on unmount.
    const navs = m.navs;
    dropMounted(m);
    for (const k of ["0", "l", "[", "]"]) expect(key(doc(), k).defaultPrevented).toBe(false);
    await settle();
    expect(navs.length).toBe(1);
  });

  test("REQ-A11Y-02 / REQ-KIOSK-03: with ?kiosk=1 no view shortcut is registered and no hints render", async () => {
    const m = await mountView("?kiosk=1");
    const c = m.container;
    for (const k of ["0", "l", "[", "]"]) expect(key(doc(), k).defaultPrevented).toBe(false);
    await settle();
    expect(m.navs).toEqual([]);
    expect(c.querySelector("[data-slot=timeline-kbd-hints]")).toBeNull();
    expect(c.querySelector("kbd")).toBeNull();
  });

  test("REQ-A11Y-02: TimelineKeyboardHints on the mounted desk page lists all 19 TIMELINE_KEY_BINDINGS rows with Kbd keycaps", async () => {
    const m = await mountView();
    const hints = m.container.querySelectorAll("details[data-slot=timeline-kbd-hints]");
    expect(hints.length).toBe(1);
    const rows = Array.from(hints[0]!.querySelectorAll("tbody tr"));
    expect(rows.length).toBe(19);
    rows.forEach((row, i) => {
      const hint = TIMELINE_KEY_BINDINGS[i]!;
      const caps = Array.from(row.querySelectorAll("kbd[data-slot=kbd]"));
      expect(caps.length).toBeGreaterThan(0);
      expect(caps.map((k) => k.textContent)).toEqual(hint.combos.flat());
      expect(row.querySelectorAll("td")[2]!.textContent).toBe(hint.action);
    });
  });

  // --- readout debounce (06 §7.3) --------------------------------------------------------------------

  test("REQ-A11Y-03: the #pulse-timeline-readout aria-live summary is unchanged 249 ms after the last cursor move and updated at 250 ms", async () => {
    const m = await mountView();
    const c = m.container;
    const summaryEl = c.querySelector<HTMLElement>("#pulse-timeline-readout")!;
    expect(summaryEl.getAttribute("aria-live")).toBe("polite");
    expect(summaryEl.getAttribute("role")).toBe("status");
    const summary = (): string => summaryEl.textContent ?? "";
    for (const ov of activeOverlays(c)) expect(ov.getAttribute("aria-describedby")).toBe("pulse-timeline-readout");

    jest.useFakeTimers();
    const o = laneOverlay(c);
    o.focus();
    key(o, "ArrowRight");
    await flush();
    jest.advanceTimersByTime(READOUT_ANNOUNCE_DEBOUNCE_MS);
    await flush();
    const first = summary();
    expect(first).toContain(at(D.start));

    // Two quick moves: the debounce restarts on the last one.
    key(o, "ArrowRight", { shiftKey: true });
    await flush();
    jest.advanceTimersByTime(100);
    await flush();
    key(o, "ArrowRight");
    await flush();
    jest.advanceTimersByTime(READOUT_ANNOUNCE_DEBOUNCE_MS - 1);
    await flush();
    expect(summary()).toBe(first);
    jest.advanceTimersByTime(1);
    await flush();
    expect(summary()).not.toBe(first);
    expect(summary()).toContain(at(D.start + (CURSOR_BIG_STEP + 1) * STEP_24H));
  });

  // --- lane tree (07 §5.2) ------------------------------------------------------------------------------

  test("REQ-A11Y-02 / REQ-CHART-01: lane tree ↑/↓/Home/End move focus, →/← expand/descend and ascend/collapse, Enter on a host pushes sel", async () => {
    const m = await mountView();
    const c = m.container;
    const row = (k: string): HTMLElement => c.querySelector<HTMLElement>(`[data-tree-row][data-lane-key="${k}"]`)!;
    const rowKeys = (): string[] => all(c, "[data-tree-row]").map((r) => r.getAttribute("data-lane-key") ?? "");
    const hostKeys = (): string[] =>
      all(c, '[data-tree-row][data-level="1"]').map((r) => r.getAttribute("data-lane-key") ?? "").filter((k) => k.startsWith("host:"));
    const focused = (): string | undefined => (c.ownerDocument.activeElement as HTMLElement | null)?.getAttribute("data-lane-key") ?? undefined;
    const press = async (k: string): Promise<KeyboardEvent> => {
      const e = key(row(focused()!), k);
      await settle();
      return e;
    };

    expect(c.querySelector('[role="tree"]')).not.toBeNull();
    const hosts = hostKeys();
    expect(hosts.length).toBe(SNAP.hosts.length);
    row(hosts[0]!).focus();
    expect(focused()).toBe(hosts[0]);

    await press("ArrowDown");
    expect(focused()).toBe(hosts[1]);
    await press("End");
    expect(focused()).toBe(rowKeys().at(-1));
    await press("Home");
    expect(focused()).toBe(rowKeys()[0]);
    await press("ArrowDown");
    await press("ArrowUp");
    expect(focused()).toBe(hosts[0]);
    expect(all(c, '[data-tree-row][tabindex="0"]').length).toBe(1);

    // → expands a collapsed host, then moves to its first child.
    const h0 = hosts[0]!;
    expect(row(h0).getAttribute("aria-expanded")).toBe("false");
    await press("ArrowRight");
    expect(row(h0).getAttribute("aria-expanded")).toBe("true");
    expect(focused()).toBe(h0);
    const children = all(c, '[data-tree-row][data-level="2"]').map((r) => r.getAttribute("data-lane-key") ?? undefined);
    expect(children.length).toBe(2);
    await press("ArrowRight");
    expect(focused()).toBe(children[0]);
    // ← moves to the parent, then collapses it.
    await press("ArrowLeft");
    expect(focused()).toBe(h0);
    await press("ArrowLeft");
    expect(row(h0).getAttribute("aria-expanded")).toBe("false");
    expect(all(c, '[data-tree-row][data-level="2"]').length).toBe(0);
    expect(m.navs).toEqual([]); // expansion is view state, never a URL write

    // Enter on a host selects it: sel written with push, the detail region mounts.
    const e = await press("Enter");
    expect(e.defaultPrevented).toBe(true);
    expect(query().get("sel")).toBe(h0);
    expect(m.navs.length).toBe(1);
    expect(m.navs[0]![1]).toBe(false);
    expect(row(h0).getAttribute("aria-selected")).toBe("true");
    expect(c.querySelector("[data-slot=timeline-detail]")).not.toBeNull();
  });

  // --- swimlane tracks (07 §7.5) --------------------------------------------------------------------------

  test("REQ-SWIM-04 / REQ-A11Y-02: swimlane →/←/Home/End move the page cursor without pinning; Enter navigates to /alerts?hs= or ?sev=", async () => {
    const m = await mountView();
    const c = m.container;
    const track = (sev: string): HTMLElement => c.querySelector<HTMLElement>(`[data-swim-track][data-severity="${sev}"]`)!;
    const start = (i: number): number => TIMELINE_NOW_S - 9_000 + i * 300;
    const crit = track("critical");
    crit.focus();

    const moves: readonly (readonly [string, number])[] = [["ArrowRight", 1], ["End", 5], ["ArrowLeft", 4], ["Home", 0]];
    for (const [k, i] of moves) {
      const e = key(track("critical"), k);
      await flush();
      expect(e.defaultPrevented).toBe(true);
      expect(readoutTime(c)).toBe(at(start(i)));
    }
    expect(readoutTime(c)).not.toContain("(pinned)");
    for (const ov of activeOverlays(c)) expect(cursorFraction(ov)).toBeCloseTo((start(0) - D.start) / DAY, 6);
    await settle();
    expect(m.navs).toEqual([]); // no pin, no URL write
    expect(query().get("end")).toBeNull();

    expect(key(track("critical"), "Enter").defaultPrevented).toBe(true);
    expect(m.navs.at(-1)).toEqual([`/alerts?hs=${encodeURIComponent(HOST0_SEL)}`, false]);
    await settle();

    // Warning row: the earliest interval (DomainExpiring) has no target → ?sev=.
    key(track("warning"), "Home");
    key(track("warning"), "Enter");
    expect(m.navs.at(-1)).toEqual(["/alerts?sev=warning", false]);
  });

  test("REQ-SWIM-04 / REQ-SEC-04: a swimlane target id with &, / and # is percent-encoded inside one hs value", async () => {
    const hostileId = "host:a&x=1/b#c";
    const alerts = makeAlertHistory("24h", [
      ...TIMELINE_INCIDENT.alerts.lanes,
      makeAlertLane({ alertname: "Odd", severity: "critical", target: { kind: "host", id: hostileId }, intervals: [[-600, -300]] }),
    ]);
    const m = await mountView("", alerts);
    const crit = m.container.querySelector<HTMLElement>('[data-swim-track][data-severity="critical"]')!;
    crit.focus();
    key(crit, "End");
    await flush();
    key(crit, "Enter");
    const href = m.navs.at(-1)![0];
    expect(href).toBe("/alerts?hs=host%3Ahost%3Aa%26x%3D1%2Fb%23c");
    const params = new URLSearchParams(href.slice(href.indexOf("?")));
    expect([...params.keys()]).toEqual(["hs"]);
    expect(params.get("hs")).toBe(`host:${hostileId}`);
  });
});
