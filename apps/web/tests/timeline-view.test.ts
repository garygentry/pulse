// apps/web/tests/timeline-view.test.ts — /timeline DOM cases (08 §4.2). Item 013 seeds it with the
// 06 §9 SyncedChart `.u-over` rows, the SyncedChart states and the CursorReadout/registry cases;
// items 018–022 append component and full-view cases.
//
// The lazy chart is stubbed per 08 §4.1: one shared StubChart, one top-level mock.module, the real
// module re-mocked in afterAll and resetChartStub in afterEach. happy-dom's getBoundingClientRect
// returns zeros, so the geometry of [data-slot=timeseries-plot] / .u-over / [data-slot=plot-overlay] is stubbed per
// class name. rAF runs on microtasks for this file and flushes run inside act().

import { afterAll, afterEach, beforeAll, beforeEach, expect, jest, mock, setSystemTime, spyOn, test } from "bun:test";
import { createElement } from "react";
import type { ReactElement } from "react";
import { signal } from "@preact/signals-core";

import type { HistoryPayload } from "@pulse/web-data/wire";
import { createAppStore } from "../src/client/store/index.js";
import type { AppStore } from "../src/client/store/index.js";
import { createEstateClock, TZ_FALLBACK_MARKER } from "../src/client/format.js";
import type { EstateClock } from "../src/client/format.js";
import { createTimeAxis } from "../src/client/views/_shared/timeseries/axis.js";
import type { TimeAxisController, TimeWindow } from "../src/client/views/_shared/timeseries/axis.js";
import { UOVER_GRACE_MS, SyncedChart } from "../src/client/views/_shared/timeseries/chart.js";
import type { ChartReadoutMode } from "../src/client/views/_shared/timeseries/chart.js";
import { CursorReadout, createReadoutRegistry } from "../src/client/views/_shared/timeseries/readout.js";
import {
  READOUT_ANNOUNCE_DEBOUNCE_MS,
  buildReadoutSummary,
  createChartReadoutSource,
  createLaneReadoutSource,
  formatCursorTime,
  isChartReadout,
} from "../src/client/views/_shared/timeseries/readout-model.js";
import type { ReadoutSource } from "../src/client/views/_shared/timeseries/readout-model.js";
import { CHECK_HISTORY_UNAVAILABLE_TEXT } from "../src/client/views/timeline/evidence.js";
import type { LaneEvidenceResult } from "../src/client/views/timeline/evidence.js";
import { toChartData } from "../src/client/views/_shared/timeseries/chart-data.js";
import {
  KioskStatusLine,
  LiveControl,
  ResetZoom,
  StepLabel,
  TimelineControls,
  UrlNotices,
  ZoneLabel,
} from "../src/client/views/timeline/controls.js";
import type { UrlFallbackNotice } from "../src/client/views/timeline/url-state.js";
import { formatStepLabel } from "../src/client/views/_shared/timeseries/axis.js";
import { isolateDomGlobals } from "./alerts-dom-isolation.js";
import { describeDom, restoreRealTimers } from "./dom.js";
import { StubChart, resetChartStub, setChartStubVariant } from "./chart-stub.js";
import { TimeSeriesChart } from "../src/client/ui/viz/time-series-chart.js";
import { TIMELINE_NOW_S, makeAlertLane, makeHierarchySnapshot, makeSeriesHistory, makeTimelineIndex } from "./timeline-fixtures.js";
import { buttonNamed, checkedRange, noticesBox, pageHeadings, rangeGroup } from "./timeline-queries.js";
import { describe } from "bun:test";
import { StatusTimeline, timelineHeight, timelineSegmentRect } from "../src/client/ui/viz/status-timeline.js";
import { LaneDecorations } from "../src/client/views/timeline/decorations.js";
import type { DecorationMark } from "../src/client/views/timeline/decorations.js";
import { LaneEvidenceStatus, LaneTree } from "../src/client/views/timeline/lanes.js";
import {
  AXIS_LABEL_MIN_PX,
  DEFAULT_ROW_PX,
  LANE_GAP_PX,
  LANE_READOUT_ORDER,
  MIN_PLOT_WIDTH_PX,
  buildLaneBlocks,
  computeAxisTicks,
  laneEvidence,
  regionData,
  worstInView,
} from "../src/client/views/timeline/lanes-model.js";
import type { EvidenceSource, LaneBlock, LaneEvidenceContext, LaneRow } from "../src/client/views/timeline/lanes-model.js";
import { buildLaneTree, targetKey } from "../src/client/views/timeline/model.js";
import type { LaneNode, TargetKey } from "../src/client/views/timeline/model.js";
import { createLaneEvidenceCache } from "../src/client/views/timeline/evidence.js";
import type { LaneSegment } from "../src/client/views/timeline/evidence.js";
import { classifyFailure } from "../src/client/views/_shared/timeseries/history/client.js";
import type { HistoryRegionState } from "../src/client/views/_shared/timeseries/history/client.js";
import { REGION_TEXT } from "../src/client/views/_shared/timeseries/history/region.js";
import type { AlertHistoryLane, EndpointHistoryPayload, TimelineDomain } from "@pulse/web-data/wire";
import type { IntervalHistoryPayload } from "@pulse/web-data/wire";
import { AlertSwimlane } from "../src/client/views/timeline/swimlane.js";
import {
  SWIMLANE_READOUT_ORDER,
  SWIM_ROW_TEXT,
  swimIntervalHref,
  swimIntervalText,
} from "../src/client/views/timeline/swimlane-model.js";
import { SWIM_ROW_STATUS } from "../src/client/status/target-status.js";
import type { SwimInterval } from "../src/client/views/timeline/swimlane-pack.js";
import { TIMELINE_INCIDENT, makeAlertHistory, makeEndpointHistory } from "./timeline-fixtures.js";
import { TargetDetail } from "../src/client/views/timeline/detail.js";
import {
  CHART_READOUT_ORDER,
  CHECK_LATENCY_UNAVAILABLE,
  HOST_CHART_TITLE,
  estateHref,
  notAvailableAtRange,
  safeGrafanaHref,
} from "../src/client/views/timeline/detail-model.js";
import { HOST_CHART_QUERIES } from "../src/client/views/_shared/timeseries/query-meta.js";
import { createRequestQueue } from "../src/client/views/_shared/timeseries/history/client.js";
import { installHistoryStub } from "./timeline-fixtures.js";
import type { StubRoute } from "./timeline-fixtures.js";
import { TIMELINE_ENVELOPE, envelope } from "./timeline-fixtures.js";
import type { OverviewSnapshotV2, TimelinePayload } from "@pulse/web-data/wire";
import { createPathRouter } from "../src/client/router.js";
import type { PathRouter } from "../src/client/router.js";
import type { ViewRotationContext } from "../src/shared/registry.js";
import { LIVE_REFRESH_MS } from "../src/client/views/_shared/timeseries/history/client.js";
import { realGlobal } from "./alerts-dom-isolation.js";
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

const HOUR = 3600;
const DOMAIN: TimeWindow = { start: TIMELINE_NOW_S - HOUR, end: TIMELINE_NOW_S };
const CLOCK: EstateClock = createEstateClock({ name: "", timezone: "America/Chicago", tzFallback: false });
const FALLBACK_CLOCK: EstateClock = createEstateClock({ name: "", timezone: "", tzFallback: true });

/** Geometry per class name (px): plot box, uPlot's .u-over inside it, and any overlay root. */
const PLOT_RECT = { left: 100, top: 50, width: 600, height: 260 };
const UOVER_RECT = { left: 140, top: 60, width: 540, height: 200 };
const OVERLAY_RECT = { left: 0, top: 0, width: 600, height: 200 };

function domRect(r: { left: number; top: number; width: number; height: number }): DOMRect {
  return {
    ...r,
    x: r.left,
    y: r.top,
    right: r.left + r.width,
    bottom: r.top + r.height,
    toJSON: () => r,
  } as DOMRect;
}

async function flush(rounds = 60): Promise<void> {
  // React runs non-urgent updates on a scheduler task; act() flushes them with the microtasks.
  await act(async () => {
    for (let i = 0; i < rounds; i++) await Promise.resolve();
  });
}

/** Real-timer settle: microtasks plus one macrotask (lazy import resolution, MutationObserver). */
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

function newAxis(): TimeAxisController {
  return createTimeAxis({ domain: signal(DOMAIN), initialZoom: null, initialStepSeconds: 60 });
}

function chartVNode(p: {
  axis: TimeAxisController;
  payload: HistoryPayload | null;
  clock?: EstateClock;
  interactive?: boolean;
  readout?: ChartReadoutMode;
}): ReactElement {
  return el(SyncedChart, {
    chartId: "host:web01|host.cpu.utilization",
    title: "CPU utilization",
    unit: "percent",
    range: "1h",
    payload: p.payload,
    axis: p.axis,
    clock: p.clock ?? CLOCK,
    interactive: p.interactive ?? true,
    readout: p.readout ?? { mode: "local" },
  });
}

function laneResult(segments: LaneEvidenceResult["segments"], partial: LaneEvidenceResult["partial"] = null): LaneEvidenceResult {
  return { segments, partial, coverageSince: null };
}

describeDom("timeline view — SyncedChart and CursorReadout (item 013)", (dom) => {
  let savedGlobalRaf: PropertyDescriptor | undefined;
  let rectSpy: { mockRestore(): void } | null = null;
  const mounted: { unmount(): void }[] = [];

  beforeAll(() => {
    const g = globalThis as unknown as { requestAnimationFrame?: unknown };
    savedGlobalRaf = Object.getOwnPropertyDescriptor(g, "requestAnimationFrame");
    g.requestAnimationFrame = (cb: (t: number) => void): number => {
      queueMicrotask(() => cb(0));
      return 0;
    };
    const proto = (dom.win as unknown as { HTMLElement: { prototype: HTMLElement } }).HTMLElement.prototype;
    rectSpy = spyOn(proto, "getBoundingClientRect").mockImplementation(function (this: HTMLElement): DOMRect {
      const cls = this.classList;
      if (this.dataset["slot"] === "timeseries-plot") return domRect(PLOT_RECT);
      if (cls.contains("u-over")) return domRect(UOVER_RECT);
      if (this.dataset["slot"] === "plot-overlay") return domRect(OVERLAY_RECT);
      return domRect({ left: 0, top: 0, width: 0, height: 0 });
    });
  });

  afterEach(() => {
    while (mounted.length > 0) mounted.pop()!.unmount();
    restoreRealTimers();
  });

  afterAll(() => {
    const g = globalThis as unknown as { requestAnimationFrame?: unknown };
    if (savedGlobalRaf === undefined) delete g.requestAnimationFrame;
    else Object.defineProperty(g, "requestAnimationFrame", savedGlobalRaf);
    rectSpy?.mockRestore();
  });

  async function mount(vnode: ReactElement): Promise<HTMLElement> {
    const m = await dom.mount(vnode);
    mounted.push(m);
    return m.container;
  }

  // Resolve the chart's React.lazy once, so every test below renders it synchronously. Otherwise
  // the first test races its first measure frame against the lazy reveal, whose MutationObserver
  // record happy-dom does not deliver here.
  beforeAll(async () => {
    const warm = await dom.mount(el(TimeSeriesChart, { timestamps: [1], series: [{ label: "warm", data: [1] }] }));
    for (let i = 0; i < 50 && warm.container.querySelector('[data-slot="time-series-chart"][data-state="loading"]') !== null; i++) await settle();
    warm.unmount();
  });

  // --- 06 §9 .u-over rows ------------------------------------------------------------------------

  test("REQ-CHART-03: with the u-over stub the chart reaches data-overlay-state=measured and the overlay sits on the .u-over rect", async () => {
    setChartStubVariant("u-over");
    const axis = newAxis();
    const c = await mount(chartVNode({ axis, payload: makeSeriesHistory("host.cpu.utilization", "1h") }));
    const plot = c.querySelector("[data-slot=timeseries-plot]")!;
    // The lazy chart chunk's first load in a process can take a few macrotasks on a busy host.
    for (let i = 0; i < 50 && plot.getAttribute("data-overlay-state") !== "measured"; i++) await settle();
    expect(plot.getAttribute("data-overlay-state")).toBe("measured");
    expect(plot.querySelector("[data-slot=time-series-chart] .uplot .u-wrap .u-over")).not.toBeNull();
    const overlay = plot.querySelector<HTMLElement>("[data-slot=plot-overlay]")!;
    expect(overlay.getAttribute("data-state")).toBe("active");
    expect(overlay.style.left).toBe(`${UOVER_RECT.left - PLOT_RECT.left}px`);
    expect(overlay.style.top).toBe(`${UOVER_RECT.top - PLOT_RECT.top}px`);
    expect(overlay.style.width).toBe(`${UOVER_RECT.width}px`);
    expect(overlay.style.height).toBe(`${UOVER_RECT.height}px`);
    // The overlay is the last child of the positioned plot (stacks above .u-over, 06 §5.2).
    expect(plot.lastElementChild).toBe(overlay);
    axis.dispose();
  });

  test("REQ-OBS-01: with the no-u-over stub the chart reaches missing-u-over after UOVER_GRACE_MS with exactly one console.error", async () => {
    setChartStubVariant("no-u-over");
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      jest.useFakeTimers();
      const axis = newAxis();
      const c = await mount(chartVNode({ axis, payload: makeSeriesHistory("host.cpu.utilization", "1h") }));
      await flush();
      await flush();
      const plot = c.querySelector("[data-slot=timeseries-plot]")!;
      expect(plot.querySelector("[data-slot=time-series-chart]")).not.toBeNull();
      expect(plot.querySelector(".u-over")).toBeNull();
      expect(plot.getAttribute("data-overlay-state")).toBe("pending");
      jest.advanceTimersByTime(UOVER_GRACE_MS - 1);
      await flush();
      expect(plot.getAttribute("data-overlay-state")).toBe("pending");
      jest.advanceTimersByTime(1);
      await flush();
      expect(plot.getAttribute("data-overlay-state")).toBe("missing-u-over");
      // Still inert (a passive shield) and the chart still renders.
      expect(plot.querySelector("[data-slot=plot-overlay]")!.getAttribute("data-state")).toBe("inert");
      jest.advanceTimersByTime(UOVER_GRACE_MS * 3);
      await flush();
      const uOverErrors = errSpy.mock.calls.filter((args) => String(args[0]).includes(".u-over not found"));
      expect(uOverErrors.length).toBe(1);
      expect(errSpy).toHaveBeenCalledTimes(1);
      axis.dispose();
    } finally {
      errSpy.mockRestore();
    }
  });

  // --- 06 §6.6 states ----------------------------------------------------------------------------

  test("REQ-PERF-03: payload null renders the loading Skeleton and mounts the lazy chart (chunk prefetch)", async () => {
    const axis = newAxis();
    const c = await mount(chartVNode({ axis, payload: null }));
    await settle();
    const plot = c.querySelector("[data-slot=timeseries-plot]")!;
    expect(plot.querySelector("[data-slot=timeseries-plot-loading] [data-slot=skeleton]")).not.toBeNull();
    expect(plot.querySelector("[data-slot=time-series-chart]")).not.toBeNull();
    expect(plot.querySelector("[data-slot=plot-overlay]")).toBeNull();
    expect(plot.getAttribute("data-overlay-state")).toBe("empty");
    axis.dispose();
  });

  test("REQ-KIOSK-03: interactive=false gives an overlay with no tabindex or role, aria-hidden=true and no readout", async () => {
    const axis = newAxis();
    const c = await mount(chartVNode({ axis, payload: makeSeriesHistory("host.cpu.utilization", "1h"), interactive: false }));
    await settle();
    const overlay = c.querySelector("[data-slot=plot-overlay]")!;
    expect(overlay.getAttribute("data-state")).toBe("inert");
    expect(overlay.hasAttribute("tabindex")).toBe(false);
    expect(overlay.hasAttribute("role")).toBe(false);
    expect(overlay.hasAttribute("aria-label")).toBe(false);
    expect(overlay.hasAttribute("aria-keyshortcuts")).toBe(false);
    expect(overlay.getAttribute("aria-hidden")).toBe("true");
    expect(c.querySelector("[data-slot=cursor-readout]")).toBeNull();
    axis.dispose();
  });

  test("REQ-FOLLOW-03: a zero-series payload renders the 'No data' EmptyState and no overlay", async () => {
    const axis = newAxis();
    const c = await mount(chartVNode({ axis, payload: makeSeriesHistory("host.cpu.utilization", "1h", { series: 0 }) }));
    await settle();
    const empty = c.querySelector("[data-slot=synced-chart] [data-slot=empty-state]")!;
    expect(empty.textContent).toContain("No data");
    expect(empty.textContent).toContain("No series returned for this range.");
    expect(c.querySelector("[data-slot=plot-overlay]")).toBeNull();
    expect(c.querySelector("[data-slot=timeseries-plot]")!.getAttribute("data-overlay-state")).toBe("empty");
    axis.dispose();
  });

  test("REQ-CAP-02 / REQ-RANGE-03: the caption shows range, unit label, resolution and 'Times in {zone}'", async () => {
    const axis = newAxis();
    const c = await mount(chartVNode({ axis, payload: makeSeriesHistory("host.cpu.utilization", "1h") }));
    await settle();
    const caption = c.querySelector("figcaption")!.textContent ?? "";
    expect(caption).toContain("CPU utilization");
    expect(caption).toContain("1h · %");
    expect(caption).toContain("resolution: 60 s");
    expect(caption).toContain("Times in America/Chicago");
    expect(caption).not.toContain(TZ_FALLBACK_MARKER);
    expect(c.querySelector("figure")!.getAttribute("data-chart-id")).toBe("host:web01|host.cpu.utilization");
    axis.dispose();
  });

  test("REQ-RANGE-03: the caption adds TZ_FALLBACK_MARKER when the clock is on the UTC fallback", async () => {
    const axis = newAxis();
    const c = await mount(chartVNode({ axis, payload: makeSeriesHistory("host.cpu.utilization", "1h"), clock: FALLBACK_CLOCK }));
    await settle();
    const caption = c.querySelector("figcaption")!.textContent ?? "";
    expect(caption).toContain("Times in UTC");
    expect(caption).toContain(TZ_FALLBACK_MARKER);
    axis.dispose();
  });

  test("REQ-ZOOM-03: a view with no samples in it keeps the chart and adds 'No data in this window'", async () => {
    const axis = newAxis();
    const gapped = makeSeriesHistory("host.cpu.utilization", "1h", { gaps: [[-HOUR - 60, 60]] });
    const c = await mount(chartVNode({ axis, payload: gapped }));
    await settle();
    expect([...c.querySelectorAll("[data-slot=synced-chart] > p")].map((p) => p.textContent)).toEqual(["No data in this window"]);
    expect(c.querySelector("[data-slot=plot-overlay]")).not.toBeNull();
    axis.dispose();
  });

  test("REQ-ZOOM-02: local mode passes zoomable=false (keyboard + is not handled); page mode zooms", async () => {
    const payload = makeSeriesHistory("host.cpu.utilization", "1h");
    const local = newAxis();
    const c1 = await mount(chartVNode({ axis: local, payload }));
    await settle();
    const o1 = c1.querySelector<HTMLElement>("[data-slot=plot-overlay]")!;
    const e1 = new dom.win.KeyboardEvent("keydown", { key: "+", bubbles: true, cancelable: true });
    o1.dispatchEvent(e1 as unknown as Event);
    expect(e1.defaultPrevented).toBe(false);
    expect(local.zoom.value).toBeNull();

    const page = newAxis();
    const registry = createReadoutRegistry();
    const c2 = await mount(chartVNode({ axis: page, payload, readout: { mode: "page", registry, summaryId: "pulse-timeline-readout" } }));
    await settle();
    const o2 = c2.querySelector<HTMLElement>("[data-slot=plot-overlay]")!;
    expect(o2.getAttribute("aria-describedby")).toBe("pulse-timeline-readout");
    const e2 = new dom.win.KeyboardEvent("keydown", { key: "+", bubbles: true, cancelable: true });
    o2.dispatchEvent(e2 as unknown as Event);
    expect(e2.defaultPrevented).toBe(true);
    expect(page.zoom.value).not.toBeNull();
    local.dispose();
    page.dispose();
  });

  test("REQ-CHART-03: page mode registers the chart with the page registry and unregisters on unmount", async () => {
    const axis = newAxis();
    const registry = createReadoutRegistry();
    const m = await dom.mount(
      chartVNode({ axis, payload: makeSeriesHistory("host.cpu.utilization", "1h"), readout: { mode: "page", registry, summaryId: "s", order: 1000 } }),
    );
    await settle();
    const r = registry.read(DOMAIN.start + 600);
    expect(r.charts.length).toBe(1);
    expect(r.charts[0]!.title).toBe("CPU utilization");
    expect(r.charts[0]!.values[0]!.text).toMatch(/%$/);
    m.unmount();
    expect(registry.read(DOMAIN.start + 600).charts.length).toBe(0);
    axis.dispose();
  });

  test("REQ-ZOOM-01: local mode renders an inline CursorReadout whose summary id the overlay references", async () => {
    const axis = newAxis();
    const c = await mount(chartVNode({ axis, payload: makeSeriesHistory("host.cpu.utilization", "1h") }));
    await settle();
    const readout = c.querySelector("[data-slot=cursor-readout][data-variant=inline]")!;
    const status = readout.querySelector('[role="status"]')!;
    expect(status.id).not.toBe("");
    expect(c.querySelector("[data-slot=plot-overlay]")!.getAttribute("aria-describedby")).toBe(status.id);
    axis.cursor.value = DOMAIN.start + 600;
    await settle();
    expect(readout.querySelector("[data-slot=cursor-readout-charts]")!.textContent).toContain("CPU utilization:");
    axis.dispose();
  });

  // --- CursorReadout and registry (06 §7) ----------------------------------------------------------

  const T = DOMAIN.start + 1800;
  const LANE_SEGMENTS: LaneEvidenceResult["segments"] = [
    { start: DOMAIN.start, end: T - 60, status: "ok", cause: "ok", alertnames: [] },
    { start: T - 60, end: T + 60, status: "critical", cause: "alert", alertnames: ["HostDown"] },
    { start: T + 60, end: DOMAIN.end, status: "ok", cause: "ok", alertnames: [] },
  ];
  const NO_DATA_SEGMENTS: LaneEvidenceResult["segments"] = [
    { start: DOMAIN.start, end: DOMAIN.end, status: "unknown", cause: "no-data", alertnames: [] },
  ];

  function pageSources(): { registry: ReturnType<typeof createReadoutRegistry> } {
    const registry = createReadoutRegistry();
    registry.register(
      createLaneReadoutSource(
        "hosts",
        () => [
          { label: "web01", result: laneResult(LANE_SEGMENTS) },
          { label: "db01", result: laneResult(NO_DATA_SEGMENTS) },
          { label: "nas01", result: laneResult([{ start: DOMAIN.start, end: DOMAIN.end, status: "ok", cause: "ok", alertnames: [] }]) },
        ],
        CLOCK,
      ),
      0,
    );
    const gapped = makeSeriesHistory("host.cpu.utilization", "1h", { gaps: [[-HOUR - 60, 60]] });
    const data = toChartData(gapped, DOMAIN, CLOCK.timezone);
    registry.register(createChartReadoutSource("chart", "CPU utilization", "percent", () => data), 1000);
    return { registry };
  }

  test("REQ-A11Y-03: the aria-live summary appears only after READOUT_ANNOUNCE_DEBOUNCE_MS, in estate time with the zone, with 'no data'/'no value' in words", async () => {
    expect(READOUT_ANNOUNCE_DEBOUNCE_MS).toBe(250);
    jest.useFakeTimers();
    const axis = newAxis();
    const { registry } = pageSources();
    const c = await mount(el(CursorReadout, { axis, registry, clock: CLOCK, summaryId: "pulse-timeline-readout" }));
    await flush();
    const summary = c.querySelector("#pulse-timeline-readout")!;
    expect(summary.getAttribute("role")).toBe("status");
    expect(summary.getAttribute("aria-live")).toBe("polite");
    expect(c.querySelector("[data-slot=cursor-readout-time]")!.textContent).toContain("Point at the timeline");

    axis.cursor.value = T;
    await flush();
    // The visible panel updates within the frame …
    const time = c.querySelector("[data-slot=cursor-readout-time]")!.textContent ?? "";
    expect(time).toBe(formatCursorTime(T, CLOCK));
    expect(time).toMatch(/ CDT$/);
    const lanes = [...c.querySelectorAll("[data-slot=cursor-readout-lanes] li")].map((li) => li.textContent);
    expect(lanes).toEqual(["web01: critical", "db01: no data"]);
    expect(c.querySelector('[data-slot=cursor-readout-lanes] li[data-status="critical"]')).not.toBeNull();
    expect(c.querySelector("[data-slot=cursor-readout-charts]")!.textContent).toContain("no value");
    expect(c.querySelector("[data-slot=cursor-readout-ok]")!.textContent).toBe("1 lanes OK");
    // … the spoken summary only after 250 ms of rest (trailing edge).
    expect(summary.textContent).toBe("");
    jest.advanceTimersByTime(READOUT_ANNOUNCE_DEBOUNCE_MS - 1);
    await flush();
    expect(summary.textContent).toBe("");
    jest.advanceTimersByTime(1);
    await flush();
    const text = summary.textContent ?? "";
    expect(text).toContain(`Cursor ${formatCursorTime(T, CLOCK)}.`);
    expect(text).toContain("CDT");
    expect(text).toContain("CPU utilization: no value");
    expect(text).toContain("1 critical: web01.");
    expect(text).toContain("1 no data: db01.");
    expect(text).toContain("1 lanes OK.");

    // A later move restarts the timer: unchanged at 249 ms, updated at 250 ms.
    axis.cursor.value = DOMAIN.start + 60;
    await flush();
    jest.advanceTimersByTime(READOUT_ANNOUNCE_DEBOUNCE_MS - 1);
    await flush();
    expect(summary.textContent).toBe(text);
    jest.advanceTimersByTime(1);
    await flush();
    expect(summary.textContent).not.toBe(text);
    expect(summary.textContent).not.toContain("critical");
    axis.dispose();
  });

  test("REQ-ZOOM-01: a null cursor shows the hint, cancels the pending summary and keeps the last announced text", async () => {
    jest.useFakeTimers();
    const axis = newAxis();
    const { registry } = pageSources();
    const c = await mount(el(CursorReadout, { axis, registry, clock: CLOCK, summaryId: "sum-null" }));
    axis.cursor.value = T;
    await flush();
    jest.advanceTimersByTime(READOUT_ANNOUNCE_DEBOUNCE_MS);
    await flush();
    const summary = c.querySelector("#sum-null")!;
    const announced = summary.textContent;
    expect(announced).not.toBe("");
    axis.cursor.value = DOMAIN.start;
    await flush();
    axis.cursor.value = null;
    await flush();
    jest.advanceTimersByTime(READOUT_ANNOUNCE_DEBOUNCE_MS * 2);
    await flush();
    expect(c.querySelector("[data-slot=cursor-readout-time]")!.textContent).toContain("Point at the timeline");
    expect(summary.textContent).toBe(announced);
    axis.dispose();
  });

  test("REQ-ZOOM-01: registering the same id replaces the old source and the old unregister becomes a no-op", () => {
    const registry = createReadoutRegistry();
    const a: ReadoutSource = { id: "x", read: () => [{ label: "A", status: "ok", text: "OK", partial: null }] };
    const b: ReadoutSource = { id: "x", read: () => [{ label: "B", status: "warning", text: "Warning", partial: null }] };
    const v0 = registry.version.peek();
    const offA = registry.register(a);
    registry.register(b);
    expect(registry.version.peek()).toBe(v0 + 2);
    expect(registry.read(0).lanes.map((l) => l.label)).toEqual(["B"]);
    offA();
    expect(registry.read(0).lanes.map((l) => l.label)).toEqual(["B"]);
    expect(registry.version.peek()).toBe(v0 + 2);
    registry.unregister("x");
    expect(registry.read(0).lanes).toEqual([]);
    registry.unregister("x"); // absent: no-op
    expect(registry.version.peek()).toBe(v0 + 3);
  });

  test("REQ-ZOOM-01: sources read in ascending order, ties in registration order; invalidate bumps the version", () => {
    const registry = createReadoutRegistry();
    const src = (id: string): ReadoutSource => ({ id, read: () => [{ label: id, status: "ok", text: "OK", partial: null }] });
    registry.register(src("late"));
    registry.register(src("b"), 5);
    registry.register(src("a"), 0);
    registry.register(src("c"), 5);
    expect(registry.read(0).lanes.map((l) => l.label)).toEqual(["a", "b", "c", "late"]);
    const v = registry.version.peek();
    registry.invalidate();
    expect(registry.version.peek()).toBe(v + 1);
  });

  test("REQ-A11Y-03: a throwing source is skipped with a single console.error while other sources still read", () => {
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const registry = createReadoutRegistry();
      registry.register({ id: "boom", read: () => { throw new Error("bad source"); } }, 0);
      registry.register({ id: "ok", read: () => [{ title: "Chart", values: [{ label: "value", text: "1.0 %" }] }] }, 1);
      expect(registry.read(1).charts.map((c) => c.title)).toEqual(["Chart"]);
      expect(registry.read(2).charts.length).toBe(1);
      expect(errSpy).toHaveBeenCalledTimes(1);
    } finally {
      errSpy.mockRestore();
    }
  });

  test("REQ-ZOOM-01: lane and chart source factories read status words, partial reasons and formatted values", () => {
    const lane = createLaneReadoutSource(
      "g",
      () => [
        { label: "web01", result: laneResult(LANE_SEGMENTS, "loading") },
        { label: "gap", result: laneResult([]) },
      ],
      CLOCK,
    );
    const out = lane.read(T);
    expect(out).toEqual([
      { label: "web01", status: "critical", text: "critical", partial: "loading" },
      { label: "gap", status: "unknown", text: "no data", partial: null },
    ]);
    const data = toChartData(makeSeriesHistory("host.cpu.utilization", "1h"), DOMAIN, CLOCK.timezone);
    const chart = createChartReadoutSource("c", "CPU utilization", "percent", () => data);
    const [entry] = chart.read(DOMAIN.start + 600);
    expect(entry !== undefined && isChartReadout(entry)).toBe(true);
    expect(createChartReadoutSource("c", "t", "percent", () => null).read(0)).toEqual([]);
  });

  test("REQ-A11Y-03: buildReadoutSummary caps names at 10 with 'and N more' and handles no sources", () => {
    const lanes = Array.from({ length: 12 }, (_, i) => ({ label: `h${i}`, status: "critical" as const, text: "Critical", partial: null }));
    const s = buildReadoutSummary("12:00", { lanes, charts: [] }, true);
    expect(s).toBe("Cursor 12:00, pinned. 12 critical: h0, h1, h2, h3, h4, h5, h6, h7, h8, h9, and 2 more. 0 lanes OK.");
    expect(buildReadoutSummary("12:00", { lanes: [], charts: [] }, false)).toBe("Cursor 12:00. Nothing to read at this time.");
    expect(formatCursorTime(T, FALLBACK_CLOCK)).toContain(`(${TZ_FALLBACK_MARKER})`);
  });

  test("REQ-A11Y-03: buildReadoutSummary speaks a lane's group override (firing info / unknown-severity swimlane rows), not 'no data'", () => {
    const info = { label: "Info alerts", status: "unknown" as const, text: "BackupCompleted", partial: null, group: "info" };
    const unk = { label: "Unknown severity alerts", status: "unknown" as const, text: "UnlabelledAlert", partial: null, group: "unknown severity" };
    const noData = { label: "web01", status: "unknown" as const, text: "no data", partial: null };
    expect(buildReadoutSummary("12:00", { lanes: [info], charts: [] }, false)).toBe("Cursor 12:00. 1 info: Info alerts. 0 lanes OK.");
    expect(buildReadoutSummary("12:00", { lanes: [unk], charts: [] }, false)).toBe(
      "Cursor 12:00. 1 unknown severity: Unknown severity alerts. 0 lanes OK.",
    );
    expect(buildReadoutSummary("12:00", { lanes: [noData], charts: [] }, false)).toBe("Cursor 12:00. 1 no data: web01. 0 lanes OK.");
    // Order: critical, warning, info, unknown severity, no data, suppressed; OK lanes are counted.
    const crit = { label: "db01", status: "critical" as const, text: "critical", partial: null };
    const warn = { label: "Warning alerts", status: "warning" as const, text: "DiskFilling", partial: null };
    const supp = { label: "app01", status: "suppressed" as const, text: "suppressed", partial: null };
    const ok = { label: "Critical alerts", status: "ok" as const, text: "none firing", partial: null };
    expect(buildReadoutSummary("12:00", { lanes: [supp, noData, unk, info, ok, warn, crit], charts: [] }, false)).toBe(
      "Cursor 12:00. 1 critical: db01. 1 warning: Warning alerts. 1 info: Info alerts. 1 unknown severity: Unknown severity alerts. " +
        "1 no data: web01. 1 suppressed: app01. 1 lanes OK.",
    );
  });

  test("REQ-A11Y-03: the compact panel lists group-override rows in summary group order with their group", async () => {
    const axis = newAxis();
    const registry = createReadoutRegistry();
    registry.register({
      id: "mixed",
      read: () => [
        { label: "web01", status: "unknown", text: "no data", partial: null },
        { label: "Unknown severity alerts", status: "unknown", text: "UnlabelledAlert", partial: null, group: "unknown severity" },
        { label: "Info alerts", status: "unknown", text: "BackupCompleted", partial: null, group: "info" },
        { label: "Critical alerts", status: "ok", text: "none firing", partial: null },
      ],
    });
    const c = await mount(el(CursorReadout, { axis, registry, clock: CLOCK, summaryId: "sum-group" }));
    axis.cursor.value = T;
    await settle();
    const rows = Array.from(c.querySelectorAll("[data-slot=cursor-readout-lanes] li"));
    expect(rows.map((li) => `${li.getAttribute("data-group")}|${li.textContent}`).join("\n")).toBe(
      ["info|Info alerts: BackupCompleted", "unknown severity|Unknown severity alerts: UnlabelledAlert", "no data|web01: no data"].join("\n"),
    );
    expect(c.querySelector("[data-slot=cursor-readout-ok]")!.textContent).toBe("1 lanes OK");
    axis.dispose();
  });

  test("REQ-SEC-02: lane labels containing markup render literally as text", async () => {
    const axis = newAxis();
    const registry = createReadoutRegistry();
    registry.register(createLaneReadoutSource("g", () => [{ label: "<b>x</b>", result: laneResult(LANE_SEGMENTS) }], CLOCK));
    const c = await mount(el(CursorReadout, { axis, registry, clock: CLOCK, summaryId: "sum-sec" }));
    axis.cursor.value = T;
    await settle();
    const li = c.querySelector("[data-slot=cursor-readout-lanes] li")!;
    expect(li.textContent).toBe("<b>x</b>: critical");
    expect(li.querySelector("b")).toBeNull();
    axis.dispose();
  });
});

describeDom("timeline view — header controls (item 018)", (dom) => {
  const mounted: { unmount(): void }[] = [];

  beforeAll(() => {
  });

  afterEach(() => {
    while (mounted.length > 0) mounted.pop()!.unmount();
  });

  afterAll(() => {
  });

  async function mount(vnode: ReactElement): Promise<HTMLElement> {
    const m = await dom.mount(vnode);
    mounted.push(m);
    await flush();
    return m.container;
  }

  const PAUSED_AT = TIMELINE_NOW_S - HOUR;

  test("REQ-FOLLOW-02: LiveControl reads 'Live' + 'Pause' while live and 'Showing until {t}' + 'Paused — resume live' while paused", async () => {
    const calls: string[] = [];
    const live = await mount(el(LiveControl, { pausedAt: null, clock: CLOCK, onPause: () => calls.push("pause"), onResume: () => calls.push("resume") }));
    const liveState = live.querySelector("[data-live]")!;
    expect(liveState.getAttribute("data-live")).toBe("true");
    expect(liveState.textContent).toBe("Live");
    const pause = buttonNamed(live, "Pause")!;
    expect(pause.textContent).toBe("Pause");
    expect(pause.getAttribute("aria-keyshortcuts")).toBe("l");
    expect(pause.hasAttribute("data-paused")).toBe(false);
    pause.click();

    const paused = await mount(el(LiveControl, { pausedAt: PAUSED_AT, clock: CLOCK, onPause: () => calls.push("pause"), onResume: () => calls.push("resume") }));
    const pausedState = paused.querySelector("[data-live]")!;
    expect(pausedState.getAttribute("data-live")).toBe("false");
    expect(pausedState.textContent).toBe(`Showing until ${CLOCK.format(new Date(PAUSED_AT * 1000).toISOString())}`);
    const resume = buttonNamed(paused, "Paused — resume live")!;
    expect(buttonNamed(paused, "Pause")).toBeNull();
    expect(resume.textContent).toBe("Paused — resume live");
    expect(resume.getAttribute("data-paused")).toBe("true");
    expect(resume.getAttribute("aria-keyshortcuts")).toBe("l");
    resume.click();
    expect(calls).toEqual(["pause", "resume"]);
  });

  test("REQ-ZOOM-02: ResetZoom is always visible, disabled when zoomed=false and calls onReset when enabled", async () => {
    let resets = 0;
    const off = await mount(el(ResetZoom, { zoomed: false, onReset: () => resets++ }));
    const b0 = buttonNamed(off, "Reset zoom")!;
    expect(b0.textContent).toBe("Reset zoom");
    expect(b0.disabled).toBe(true);
    expect(b0.getAttribute("aria-keyshortcuts")).toBe("0");
    const on = await mount(el(ResetZoom, { zoomed: true, onReset: () => resets++ }));
    const b1 = buttonNamed(on, "Reset zoom")!;
    expect(b1.disabled).toBe(false);
    b1.click();
    expect(resets).toBe(1);
  });

  test("REQ-ZOOM-03: StepLabel shows 'resolution: —' for null and formatStepLabel output otherwise", async () => {
    const none = await mount(el(StepLabel, { stepSeconds: null }));
    expect(none.querySelector("[data-slot=timeline-step]")!.textContent).toBe("resolution: —");
    const five = await mount(el(StepLabel, { stepSeconds: 300 }));
    expect(five.querySelector("[data-slot=timeline-step]")!.textContent).toBe(`resolution: ${formatStepLabel(300)}`);
    expect(five.textContent).toBe("resolution: 5 min");
  });

  test("REQ-RANGE-03: ZoneLabel shows 'Times in {zone}' and TZ_FALLBACK_MARKER only when clock.tzFallback", async () => {
    const zone = await mount(el(ZoneLabel, { clock: CLOCK }));
    expect(zone.querySelector("[data-slot=timeline-zone]")!.textContent).toBe("Times in America/Chicago");
    expect(zone.querySelector("[data-slot=timeline-tz-fallback]")).toBeNull();
    const fb = await mount(el(ZoneLabel, { clock: FALLBACK_CLOCK }));
    expect(fb.querySelector("[data-slot=timeline-zone]")!.textContent).toContain(`Times in ${FALLBACK_CLOCK.timezone}`);
    expect(fb.querySelector("[data-slot=timeline-tz-fallback]")!.textContent).toContain(TZ_FALLBACK_MARKER);
  });

  test("REQ-URL-02: UrlNotices renders one p[data-notice-key] per notice plus latest-window; Dismiss hides them; a different notice reappears", async () => {
    const empty = await mount(el(UrlNotices, { notices: [], historyNotice: null }));
    expect(empty.querySelector("[role=status]")).toBeNull();

    const first: UrlFallbackNotice[] = [
      { key: "range", message: "Unknown range \"90d\" — showing 24h" },
      { key: "zoom", message: "<b>x</b> zoom ignored" },
    ];
    const props = signal<{ notices: readonly UrlFallbackNotice[]; historyNotice: string | null }>({
      notices: first,
      historyNotice: "History is only available for the latest 24h; the paused window is older",
    });
    const Host = (): ReactElement => {
      useSignals();
      return el(UrlNotices, props.value);
    };
    const c = await mount(el(Host, null));
    const box = noticesBox(c)!;
    expect(box.getAttribute("role")).toBe("status");
    expect(box.getAttribute("data-slot")).toBe("callout");
    const ps = Array.from(box.querySelectorAll("p[data-notice-key]"));
    expect(ps.map((p) => p.getAttribute("data-notice-key"))).toEqual(["range", "zoom", "latest-window"]);
    expect(ps[0]!.textContent).toBe(first[0]!.message);
    expect(ps[1]!.textContent).toBe("<b>x</b> zoom ignored"); // plain text, never markup (REQ-SEC-02)
    expect(ps[1]!.querySelector("b")).toBeNull();
    expect(ps[2]!.textContent).toBe("History is only available for the latest 24h; the paused window is older");

    buttonNamed(box, "Dismiss")!.click();
    await flush();
    expect(noticesBox(c)).toBeNull();

    // The same content again stays dismissed; a different notice reappears.
    props.value = { notices: [...first], historyNotice: props.value.historyNotice };
    await flush();
    expect(noticesBox(c)).toBeNull();
    props.value = { notices: [{ key: "sel", message: "Unknown target — selection cleared" }], historyNotice: null };
    await flush();
    const again = Array.from(c.querySelectorAll("p[data-notice-key]"));
    expect(again.map((p) => p.getAttribute("data-notice-key"))).toEqual(["sel"]);
  });

  test("REQ-FOLLOW-02: TimelineControls composes range, live, reset zoom, zone and step in the header", async () => {
    const c = await mount(el(TimelineControls, {
      range: "24h", pausedAt: null, zoomed: false, stepSeconds: 145, clock: CLOCK,
      onRange: () => {}, onPause: () => {}, onResume: () => {}, onResetZoom: () => {},
    }));
    const root = c.querySelector("[data-slot=timeline-controls]")!;
    const group = root.querySelector('[role="radiogroup"][aria-label="Time range"]')!;
    expect(Array.from(group.querySelectorAll('[role="radio"]')).map((r) => r.textContent)).toEqual(["1h", "6h", "24h", "7d"]);
    expect(group.querySelector('[role="radio"][aria-checked="true"]')!.textContent).toBe("24h");
    expect(buttonNamed(root, "Pause")!.getAttribute("aria-keyshortcuts")).toBe("l");
    expect(buttonNamed(root, "Reset zoom")!.disabled).toBe(true);
    expect(root.querySelector("[data-slot=timeline-zone]")!.textContent).toBe("Times in America/Chicago");
    expect(root.querySelector("[data-slot=timeline-step]")!.textContent).toBe(`resolution: ${formatStepLabel(145)}`);
  });

  test("REQ-KIOSK-03: KioskStatusLine is text only: 'Last 24 hours · Live · Times in {zone} · resolution: {step}'", async () => {
    const c = await mount(el(KioskStatusLine, { range: "24h", clock: CLOCK, stepSeconds: 145 }));
    const line = c.querySelector("p[data-slot=timeline-kiosk-status]")!;
    expect(line.textContent).toBe(`Last 24 hours · Live · Times in America/Chicago · resolution: ${formatStepLabel(145)}`);
    expect(c.querySelector("button")).toBeNull();
    expect(c.querySelector("[tabindex]")).toBeNull();

    const other = await mount(el(KioskStatusLine, { range: "7d", clock: FALLBACK_CLOCK, stepSeconds: null }));
    const text = other.querySelector("p[data-slot=timeline-kiosk-status]")!.textContent!;
    expect(text.startsWith("Last 7 days · Live · Times in ")).toBe(true);
    expect(text).toContain(TZ_FALLBACK_MARKER);
    expect(text.endsWith("resolution: —")).toBe(true);
  });
});

// --- item 019: lanes.tsx and decorations.tsx -------------------------------------------------------

/** A hand-built lane node (for markup-bearing labels); services get one "<host>/<svc>" endpoint. */
function laneNode(name: string, services: readonly string[]): LaneNode {
  return {
    target: { kind: "host", id: `host:${name}` },
    label: name,
    hostName: null,
    name,
    endpoints: [],
    queryIds: [],
    grafanaUrl: null,
    children: services.map((s) => ({
      target: { kind: "service", id: `svc:${name}/${s}` },
      label: s,
      hostName: name,
      name: s,
      endpoints: [`${name}/${s}`],
      queryIds: [],
      grafanaUrl: null,
      children: [],
    })),
  };
}

function seg(status: LaneSegment["status"], start: number, end: number, cause: LaneSegment["cause"] = status === "ok" ? "ok" : status === "unknown" ? "no-data" : "alert"): LaneSegment {
  return { status, start, end, cause, alertnames: [] };
}

/** The lane model at 3 hosts × 2 services, built by 05's buildLaneTree over timeline-fixtures data. */
function fixtureTree(): readonly LaneNode[] {
  const snapshot = makeHierarchySnapshot({ hosts: 3, servicesPerHost: 2 });
  return buildLaneTree(snapshot, makeTimelineIndex(snapshot)).hosts;
}

/** Two declared domains (09 §3). */
const TWO_DOMAINS: readonly TimelineDomain[] = [
  { domain: "example.com", endpoint: "dns:example.com" },
  { domain: "example.org", endpoint: "dns:example.org" },
];

/** Blocks plus the evidence map, gathered the way the view does (07 §5.3). */
function laneInputs(o: {
  hosts: readonly LaneNode[];
  expanded?: ReadonlySet<TargetKey>;
  domains?: readonly TimelineDomain[];
  domainsExpanded?: boolean;
  alertLanes?: readonly AlertHistoryLane[] | null;
  window?: TimeWindow;
  reachable?: (key: string) => boolean;
  checks?: ReadonlyMap<string, HistoryRegionState<EndpointHistoryPayload>>;
}): { blocks: readonly LaneBlock[]; evidence: Map<string, ReturnType<typeof laneEvidence>> } {
  const expanded = o.expanded ?? new Set<TargetKey>();
  const blocks = buildLaneBlocks(o.hosts, expanded, o.domains ?? TWO_DOMAINS, o.domainsExpanded ?? false);
  const ctx: LaneEvidenceContext = {
    alertLanes: o.alertLanes === undefined ? [] : o.alertLanes,
    noData: [],
    lookup: (e) => o.checks?.get(e),
    expanded,
    window: o.window ?? DOMAIN,
    cache: createLaneEvidenceCache(),
    reachable: o.reachable ?? (() => false),
  };
  const evidence = new Map(blocks.flatMap((b) => b.rows).map((row) => [row.key, laneEvidence(row, ctx)] as const));
  return { blocks, evidence };
}

/** Deep-copy a fixture payload with every ISO timestamp string and every `points` [ms, value] time moved by `shiftSec`. */
function shiftFixtureTimes<T>(payload: T, shiftSec: number): T {
  const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
  const walk = (v: unknown, key: string | null): unknown => {
    if (typeof v === "string" && iso.test(v)) return new Date(Date.parse(v) + shiftSec * 1000).toISOString();
    if (Array.isArray(v)) {
      if (key === "points") return v.map((p) => (Array.isArray(p) && typeof p[0] === "number" ? [p[0] + shiftSec * 1000, ...p.slice(1)] : walk(p, null)));
      return v.map((x) => walk(x, null));
    }
    if (v !== null && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]));
    return v;
  };
  return walk(payload, null) as T;
}

describe("timeline lanes — pure helpers (item 019)", () => {
  test("worstInView ignores the live-edge no-data tail (history cache age) only while following live", () => {
    const view = { start: 0, end: 3_600 };
    const tailed = [seg("ok", 0, 3_570), seg("unknown", 3_570, 3_600)];
    expect(worstInView(tailed, view).status).toBe("unknown"); // not live: the tail counts
    expect(worstInView(tailed, view, 60).status).toBe("ok"); // live: a 30 s tail within 60 s is ignored
    expect(worstInView([seg("ok", 0, 3_400), seg("unknown", 3_400, 3_600)], view, 60).status).toBe("unknown"); // longer gap is real
    expect(worstInView([seg("unknown", 0, 3_600)], view, 60).status).toBe("unknown"); // nothing but tail
    expect(worstInView([seg("critical", 0, 100), seg("ok", 100, 3_570), seg("unknown", 3_570, 3_600)], view, 60).status).toBe("critical");
  });

  test("REQ-LANE-01: lanes.tsx exports its constants (LANE_GAP_PX 2, DEFAULT_ROW_PX 18, MIN_PLOT_WIDTH_PX 320, LANE_READOUT_ORDER 0)", () => {
    expect(LANE_GAP_PX).toBe(2);
    expect(DEFAULT_ROW_PX).toBe(18);
    expect(MIN_PLOT_WIDTH_PX).toBe(320);
    expect(LANE_READOUT_ORDER).toBe(0);
    expect(AXIS_LABEL_MIN_PX).toBe(96);
  });

  test("REQ-LANE-01: buildLaneBlocks with nothing expanded gives one host block plus the Domains block", () => {
    const hosts = fixtureTree();
    const blocks = buildLaneBlocks(hosts, new Set(), TWO_DOMAINS, false);
    expect(blocks.map((b) => b.id)).toEqual(["hosts-0", "domains"]);
    expect(blocks.map((b) => b.label)).toEqual(["Hosts", "Domains"]);
    const hostRows = blocks[0]!.rows;
    expect(hostRows.map((r) => r.kind)).toEqual(["host", "host", "host"]);
    expect(hostRows.map((r) => r.posInSet)).toEqual([1, 2, 3]);
    expect(hostRows.every((r) => r.setSize === 4 && r.level === 1)).toBe(true);
    expect(hostRows.every((r) => r.kind === "host" && r.expandable && !r.expanded)).toBe(true);
    expect(blocks[1]!.rows).toEqual([{ kind: "domains", key: "domains", domains: TWO_DOMAINS, level: 1, expanded: false, posInSet: 4, setSize: 4 }]);
    expect(buildLaneBlocks([], new Set(), [], false)).toEqual([]);
  });

  test("REQ-ECR-C3: buildLaneBlocks with 0 domains emits no Domains header, and the header does not count toward setSize", () => {
    const hosts = fixtureTree();
    for (const expanded of [false, true]) {
      const blocks = buildLaneBlocks(hosts, new Set(), [], expanded);
      expect(blocks.map((b) => b.id)).toEqual(["hosts-0"]);
      expect(blocks[0]!.rows.every((r) => r.setSize === 3)).toBe(true);
    }
  });

  test("REQ-ECR-C3: buildLaneBlocks with 2 domains: collapsed = header only; expanded = header + one level-2 domain row each", () => {
    const hosts = fixtureTree();
    const collapsed = buildLaneBlocks(hosts, new Set(), TWO_DOMAINS, false);
    expect(collapsed[1]!.rows.map((r) => r.kind)).toEqual(["domains"]);
    const expanded = buildLaneBlocks(hosts, new Set(), TWO_DOMAINS, true);
    expect(expanded.map((b) => b.id)).toEqual(["hosts-0", "domains"]);
    expect(expanded[1]!.rows).toEqual([
      { kind: "domains", key: "domains", domains: TWO_DOMAINS, level: 1, expanded: true, posInSet: 4, setSize: 4 },
      { kind: "domain", key: "endpoint:dns:example.com", domain: "example.com", endpoint: "dns:example.com", level: 2, posInSet: 1, setSize: 2 },
      { kind: "domain", key: "endpoint:dns:example.org", domain: "example.org", endpoint: "dns:example.org", level: 2, posInSet: 2, setSize: 2 },
    ]);
    // Host rows count the header toward the level-1 set size.
    expect(expanded[0]!.rows.every((r) => r.setSize === 4)).toBe(true);
  });

  test("REQ-ECR-C3: domain lanes carry check evidence only; the Domains header is the worst of its domain lanes and partial while one is loading", () => {
    const hosts = fixtureTree();
    const failing = makeEndpointHistory("dns:example.com", {
      results: Array.from({ length: 60 }, (_, i) => [-3_600 + (i + 1) * 60, i < 30] as const),
    });
    const healthy = makeEndpointHistory("dns:example.org");
    const all = () => true;
    // Alert lanes on a domain never reach the domain lane (they stay unmatched in the swimlane).
    const domainAlert = makeAlertLane({ alertname: "DomainExpiring", severity: "critical", target: null, intervals: [[-3000, -2000]] });
    const ready = laneInputs({
      hosts, domainsExpanded: true, reachable: all, alertLanes: [domainAlert],
      checks: new Map<string, HistoryRegionState<EndpointHistoryPayload>>([
        ["dns:example.com", { phase: "ready", data: failing }],
        ["dns:example.org", { phase: "ready", data: healthy }],
      ]),
    });
    const com = ready.evidence.get("endpoint:dns:example.com")!;
    const org = ready.evidence.get("endpoint:dns:example.org")!;
    const window = { start: TIMELINE_NOW_S - 3_540, end: TIMELINE_NOW_S };
    expect(worstInView(com.segments, window).status).toBe("critical");
    expect(com.segments.some((sg) => sg.cause === "check")).toBe(true);
    expect(com.segments.every((sg) => sg.alertnames.length === 0)).toBe(true);
    expect(worstInView(org.segments, window).status).toBe("ok");
    expect(worstInView(ready.evidence.get("domains")!.segments, window).status).toBe("critical");
    expect(ready.evidence.get("domains")!.partial).not.toBe("loading");

    // One endpoint still loading: the header keeps the other's status and reads partial ("loading").
    const loading = laneInputs({
      hosts, reachable: all,
      checks: new Map<string, HistoryRegionState<EndpointHistoryPayload>>([
        ["dns:example.com", { phase: "loading", previous: null }],
        ["dns:example.org", { phase: "ready", data: healthy }],
      ]),
    });
    const header = loading.evidence.get("domains")!;
    expect(header.partial).toBe("loading");
    expect(worstInView(header.segments, window).status).toBe("ok");
    // Nothing loaded yet: a domain lane reads no data over the whole window, never OK.
    const none = laneInputs({ hosts, domainsExpanded: true, reachable: all });
    const lane = none.evidence.get("endpoint:dns:example.com")!;
    expect(lane.partial).toBe("not-loaded");
    expect(lane.segments).toEqual([{ status: "unknown", start: DOMAIN.start, end: DOMAIN.end, cause: "no-data", alertnames: [] }]);
  });

  test("REQ-LANE-01: buildLaneBlocks splits at an expanded host: hosts up to it, its services, the remaining hosts, then Domains + its domain rows", () => {
    const hosts = fixtureTree();
    const middle = targetKey(hosts[1]!.target);
    const blocks = buildLaneBlocks(hosts, new Set([middle]), TWO_DOMAINS, true);
    expect(blocks.map((b) => b.id)).toEqual(["hosts-0", `services-${middle}`, "hosts-1", "domains"]);
    expect(blocks[0]!.rows.map((r) => r.key)).toEqual([targetKey(hosts[0]!.target), middle]);
    expect(blocks[1]!.label).toBe(`Services of ${hosts[1]!.label}`);
    const services = blocks[1]!.rows;
    expect(services.map((r) => r.kind)).toEqual(["service", "service"]);
    expect(services.map((r) => (r.kind === "service" ? r.parentKey : null))).toEqual([middle, middle]);
    expect(services.map((r) => [r.level, r.posInSet, r.setSize])).toEqual([[2, 1, 2], [2, 2, 2]]);
    expect(blocks[2]!.rows.map((r) => r.posInSet)).toEqual([3]);
    expect(blocks[3]!.rows.map((r) => r.kind)).toEqual(["domains", "domain", "domain"]);
    // An expanded key on a host without services does not split.
    const bare = laneNode("bare", []);
    const b2 = buildLaneBlocks([bare], new Set([targetKey(bare.target)]), [], false);
    expect(b2.map((b) => b.id)).toEqual(["hosts-0"]);
    expect(b2[0]!.rows[0]).toMatchObject({ expandable: false, expanded: false });
  });

  test("REQ-LANE-02/03: worstInView ranks critical > warning > no data > OK over the segments that intersect the view", () => {
    const view = { start: 100, end: 200 };
    expect(worstInView([seg("ok", 0, 100), seg("critical", 200, 300)], view)).toEqual({ status: "unknown", text: "no data" });
    expect(worstInView([seg("critical", 0, 100), seg("ok", 100, 200), seg("critical", 200, 300)], view)).toEqual({ status: "ok", text: "OK" });
    expect(worstInView([seg("ok", 100, 150), seg("unknown", 150, 200)], view)).toEqual({ status: "unknown", text: "no data" });
    expect(worstInView([seg("unknown", 100, 150), seg("warning", 150, 200)], view)).toEqual({ status: "warning", text: "warning" });
    expect(worstInView([seg("warning", 50, 150), seg("critical", 150, 250)], view)).toEqual({ status: "critical", text: "critical" });
    expect(worstInView([], view)).toEqual({ status: "unknown", text: "no data" });
  });

  test("REQ-RANGE-03: computeAxisTicks returns [] for an empty window or maxTicks < 1", () => {
    expect(computeAxisTicks({ start: 100, end: 100 }, CLOCK, 4)).toEqual([]);
    expect(computeAxisTicks({ start: 200, end: 100 }, CLOCK, 4)).toEqual([]);
    expect(computeAxisTicks(DOMAIN, CLOCK, 0)).toEqual([]);
    expect(computeAxisTicks(DOMAIN, CLOCK, Number.NaN)).toEqual([]);
  });

  test("REQ-RANGE-03: computeAxisTicks aligns to estate-local times with HH:MM labels, and MM-DD HH:MM when step ≥ 21600", () => {
    // TIMELINE_NOW_S is 2026-09-24 12:00Z = 07:00 CDT.
    const hour = computeAxisTicks({ start: TIMELINE_NOW_S - 3600, end: TIMELINE_NOW_S }, CLOCK, 4);
    expect(hour.map((t) => t.label)).toEqual(["06:00", "06:30", "07:00"]);
    expect(hour.map((t) => t.fraction)).toEqual([0, 0.5, 1]);
    const day = computeAxisTicks({ start: TIMELINE_NOW_S - 86_400, end: TIMELINE_NOW_S }, CLOCK, 4);
    expect(day.map((t) => t.label)).toEqual(["09-23 12:00", "09-23 18:00", "09-24 00:00", "09-24 06:00"]);
    expect(day.length).toBeLessThanOrEqual(4);
    expect(day[1]!.t - day[0]!.t).toBe(21_600);
    const week = computeAxisTicks({ start: TIMELINE_NOW_S - 7 * 86_400, end: TIMELINE_NOW_S }, CLOCK, 3);
    expect(week.length).toBeGreaterThan(0);
    expect(week.length).toBeLessThanOrEqual(3);
    expect(week.every((t) => /^\d\d-\d\d 00:00$/.test(t.label))).toBe(true);
  });

  test("REQ-HISTERR-02: regionData gives ready data, previous while loading/error, null otherwise", () => {
    const data = { fetchedAt: "x", stale: false };
    const prev = { fetchedAt: "p", stale: false };
    const failure = classifyFailure("SOURCE_TIMEOUT", null);
    expect(regionData<typeof data>({ phase: "ready", data })).toBe(data);
    expect(regionData<typeof data>({ phase: "loading", previous: prev })).toBe(prev);
    expect(regionData<typeof data>({ phase: "error", failure, previous: prev })).toBe(prev);
    expect(regionData<typeof data>({ phase: "loading", previous: null })).toBeNull();
    expect(regionData<typeof data>({ phase: "error", failure, previous: null })).toBeNull();
    expect(regionData<typeof data>({ phase: "idle" })).toBeNull();
    expect(regionData<typeof data>({ phase: "not-applicable", reason: "r" })).toBeNull();
  });

  test("REQ-LANE-04: laneEvidence — collapsed host with checked services is partial, an expanded host is not, unlisted services and domains are evidence-unavailable (no data)", () => {
    const hosts = fixtureTree();
    const first = targetKey(hosts[0]!.target);
    const { blocks, evidence } = laneInputs({ hosts, expanded: new Set([first]), domainsExpanded: true });
    const rows = blocks.flatMap((b) => b.rows);
    const byKind = (k: LaneRow["kind"]) => rows.filter((r) => r.kind === k).map((r) => evidence.get(r.key)!);
    expect(evidence.get(first)!.partial).toBeNull();
    expect(evidence.get(targetKey(hosts[1]!.target))!.partial).toBe("not-loaded");
    expect(byKind("service").every((r) => r.partial === "evidence-unavailable")).toBe(true);
    const domains = evidence.get("domains")!;
    expect(domains.partial).toBe("evidence-unavailable");
    expect(domains.segments).toEqual([{ status: "unknown", start: DOMAIN.start, end: DOMAIN.end, cause: "no-data", alertnames: [] }]);
    expect(byKind("domain").length).toBe(2);
    expect(byKind("domain").every((r) => r.partial === "evidence-unavailable" && r.segments[0]!.cause === "no-data")).toBe(true);
    expect(evidence.has("domains-note")).toBe(false);
  });
});

describeDom("timeline lanes — LaneTree, LaneEvidenceStatus and LaneDecorations (item 019)", (dom) => {
  const mounted: { unmount(): void }[] = [];
  const axes: TimeAxisController[] = [];

  beforeAll(() => {
  });

  afterEach(() => {
    while (mounted.length > 0) mounted.pop()!.unmount();
    while (axes.length > 0) axes.pop()!.dispose();
  });

  afterAll(() => {
  });

  async function mount(vnode: ReactElement): Promise<HTMLElement> {
    const m = await dom.mount(vnode);
    mounted.push(m);
    await flush();
    return m.container;
  }

  function treeVNode(o: {
    blocks: readonly LaneBlock[];
    evidence: ReadonlyMap<string, ReturnType<typeof laneEvidence>>;
    interactive?: boolean;
    selected?: TargetKey | null;
    readouts?: ReturnType<typeof createReadoutRegistry>;
    reachable?: (key: string) => boolean;
  }): ReactElement {
    const axis = newAxis();
    axes.push(axis);
    return el(LaneTree, {
      reachable: o.reachable ?? (() => false),
      blocks: o.blocks,
      evidence: o.evidence,
      selected: o.selected ?? null,
      axis,
      readouts: o.readouts ?? createReadoutRegistry(),
      clock: CLOCK,
      interactive: o.interactive ?? true,
      readoutId: "pulse-timeline-readout",
      status: null,
      onToggle: () => {},
      onSelect: () => {},
    });
  }

  test("REQ-LANE-01/REQ-LANE-04: collapsed hosts render a role=tree of treeitems with level/setsize/posinset, expanded and selected state and one tab stop", async () => {
    const hosts = fixtureTree();
    const { blocks, evidence } = laneInputs({ hosts });
    const selected = targetKey(hosts[1]!.target);
    const c = await mount(treeVNode({ blocks, evidence, selected }));
    const tree = c.querySelector<HTMLElement>("#timeline-lane-tree")!;
    expect(tree.getAttribute("role")).toBe("tree");
    expect(tree.getAttribute("aria-label")).toBe("Status lanes by host");
    const rows = Array.from(tree.querySelectorAll<HTMLElement>('[role="treeitem"]'));
    expect(rows.length).toBe(4);
    expect(rows.map((r) => r.getAttribute("aria-level"))).toEqual(["1", "1", "1", "1"]);
    expect(rows.map((r) => r.getAttribute("aria-setsize"))).toEqual(["4", "4", "4", "4"]);
    expect(rows.map((r) => r.getAttribute("aria-posinset"))).toEqual(["1", "2", "3", "4"]);
    expect(rows.map((r) => r.getAttribute("aria-expanded"))).toEqual(["false", "false", "false", "false"]);
    expect(rows.map((r) => r.getAttribute("aria-selected"))).toEqual(["false", "true", "false", null]);
    expect(rows.filter((r) => r.getAttribute("tabindex") === "0").length).toBe(1);
    expect(rows.every((r) => r.querySelector("[data-slot=timeline-lane-twisty]") !== null)).toBe(true);

    // Collapsed hosts with checked services: "partial evidence" (reason "not loaded").
    for (const r of rows.slice(0, 3)) {
      expect(r.getAttribute("data-partial")).toBe("true");
      expect(r.textContent).toContain("partial evidence");
      expect(r.textContent).toContain("worst in view:");
    }
    // The Domains header: "no data" plus "check history not available".
    const domains = rows[3]!;
    expect(domains.getAttribute("data-lane-key")).toBe("domains");
    expect(domains.querySelector("[data-slot=timeline-lane-name]")!.textContent).toBe("Domains");
    expect(domains.textContent).toContain("no data");
    expect(domains.textContent).toContain("check history not available");
    expect(domains.getAttribute("data-status")).toBe("unknown");

    // One plot block per LaneBlock, each with StatusTimeline + decorations + a named overlay.
    const plots = Array.from(c.querySelectorAll<HTMLElement>("[data-block]"));
    expect(plots.map((p) => p.getAttribute("data-block"))).toEqual(["hosts-0", "domains"]);
    expect(plots[0]!.querySelector('svg[role="img"]')!.getAttribute("aria-label")).toBe("Hosts: status over the visible window");
    expect(plots[0]!.querySelector("[data-slot=plot-overlay]")!.getAttribute("aria-label")).toBe("Hosts — time cursor");
    expect(plots[0]!.querySelectorAll("[data-deco=partial]").length).toBe(3);
    expect(plots[0]!.querySelectorAll("[data-deco=selected]").length).toBe(1);
    expect(c.querySelector('ul[aria-label="Status lane legend"]')!.textContent).toContain("Checks (Gatus)");
    expect(c.querySelector("svg[data-slot=timeline-axis]")!.getAttribute("aria-hidden")).toBe("true");
  });

  test("REQ-LANE-01/REQ-ECR-C3: expanding Domains lists one DNS-check row per domain, and expanded services read partial evidence and check history not available", async () => {
    const hosts = fixtureTree();
    const first = targetKey(hosts[0]!.target);
    const { blocks, evidence } = laneInputs({ hosts, expanded: new Set([first]), domainsExpanded: true });
    const c = await mount(treeVNode({ blocks, evidence }));
    const rows = Array.from(c.querySelectorAll<HTMLElement>('[role="treeitem"]'));
    expect(rows.map((r) => r.getAttribute("aria-level"))).toEqual(["1", "2", "2", "1", "1", "1", "2", "2"]);
    const domainRows = rows.slice(6);
    expect(domainRows.map((r) => r.querySelector("[data-slot=timeline-lane-name]")!.textContent)).toEqual(["example.com", "example.org"]);
    expect(domainRows.map((r) => r.getAttribute("data-lane-key"))).toEqual(["endpoint:dns:example.com", "endpoint:dns:example.org"]);
    expect(domainRows.map((r) => [r.getAttribute("aria-posinset"), r.getAttribute("aria-setsize")])).toEqual([["1", "2"], ["2", "2"]]);
    for (const d of domainRows) {
      expect(d.textContent).toContain("DNS check");
      expect(d.getAttribute("title")).toMatch(/^example\.(com|org) DNS check, worst in view: no data/);
      expect(d.hasAttribute("aria-selected")).toBe(false);
      expect(d.hasAttribute("aria-expanded")).toBe(false);
      expect(d.textContent).toContain("check history not available"); // reachable () => false here
    }
    expect(c.textContent).not.toContain("Check history is not available for domain checks.");
    expect(rows[5]!.getAttribute("aria-expanded")).toBe("true");
    expect(rows[0]!.getAttribute("aria-expanded")).toBe("true");
    // An expanded host carries no partial marker; its services do, with the unavailable suffix.
    expect(rows[0]!.hasAttribute("data-partial")).toBe(false);
    for (const svc of [rows[1]!, rows[2]!]) {
      expect(svc.textContent).toContain("partial evidence");
      expect(svc.textContent).toContain("check history not available");
      expect(svc.hasAttribute("aria-expanded")).toBe(false);
      expect(svc.getAttribute("aria-selected")).toBe("false");
    }
  });

  test("REQ-LANE-02: an attributed critical alert makes the host read critical, and the block readout names the alert", async () => {
    const hosts = fixtureTree();
    const alert = makeAlertLane({ alertname: "HostDown", severity: "critical", target: hosts[0]!.target, intervals: [[-1800, -600]] });
    const { blocks, evidence } = laneInputs({ hosts, alertLanes: [alert] });
    const readouts = createReadoutRegistry();
    const c = await mount(treeVNode({ blocks, evidence, readouts }));
    const row = c.querySelector<HTMLElement>(`[data-lane-key="${targetKey(hosts[0]!.target)}"]`)!;
    expect(row.getAttribute("data-status")).toBe("critical");
    expect(row.querySelector("[data-slot=status-badge]")!.getAttribute("data-status")).toBe("critical");
    const entries = readouts.read(TIMELINE_NOW_S - 1200);
    expect(entries.lanes.length).toBe(4);
    expect(entries.lanes[0]).toEqual({ label: hosts[0]!.label, status: "critical", text: "critical — HostDown", partial: "not loaded" });
    expect(entries.lanes[3]).toMatchObject({ label: "Domains", status: "unknown", text: "no data", partial: "evidence unavailable" });
    // Unmount unregisters every block's source.
    mounted.pop()!.unmount();
    expect(readouts.read(TIMELINE_NOW_S - 1200).lanes).toEqual([]);
  });

  test("REQ-KIOSK-03/REQ-SEC-02: interactive=false renders list/listitem, no tabindex, no overlay, no twisty, and markup labels literally", async () => {
    const hostile = laneNode("<b>x</b>", ["<img src=x onerror=alert(1)>"]);
    const { blocks, evidence } = laneInputs({ hosts: [hostile, laneNode("web01", [])] });
    const c = await mount(treeVNode({ blocks, evidence, interactive: false }));
    const list = c.querySelector<HTMLElement>("#timeline-lane-tree")!;
    expect(list.getAttribute("role")).toBe("list");
    expect(c.querySelector('[role="tree"], [role="treeitem"]')).toBeNull();
    const items = Array.from(list.querySelectorAll<HTMLElement>('[role="listitem"]'));
    expect(items.length).toBe(3);
    expect(c.querySelector("[tabindex]")).toBeNull();
    expect(c.querySelector("[data-slot=plot-overlay]")).toBeNull();
    expect(c.querySelector("[data-slot=timeline-lane-twisty]")).toBeNull();
    expect(items.some((i) => i.hasAttribute("aria-expanded") || i.hasAttribute("aria-selected"))).toBe(false);
    expect(items[0]!.querySelector("[data-slot=timeline-lane-name]")!.textContent).toBe("<b>x</b>");
    expect(c.querySelector("b")).toBeNull();
    expect(c.querySelector("img")).toBeNull();
    // Collapsed hosts with checked services still read partial evidence in kiosk.
    expect(items[0]!.textContent).toContain("partial evidence");
    expect(items[1]!.textContent).not.toContain("partial evidence");
  });

  // --- LaneEvidenceStatus (07 §5.5) ---

  type Src = EvidenceSource["state"];
  function source(name: string, state: Src, onRetry: () => void = () => {}): EvidenceSource {
    return { source: name, state, onRetry };
  }
  const PREV = { fetchedAt: new Date(TIMELINE_NOW_S * 1000).toISOString(), stale: false };

  test("REQ-HISTERR-01..04/REQ-DEGRADE-01: LaneEvidenceStatus renders one worded line per source that is not ready", async () => {
    const c = await mount(
      el(LaneEvidenceStatus, {
        sources: [
          source("Alert history (vmalert)", { phase: "loading", previous: null }),
          source("Coverage (VictoriaMetrics)", { phase: "loading", previous: PREV }),
        ],
        clock: CLOCK,
        onShorterRange: () => {},
      }),
    );
    const ul = c.querySelector<HTMLElement>('ul[aria-label="Lane evidence status"]')!;
    expect(ul.getAttribute("role")).toBe("status");
    expect(ul.getAttribute("aria-label")).toBe("Lane evidence status");
    const lines = Array.from(ul.querySelectorAll("li"));
    expect(lines.map((l) => l.textContent)).toEqual(["Alert history (vmalert): loading…"]);
    expect(lines[0]!.getAttribute("data-source-phase")).toBe("loading");
  });

  test("REQ-HISTERR-02: an error with previous data gives the stale line with Last loaded and a Retry that calls onRetry", async () => {
    let retried = 0;
    const failure = classifyFailure("SOURCE_TIMEOUT", null);
    const c = await mount(
      el(LaneEvidenceStatus, {
        sources: [source("Alert history (vmalert)", { phase: "error", failure, previous: PREV }, () => retried++)],
        clock: CLOCK,
        onShorterRange: null,
      }),
    );
    const line = c.querySelector("li")!;
    expect(line.getAttribute("data-source-phase")).toBe("error");
    expect(line.textContent).toContain(`Alert history (vmalert): History query timed out. ${REGION_TEXT.stalePrevious} Last loaded ${CLOCK.format(PREV.fetchedAt)}.`);
    const buttons = Array.from(line.querySelectorAll("button"));
    expect(buttons.map((b) => b.textContent)).toEqual(["Retry"]);
    buttons[0]!.click();
    expect(retried).toBe(1);
  });

  test("REQ-HISTERR-04: too-many offers Try a shorter range, or reads REGION_TEXT.tooManyNoShorter with no button when onShorterRange is null", async () => {
    const failure = classifyFailure("HISTORY_LIMIT_EXCEEDED", null);
    let shorter = 0;
    const withShorter = await mount(
      el(LaneEvidenceStatus, {
        sources: [source("Alert history (vmalert)", { phase: "error", failure, previous: null })],
        clock: CLOCK,
        onShorterRange: () => shorter++,
      }),
    );
    const line = withShorter.querySelector("li")!;
    expect(line.textContent).toContain("Alert history (vmalert): Too many lanes/series for this range — try a shorter range. Lanes show no data for this evidence.");
    const buttons = Array.from(line.querySelectorAll("button"));
    expect(buttons.map((b) => b.textContent)).toEqual(["Try a shorter range"]);
    buttons[0]!.click();
    expect(shorter).toBe(1);

    const noShorter = await mount(
      el(LaneEvidenceStatus, {
        sources: [source("Alert history (vmalert)", { phase: "error", failure, previous: null })],
        clock: CLOCK,
        onShorterRange: null,
      }),
    );
    const line2 = noShorter.querySelector("li")!;
    expect(line2.textContent).toBe(`Alert history (vmalert): ${REGION_TEXT.tooManyNoShorter} Lanes show no data for this evidence.`);
    expect(line2.querySelector("button")).toBeNull();
  });

  test("REQ-DEGRADE-01: idle, not-applicable and stale-cache lines; everything ready renders nothing", async () => {
    const c = await mount(
      el(LaneEvidenceStatus, {
        sources: [
          source("Alert history (vmalert)", { phase: "idle" }),
          source("Coverage (VictoriaMetrics)", { phase: "not-applicable", reason: "Alert history is not available at this range." }),
          source("Extra", { phase: "ready", data: { ...PREV, stale: true } }),
        ],
        clock: CLOCK,
        onShorterRange: null,
      }),
    );
    expect(Array.from(c.querySelectorAll("li")).map((l) => l.textContent)).toEqual([
      "Alert history (vmalert): waiting for the timeline index.",
      "Coverage (VictoriaMetrics): Alert history is not available at this range.",
      `Extra: ${REGION_TEXT.staleCache}`,
    ]);
    const ready = await mount(
      el(LaneEvidenceStatus, {
        sources: [source("A", { phase: "ready", data: PREV }), source("B", { phase: "ready", data: PREV })],
        clock: CLOCK,
        onShorterRange: null,
      }),
    );
    expect(ready.querySelector("ul")).toBeNull();
    expect(ready.textContent).toBe("");
  });

  // --- LaneDecorations (07 §6) ---

  test("REQ-LANE-04/REQ-SWIM-02/03: LaneDecorations is an aria-hidden SVG matching its StatusTimeline, with each rect = timelineSegmentRect inset by 0.5", async () => {
    const layout = { domainStart: 1000, domainEnd: 2000, width: 400, laneHeight: 16, laneGap: 2 };
    const marks: DecorationMark[] = [
      { kind: "partial-lane", lane: 0 },
      { kind: "selected-lane", lane: 1 },
      { kind: "unmatched-interval", lane: 2, start: 1250, end: 1500 },
      { kind: "active-interval", lane: 2, start: 1100, end: 1200 },
      { kind: "unmatched-interval", lane: 1, start: 3000, end: 4000 }, // outside the window: skipped
      { kind: "overflow-badge", lane: 3, count: 2 },
    ];
    const lanes = [0, 1, 2, 3].map((i) => ({ id: `l${i}`, label: `lane ${i}`, segments: [{ status: "ok" as const, start: 1000, end: 2000 }] }));
    const c = await mount(
      el("div", null, el(StatusTimeline, { lanes, ...layout }), el(LaneDecorations, { marks, laneCount: 4, ...layout })),
    );
    const [base, deco] = Array.from(c.querySelectorAll("svg"));
    expect(deco!.getAttribute("data-slot")).toBe("lane-decorations");
    expect(deco!.getAttribute("aria-hidden")).toBe("true");
    expect(deco!.getAttribute("focusable")).toBe("false");
    for (const a of ["width", "height", "viewBox"]) expect(deco!.getAttribute(a)).toBe(base!.getAttribute(a));
    expect(Number(deco!.getAttribute("height"))).toBe(timelineHeight(4, 16, 2));

    const expectRect = (sel: string, s: number, e: number, lane: number): void => {
      const r = deco!.querySelector(sel)!;
      const want = timelineSegmentRect({ status: "unknown", start: s, end: e }, lane, layout)!;
      expect(Number(r.getAttribute("x"))).toBeCloseTo(want.x + 0.5, 6);
      expect(Number(r.getAttribute("y"))).toBeCloseTo(want.y + 0.5, 6);
      expect(Number(r.getAttribute("width"))).toBeCloseTo(want.width - 1, 6);
      expect(Number(r.getAttribute("height"))).toBeCloseTo(want.height - 1, 6);
      expect(r.getAttribute("fill")).toBe("none");
      expect(r.hasAttribute("stroke")).toBe(false);
    };
    expectRect("rect[data-deco=partial]", 1000, 2000, 0);
    expectRect("rect[data-deco=selected]", 1000, 2000, 1);
    expectRect("rect[data-deco=unmatched]", 1250, 1500, 2);
    expectRect("rect[data-deco=active]", 1100, 1200, 2);
    expect(deco!.querySelectorAll("rect[data-deco=unmatched]").length).toBe(1);
    const badge = deco!.querySelector("[data-deco=badge] text")!;
    expect(badge.textContent).toBe("+2");
    expect(badge.getAttribute("x")).toBe(String(layout.width - 2));
    expect(badge.getAttribute("text-anchor")).toBe("end");
    expect(deco!.querySelector("[data-deco=badge] rect")).not.toBeNull();
  });

  test("REQ-LANE-04: LaneDecorations with no marks renders nothing", async () => {
    const c = await mount(el(LaneDecorations, { marks: [], laneCount: 3, domainStart: 0, domainEnd: 10, width: 320, laneHeight: 16, laneGap: 2 }));
    expect(c.querySelector("svg")).toBeNull();
    expect(c.innerHTML).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Item 020 — AlertSwimlane (07 §7)
// ---------------------------------------------------------------------------

describe("timeline swimlane — pure helpers (item 020)", () => {
  const base: SwimInterval = {
    laneId: "abc" as SwimInterval["laneId"],
    alertname: "HostDown",
    severity: "critical",
    target: { kind: "host", id: "host:web01" },
    unmatched: false,
    start: TIMELINE_NOW_S - 600,
    end: TIMELINE_NOW_S - 300,
  };

  test("REQ-SWIM-04/REQ-SEC-04: swimIntervalHref links hs= for a target and sev= for a null target, percent-encoded", () => {
    expect(swimIntervalHref(base)).toBe(`/alerts?hs=${encodeURIComponent("host:web01")}`);
    expect(swimIntervalHref({ ...base, target: null, severity: "warning" })).toBe("/alerts?sev=warning");
    const hostile = swimIntervalHref({ ...base, target: { kind: "service", id: "svc:a&x=1/b#c" } });
    expect(hostile).toBe("/alerts?hs=svc%3Aa%26x%3D1%2Fb%23c");
    const params = new URLSearchParams(hostile.slice(hostile.indexOf("?")));
    expect([...params.keys()]).toEqual(["hs"]);
    expect(params.get("hs")).toBe("svc:a&x=1/b#c"); // the canonical id, prefixed once (GitHub #10)
    expect(swimIntervalHref({ ...base, target: { kind: "endpoint", id: "web01/grafana" } })).toBe(
      `/alerts?hs=${encodeURIComponent("endpoint:web01/grafana")}`,
    );
  });

  test("REQ-SWIM-04/REQ-SWIM-03: swimIntervalText names the alert, the lane label or unmatched target, and estate-time bounds", () => {
    const snapshot = makeHierarchySnapshot({ hosts: 2, servicesPerHost: 1 });
    const tree = buildLaneTree(snapshot, makeTimelineIndex(snapshot));
    const host = tree.hosts[0]!;
    const iv: SwimInterval = { ...base, target: host.target };
    const times = `${CLOCK.format(new Date(iv.start * 1000).toISOString())} → ${CLOCK.format(new Date(iv.end * 1000).toISOString())}`;
    expect(swimIntervalText(iv, tree, CLOCK)).toBe(`HostDown — ${host.label} — ${times}`);
    expect(swimIntervalText({ ...iv, target: null, unmatched: true }, tree, CLOCK)).toBe(`HostDown — unmatched target — ${times}`);
    expect(swimIntervalText({ ...iv, target: { kind: "host", id: "host:gone" }, unmatched: true }, tree, CLOCK)).toBe(
      `HostDown — unmatched target (host:gone) — ${times}`,
    );
    expect(times).toContain("C"); // America/Chicago abbreviation (CST/CDT): estate time, not UTC
    expect(SWIM_ROW_STATUS.info).toBe("unknown");
    expect(SWIM_ROW_TEXT.unknown).toBe("Unknown severity");
    expect(SWIMLANE_READOUT_ORDER).toBe(500);
  });
});

describeDom("timeline swimlane — AlertSwimlane (item 020)", (dom) => {
  const mounted: { unmount(): void }[] = [];
  const axes: TimeAxisController[] = [];
  const DAY_DOMAIN: TimeWindow = { start: TIMELINE_NOW_S - 86_400, end: TIMELINE_NOW_S };
  const tree = buildLaneTree(TIMELINE_INCIDENT.snapshot, TIMELINE_INCIDENT.index);

  beforeAll(() => {
  });

  afterEach(() => {
    while (mounted.length > 0) mounted.pop()!.unmount();
    while (axes.length > 0) axes.pop()!.dispose();
  });

  afterAll(() => {
  });

  function dayAxis(): TimeAxisController {
    const axis = createTimeAxis({ domain: signal(DAY_DOMAIN), initialZoom: null, initialStepSeconds: 145 });
    axes.push(axis);
    return axis;
  }

  async function mountSwim(o: {
    state: HistoryRegionState<IntervalHistoryPayload>;
    interactive?: boolean;
    onShorterRange?: (() => void) | null;
    axis?: TimeAxisController;
    readouts?: ReturnType<typeof createReadoutRegistry>;
  }): Promise<HTMLElement> {
    const m = await dom.mount(
      el(AlertSwimlane, {
        state: o.state,
        onRetry: () => {},
        onShorterRange: o.onShorterRange ?? null,
        tree,
        axis: o.axis ?? dayAxis(),
        readouts: o.readouts ?? createReadoutRegistry(),
        clock: CLOCK,
        interactive: o.interactive ?? true,
        readoutId: "pulse-timeline-readout",
        onNavigate: () => {},
      }),
    );
    mounted.push(m);
    await flush();
    return m.container;
  }

  const ready = (data: IntervalHistoryPayload): HistoryRegionState<IntervalHistoryPayload> => ({ phase: "ready", data });
  const PINNED = 'ul[aria-label="Alert intervals at the pinned time"]';

  test("REQ-SWIM-01/02/03, REQ-LANE-07: severity rows, packed sub-lanes with the +k badge, and unmatched outlines", async () => {
    const c = await mountSwim({ state: ready(TIMELINE_INCIDENT.alerts) });
    const heads = Array.from(c.querySelectorAll<HTMLElement>("[data-slot=timeline-swim-head][data-severity]"));
    expect(heads.map((hd) => hd.id)).toEqual(["swim-head-critical", "swim-head-warning", "swim-head-info", "swim-head-unknown"]);
    expect(heads.map((hd) => hd.querySelector("[data-slot=status-badge]")!.textContent)).toEqual([
      "Critical", "Warning", "Info", "Unknown severity",
    ]);
    // Heads render through the alert-severity map: the badge names the severity (info has its own tone).
    expect(heads.map((hd) => hd.querySelector("[data-slot=status-badge]")!.getAttribute("data-status"))).toEqual([
      "critical", "warning", "info", "unknown",
    ]);
    const tracks = Array.from(c.querySelectorAll<HTMLElement>("[data-swim-track]"));
    expect(tracks.map((t) => t.getAttribute("data-severity"))).toEqual(["critical", "warning", "info", "unknown"]);
    for (const t of tracks) {
      expect(t.getAttribute("role")).toBe("group");
      expect(t.getAttribute("tabindex")).toBe("0");
      expect(t.getAttribute("aria-labelledby")).toBe(`swim-head-${t.getAttribute("data-severity")}`);
      expect(t.getAttribute("aria-describedby")).toBe("timeline-swim-help");
    }
    expect(c.querySelector("#timeline-swim-help")!.textContent).toContain("Enter to open the alert in Alerts");

    // The fixture's six overlapping criticals: 4 sub-lanes, two folded into the last one.
    const critical = tracks[0]!;
    expect(critical.querySelectorAll('svg[role="img"] g[data-lane]').length).toBe(4);
    expect(critical.querySelector('svg[role="img"]')!.getAttribute("aria-label")).toBe("Critical alert intervals");
    expect(heads[0]!.querySelector("[data-slot=timeline-swim-overflow]")!.textContent).toBe("+2 overlapping");
    expect(heads[0]!.querySelector("[data-slot=timeline-swim-count]")!.textContent).toBe("6 intervals");
    expect(critical.querySelector("[data-deco=badge]")!.textContent).toBe("+2");
    expect(critical.querySelector("[data-slot=lane-decorations]")!.getAttribute("aria-hidden")).toBe("true");

    // The null-target DomainExpiring warning is unmatched: dashed outline + "1 unmatched target".
    expect(tracks[1]!.querySelectorAll("[data-deco=unmatched]").length).toBe(1);
    expect(heads[1]!.querySelector("[data-slot=timeline-swim-unmatched]")!.textContent).toBe("1 unmatched target");
    expect(heads[0]!.querySelector("[data-slot=timeline-swim-unmatched]")).toBeNull();

    // One overlay across the whole stack (desk).
    const overlays = c.querySelectorAll("[data-slot=timeline-plot-stack] > [data-slot=plot-overlay]");
    expect(overlays.length).toBe(1);
    expect(overlays[0]!.getAttribute("aria-label")).toBe("Alerts swimlane — time cursor");
    expect(overlays[0]!.getAttribute("aria-describedby")).toBe("pulse-timeline-readout");
  });

  test("REQ-SWIM-01: \"Unknown severity\" appears only when an unknown interval is present", async () => {
    const lanes = TIMELINE_INCIDENT.alerts.lanes.filter((l) => l.severity !== "unknown");
    const c = await mountSwim({ state: ready(makeAlertHistory("24h", lanes)) });
    const labels = Array.from(c.querySelectorAll("[data-slot=timeline-swim-head] [data-slot=status-badge]")).map((n) => n.textContent);
    expect(labels).toEqual(["Critical", "Warning", "Info"]);
    expect(c.textContent).not.toContain("Unknown severity");
  });

  test("REQ-SWIM-01: a ready payload with no lanes shows \"No alerts in range\"; loading and error never do", async () => {
    const empty = await mountSwim({ state: ready(makeAlertHistory("24h", [])) });
    const es = empty.querySelector('[data-slot=timeline-swimlane] [data-slot=empty-state][role="status"]')!;
    expect(es.textContent).toContain("No alerts in range");
    expect(es.textContent).toContain(
      `vmalert recorded no firing intervals between ${CLOCK.format(new Date(DAY_DOMAIN.start * 1000).toISOString())} and ${CLOCK.format(new Date(DAY_DOMAIN.end * 1000).toISOString())}.`,
    );
    expect(empty.querySelector("[data-swim-track]")).toBeNull();

    const loading = await mountSwim({ state: { phase: "loading", previous: null } });
    expect(loading.textContent).not.toContain("No alerts in range");
    const failed = await mountSwim({ state: { phase: "error", failure: classifyFailure("SOURCE_UNAVAILABLE", null), previous: null } });
    expect(failed.textContent).not.toContain("No alerts in range");
    expect(failed.querySelector("[data-history-phase=\"error\"]")).not.toBeNull();
  });

  test("REQ-HISTERR-04: HISTORY_LIMIT_EXCEEDED draws no severity rows; \"Try a shorter range\" only with onShorterRange", async () => {
    const failure = classifyFailure("HISTORY_LIMIT_EXCEEDED", null);
    expect(failure.kind).toBe("too-many");
    let shorter = 0;
    const withShorter = await mountSwim({ state: { phase: "error", failure, previous: null }, onShorterRange: () => shorter++ });
    expect(withShorter.querySelector("[data-swim-track]")).toBeNull();
    expect(withShorter.querySelector("[data-slot=timeline-swim-head]")).toBeNull();
    const btn = Array.from(withShorter.querySelectorAll("button")).find((b) => b.textContent === "Try a shorter range")!;
    expect(btn).toBeDefined();
    btn.click();
    expect(shorter).toBe(1);

    const without = await mountSwim({ state: { phase: "error", failure, previous: null }, onShorterRange: null });
    expect(without.querySelector("[data-swim-track]")).toBeNull();
    expect(without.textContent).not.toContain("Try a shorter range");
    expect(without.textContent).toContain(REGION_TEXT.tooManyNoShorter);
  });

  test("REQ-SWIM-05: the section is titled \"Alert history\" with provenance \"Alerts (vmalert)\"", async () => {
    for (const state of [ready(TIMELINE_INCIDENT.alerts), { phase: "loading", previous: null } as const]) {
      const c = await mountSwim({ state });
      const section = c.querySelector("section[data-slot=timeline-swimlane]")!;
      expect(section.getAttribute("aria-labelledby")).toBe("timeline-swim-title");
      expect(section.querySelector("h2#timeline-swim-title")!.textContent).toBe("Alert history");
      expect(section.querySelector("[data-slot=timeline-provenance]")!.textContent).toBe("Alerts (vmalert)");
    }
  });

  test("REQ-SWIM-04/REQ-A11Y-03: the \"swimlane\" readout source names the firing intervals, and a pin lists them with Open in Alerts links", async () => {
    const axis = dayAxis();
    const readouts = createReadoutRegistry();
    const c = await mountSwim({ state: ready(TIMELINE_INCIDENT.alerts), axis, readouts });
    const t = TIMELINE_NOW_S - 7_000;
    const entries = readouts.read(t).lanes;
    expect(entries.map((e) => e.label)).toEqual(["Critical alerts", "Warning alerts", "Info alerts", "Unknown severity alerts"]);
    expect(entries[0]!.status).toBe("critical");
    expect(entries[0]!.text).toContain("HostDown — ");
    expect(entries[0]!.text).toContain("+4 more");
    expect(entries[1]!.text).toBe("none firing");
    expect(entries[1]!.status).toBe("ok");
    expect(entries[1]!.group).toBeUndefined();
    expect(entries[0]!.group).toBeUndefined();
    // Firing info / unknown-severity rows keep the "unknown" fill status but name their own summary group.
    const info = readouts.read(TIMELINE_NOW_S - 27_500).lanes[2]!;
    expect([info.status, info.group, info.text.startsWith("BackupCompleted — ")]).toEqual(["unknown", "info", true]);
    const unknown = readouts.read(TIMELINE_NOW_S - 2_000).lanes[3]!;
    expect([unknown.status, unknown.group, unknown.text.startsWith("UnlabelledAlert — ")]).toEqual(["unknown", "unknown severity", true]);

    expect(c.querySelector(PINNED)).toBeNull();
    axis.cursor.value = t;
    await flush();
    expect(c.querySelector(PINNED)).toBeNull(); // unpinned cursor: no list
    axis.pinned.value = true;
    await flush();
    const list = c.querySelector<HTMLElement>(PINNED)!;
    expect(list.getAttribute("aria-label")).toBe("Alert intervals at the pinned time");
    const links = Array.from(list.querySelectorAll<HTMLAnchorElement>("a[href]"));
    expect(links.length).toBe(6);
    expect(links.every((a) => a.textContent === "Open in Alerts" && a.getAttribute("href")!.startsWith("/alerts?hs=host%3A") && !a.getAttribute("href")!.startsWith("/alerts?hs=host%3Ahost%3A"))).toBe(true);
  });

  test("REQ-KIOSK-03/REQ-SEC-02: interactive=false has no tab stops, overlay, tooltip or pinned list; markup renders literally", async () => {
    const hostile = "<img src=x onerror=alert(1)>";
    const lanes = [
      ...TIMELINE_INCIDENT.alerts.lanes,
      makeAlertLane({ alertname: hostile, severity: "warning", target: null, intervals: [[-1_000, -500]] }),
    ];
    const axis = dayAxis();
    const c = await mountSwim({ state: ready(makeAlertHistory("24h", lanes)), interactive: false, axis });
    const tracks = Array.from(c.querySelectorAll<HTMLElement>("[data-swim-track]"));
    expect(tracks.length).toBe(4);
    expect(tracks.every((t) => !t.hasAttribute("tabindex") && !t.hasAttribute("aria-describedby"))).toBe(true);
    expect(c.querySelector("[data-slot=plot-overlay]")).toBeNull();
    expect(c.querySelector("[data-slot=tooltip-trigger]")).toBeNull();
    expect(document.body.querySelector('[role="tooltip"]')).toBeNull();
    expect(c.querySelector("#timeline-swim-help")).toBeNull();
    axis.cursor.value = TIMELINE_NOW_S - 700;
    axis.pinned.value = true;
    await flush();
    expect(c.querySelector(PINNED)).toBeNull();
    expect(c.querySelector("img")).toBeNull();

    // Desk: the hostile alert name surfaces literally in the pinned list and never as markup.
    const desk = await mountSwim({ state: ready(makeAlertHistory("24h", lanes)), axis });
    await flush();
    const pinned = desk.querySelector(PINNED)!;
    expect(pinned.textContent).toContain(hostile);
    expect(desk.querySelector("img")).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------
// Item 021 — TargetDetail (07 §8)
// ---------------------------------------------------------------------------------------------------

describe("timeline detail — pure helpers (item 021)", () => {
  const snap = makeHierarchySnapshot({ hosts: 1, servicesPerHost: 1 });
  const host = buildLaneTree(snap, makeTimelineIndex(snap)).hosts[0]!;
  const svc = host.children[0]!;

  test("REQ-CHART-05/REQ-SEC-04: estateHref encodes every segment; a name with / ? # stays inside one segment", () => {
    expect(estateHref(host)).toBe(`/estate/host/${host.name}`);
    expect(estateHref(svc)).toBe(`/estate/service/${host.name}/${svc.name}`);
    const nasty = "a/b?c#d&e";
    expect(estateHref({ ...host, name: nasty })).toBe("/estate/host/a%2Fb%3Fc%23d%26e");
    const s = estateHref({ ...svc, hostName: "h/1", name: nasty });
    expect(s).toBe("/estate/service/h%2F1/a%2Fb%3Fc%23d%26e");
    const u = new URL(s, "http://pulse.invalid");
    expect(u.pathname.split("/")).toEqual(["", "estate", "service", "h%2F1", "a%2Fb%3Fc%23d%26e"]);
    expect(u.search).toBe("");
    expect(u.hash).toBe("");
  });

  test("REQ-CHART-05/REQ-SEC-04: safeGrafanaHref keeps only http:/https: URLs", () => {
    expect(safeGrafanaHref("https://grafana.example/d/abc?var-host=web01")).toBe("https://grafana.example/d/abc?var-host=web01");
    expect(safeGrafanaHref("http://grafana.lan:3000/d/x")).toBe("http://grafana.lan:3000/d/x");
    expect(safeGrafanaHref("javascript:alert(1)")).toBeNull();
    expect(safeGrafanaHref("data:text/html,<b>x</b>")).toBeNull();
    expect(safeGrafanaHref("not a url")).toBeNull();
    expect(safeGrafanaHref("/d/relative")).toBeNull();
    expect(safeGrafanaHref("")).toBeNull();
    expect(safeGrafanaHref(null)).toBeNull();
  });

  test("REQ-RANGE-02/REQ-CHART-02: copy constants", () => {
    expect(notAvailableAtRange("24h")).toBe("Not available at this range (max 24h)");
    expect(CHECK_LATENCY_UNAVAILABLE).toBe("Check latency history not available");
    expect(HOST_CHART_TITLE["host.load.1m"]).toBe("Load average (1m)");
    expect(CHART_READOUT_ORDER).toBe(1000);
  });
});

describeDom("timeline detail — TargetDetail (item 021)", (dom) => {
  const mounted: { unmount(): void }[] = [];
  const cleanups: (() => void)[] = [];
  const snap = makeHierarchySnapshot({ hosts: 2, servicesPerHost: 2 });
  const tree = buildLaneTree(snap, makeTimelineIndex(snap));
  const host = tree.hosts[0]!;
  const hostSeg = encodeURIComponent(host.target.id);

  beforeAll(() => {
  });

  afterEach(() => {
    while (mounted.length > 0) mounted.pop()!.unmount();
    while (cleanups.length > 0) cleanups.pop()!();
  });

  afterAll(() => {
  });

  function hostRoutes(range: "1h" | "7d" = "1h"): StubRoute[] {
    return HOST_CHART_QUERIES.map((q) => ({
      path: `/api/history/target/${hostSeg}/${q}`,
      reply: { status: 200, body: makeSeriesHistory(q, range, { target: host.target }) },
    }));
  }

  async function mountDetail(o: {
    node: LaneNode;
    range?: "1h" | "24h" | "7d";
    onClose?: () => void;
    reachable?: (key: string) => boolean;
  }): Promise<HTMLElement> {
    const axis = newAxis();
    cleanups.push(() => axis.dispose());
    const m = await dom.mount(
      el(TargetDetail, {
        node: o.node,
        range: o.range ?? "1h",
        end: TIMELINE_NOW_S,
        generation: "gen-1",
        queue: createRequestQueue(),
        axis,
        readouts: createReadoutRegistry(),
        clock: CLOCK,
        readoutId: "pulse-timeline-readout",
        onClose: o.onClose ?? (() => {}),
        reachable: o.reachable ?? (() => false),
      }),
    );
    mounted.push(m);
    await settle();
    return m.container;
  }

  const slots = (c: HTMLElement): HTMLElement[] => Array.from(c.querySelectorAll<HTMLElement>("[data-slot=timeline-chart-slot]"));

  test("REQ-CHART-02/04: a host advertising all four curated charts gets four slots in CPU, memory, disk, load order, one request each, no end=", async () => {
    expect(HOST_CHART_QUERIES.every((q) => host.queryIds.includes(q))).toBe(true);
    const stub = installHistoryStub(hostRoutes());
    cleanups.push(() => stub.restore());
    const c = await mountDetail({ node: host });

    const section = c.querySelector<HTMLElement>("section[data-slot=timeline-detail]")!;
    expect(section.getAttribute("data-target-kind")).toBe("host");
    expect(section.getAttribute("aria-labelledby")).toBe("timeline-detail-title");
    expect(section.querySelector("h2#timeline-detail-title")!.textContent).toBe(`Host ${host.name}`);
    expect(section.querySelector("[data-slot=chart-prefetch]")).not.toBeNull();

    const s = slots(c);
    expect(s.map((x) => x.getAttribute("data-query-id"))).toEqual([...HOST_CHART_QUERIES]);
    expect(s.map((x) => x.querySelector("h3")!.textContent)).toEqual([
      "CPU utilization", "Memory utilization", "Disk utilization", "Load average (1m)",
    ]);
    for (const x of s) {
      expect(x.querySelector("[data-history-phase]")!.getAttribute("data-history-phase")).toBe("ready");
      expect(x.querySelector("[data-slot=timeseries-plot]")).not.toBeNull();
    }
    for (const q of HOST_CHART_QUERIES) {
      expect(stub.calls.filter((u) => u === `/api/history/target/${hostSeg}/${q}?range=1h`).length).toBe(1);
    }
    expect(stub.calls.length).toBe(4);
    expect(stub.calls.some((u) => u.includes("end="))).toBe(false);
  });

  test("REQ-RANGE-02: at 7d the load slot reads \"Not available at this range (max 24h)\" and host.load.1m is never requested", async () => {
    const stub = installHistoryStub(hostRoutes("7d"));
    cleanups.push(() => stub.restore());
    const c = await mountDetail({ node: host, range: "7d" });
    const load = slots(c).find((x) => x.getAttribute("data-query-id") === "host.load.1m")!;
    expect(load.querySelector("h3")!.textContent).toBe("Load average (1m)");
    expect(load.querySelector("[data-history-phase]")!.getAttribute("data-history-phase")).toBe("not-applicable");
    expect(load.textContent).toContain("Not available at this range (max 24h)");
    expect(stub.calls.some((u) => u.includes("host.load.1m"))).toBe(false);
    expect(stub.calls.length).toBe(3);
    expect(stub.calls.every((u) => u.endsWith("?range=7d"))).toBe(true);
  });

  test("REQ-CHART-02 / REQ-ECR-C1: a service whose endpoints the index does not list shows \"Check latency history not available\" per endpoint with zero requests; empty states for no endpoints / no charts", async () => {
    const stub = installHistoryStub([]);
    cleanups.push(() => stub.restore());
    const svc = host.children[0]!;
    const two: LaneNode = { ...svc, endpoints: [...svc.endpoints, `${host.name}/extra`] };
    expect(svc.endpoints.length).toBe(1);
    const c = await mountDetail({ node: two });
    const section = c.querySelector<HTMLElement>("section[data-slot=timeline-detail]")!;
    expect(section.getAttribute("data-target-kind")).toBe("service");
    expect(section.querySelector("h2")!.textContent).toBe(`Service ${svc.name} on ${host.name}`);
    const s = slots(c);
    expect(s.length).toBe(2);
    expect(s.map((x) => x.querySelector("h3")!.textContent)).toEqual(two.endpoints.map((e) => `Check latency — ${e}`));
    for (const x of s) {
      expect(x.querySelector("[data-history-phase]")!.getAttribute("data-history-phase")).toBe("not-applicable");
      expect(x.textContent).toContain(CHECK_LATENCY_UNAVAILABLE);
    }
    // Reachability is checked before range: at 7d an unlisted endpoint still reads the reachability copy.
    const at7d = await mountDetail({ node: svc, range: "7d" });
    expect(at7d.textContent).toContain(CHECK_LATENCY_UNAVAILABLE);
    expect(at7d.textContent).not.toContain("Not available at this range");

    const noEndpoints = await mountDetail({ node: { ...svc, endpoints: [] } });
    expect(noEndpoints.textContent).toContain("No Gatus checks for this service");
    expect(noEndpoints.textContent).toContain("This service declares no Gatus endpoints, so there is no check latency to chart.");
    expect(slots(noEndpoints).length).toBe(0);

    const noCharts = await mountDetail({ node: { ...host, queryIds: ["estate.liveness"] } });
    expect(noCharts.textContent).toContain("No curated charts for this host");
    expect(noCharts.textContent).toContain("The timeline index advertises no capacity charts for this host.");
    expect(slots(noCharts).length).toBe(0);
    expect(stub.calls.length).toBe(0);
  });

  test("REQ-ECR-C1: a listed endpoint's latency chart requests /api/history/target/<host>%2F<svc>/endpoint.check.latency; an unlisted one issues nothing", async () => {
    const svc = host.children[0]!;
    const listed = svc.endpoints[0]!;
    expect(listed).toContain("/");
    const unlisted = `${host.name}/extra`;
    const latencyPath = `/api/history/target/${encodeURIComponent(listed)}/endpoint.check.latency`;
    expect(latencyPath).toContain("%2F");
    const stub = installHistoryStub([
      { path: latencyPath, reply: { status: 200, body: makeSeriesHistory("endpoint.check.latency", "1h", { target: { kind: "endpoint", id: listed } }) } },
    ]);
    cleanups.push(() => stub.restore());
    const c = await mountDetail({ node: { ...svc, endpoints: [listed, unlisted] }, reachable: (k) => k === listed });
    expect(stub.calls).toEqual([`${latencyPath}?range=1h`]);
    const [a, b] = slots(c) as [HTMLElement, HTMLElement];
    expect(a.textContent).not.toContain(CHECK_LATENCY_UNAVAILABLE);
    expect(a.querySelector("[data-history-phase]")!.getAttribute("data-history-phase")).toBe("ready");
    expect(b.textContent).toContain(CHECK_LATENCY_UNAVAILABLE);
    expect(b.querySelector("[data-history-phase]")!.getAttribute("data-history-phase")).toBe("not-applicable");
  });

  test("REQ-CHART-05/REQ-SEC-04: Estate link is encoded; the Grafana link appears only for http(s) with target=_blank rel=noopener noreferrer", async () => {
    const stub = installHistoryStub([]);
    cleanups.push(() => stub.restore());
    const bare: LaneNode = { ...host, name: "a/b?c#d", queryIds: [] };
    const links = (c: HTMLElement): HTMLAnchorElement[] =>
      Array.from(c.querySelectorAll<HTMLAnchorElement>('nav[aria-label="Links for this target"] a'));

    const https = await mountDetail({ node: { ...bare, grafanaUrl: "https://grafana.example/d/hosts?var-host=web01" } });
    const [estate, grafana] = links(https);
    expect(https.querySelector("nav")!.getAttribute("aria-label")).toBe("Links for this target");
    expect(estate!.textContent).toBe("Open in Estate");
    expect(estate!.getAttribute("href")).toBe("/estate/host/a%2Fb%3Fc%23d");
    expect(estate!.hasAttribute("target")).toBe(false);
    expect(grafana!.textContent).toContain("Open in Grafana");
    expect(grafana!.getAttribute("data-slot")).toBe("external-link");
    expect(grafana!.getAttribute("href")).toBe("https://grafana.example/d/hosts?var-host=web01");
    expect(grafana!.getAttribute("target")).toBe("_blank");
    expect(grafana!.getAttribute("rel")).toBe("noopener noreferrer");
    expect(grafana!.querySelector("svg")!.getAttribute("aria-hidden")).toBe("true");

    const http = await mountDetail({ node: { ...bare, grafanaUrl: "http://grafana.lan/d/x" } });
    expect(links(http).length).toBe(2);
    for (const url of ["javascript:alert(1)", "::not a url::", null]) {
      const c = await mountDetail({ node: { ...bare, grafanaUrl: url } });
      expect(links(c).map((a) => a.textContent)).toEqual(["Open in Estate"]);
    }
  });

  test("REQ-CHART-01: \"Close detail\" calls onClose", async () => {
    const stub = installHistoryStub([]);
    cleanups.push(() => stub.restore());
    let closed = 0;
    const c = await mountDetail({ node: { ...host, queryIds: [] }, onClose: () => closed++ });
    const btn = buttonNamed(c, "Close detail")!;
    expect(btn.textContent).toBe("Close detail");
    expect(btn.getAttribute("type")).toBe("button");
    btn.click();
    expect(closed).toBe(1);
  });

  test("REQ-OBS-01: a render throw in one chart slot shows \"This panel failed to render\" in that slot only", async () => {
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    cleanups.push(() => errSpy.mockRestore());
    const stub = installHistoryStub(hostRoutes());
    const stubFetch = globalThis.fetch;
    cleanups.push(() => stub.restore());
    // The memory payload throws when the chart adapter reads its series (inside SyncedChart's render).
    globalThis.fetch = (async (input: unknown, init?: unknown) => {
      const res = await (stubFetch as unknown as (i: unknown, n?: unknown) => Promise<Response>)(input, init);
      if (!String(input).includes("host.memory.utilization")) return res;
      const body = (await res.json()) as Record<string, unknown>;
      const hostile = Object.defineProperty({ ...body }, "series", {
        get(): never {
          throw new Error("detail render fault");
        },
      });
      return { status: res.status, ok: res.ok, headers: res.headers, json: async () => hostile } as unknown as Response;
    }) as unknown as typeof fetch;

    const c = await mountDetail({ node: host });
    const s = slots(c);
    const bySlot = new Map(s.map((x) => [x.getAttribute("data-query-id"), x] as const));
    // The faulted slot's boundary replaced its whole chart-slot div with the fault EmptyState.
    expect(bySlot.has("host.memory.utilization")).toBe(false);
    const charts = c.querySelector<HTMLElement>("[data-slot=timeline-detail-charts]")!;
    const faults = charts.querySelectorAll("[data-slot=region-fault]");
    expect(faults.length).toBe(1);
    expect(faults[0]!.textContent).toContain("This panel failed to render");
    expect(faults[0]!.textContent).toContain("Memory utilization");
    // Fault sits in the second position, between CPU and disk.
    expect(Array.from(charts.children).indexOf(faults[0]! as Element)).toBe(1);
    for (const q of ["host.cpu.utilization", "host.disk.utilization", "host.load.1m"]) {
      const x = bySlot.get(q)!;
      expect(x.textContent).not.toContain("This panel failed to render");
      expect(x.querySelector("[data-slot=timeseries-plot]")).not.toBeNull();
    }
    expect(errSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------------------------------
// Item 022 — the mounted TimelineView (07 §3, 08 §4.1 router and kiosk setup)
// ---------------------------------------------------------------------------------------------------

describeDom("timeline view — TimelineView (item 022)", (dom) => {
  interface MountOptions {
    readonly search?: string;
    readonly rotation?: ViewRotationContext | null;
    readonly snapshot?: OverviewSnapshotV2;
    readonly index?: TimelinePayload | null;
    readonly routes?: readonly StubRoute[];
    /** Install no stub (the test installs its own fetch). */ readonly noStub?: boolean;
    readonly phase?: "initial" | "current" | "stale";
    /** Microtask-only settle (fake timers). */ readonly fake?: boolean;
    readonly store?: (s: AppStore) => void;
  }
  interface Mounted {
    readonly container: HTMLElement;
    readonly store: AppStore;
    readonly router: PathRouter;
    readonly stub: ReturnType<typeof installHistoryStub> | null;
    /** Every router.navigate call: [path, replace]. */ readonly navs: (readonly [string, boolean])[];
    unmount(): void;
  }

  let savedGlobalRaf: PropertyDescriptor | undefined;
  const live: Mounted[] = [];
  const cleanups: (() => void)[] = [];

  beforeAll(() => {
    const g = globalThis as unknown as { requestAnimationFrame?: unknown };
    savedGlobalRaf = Object.getOwnPropertyDescriptor(g, "requestAnimationFrame");
    g.requestAnimationFrame = (cb: (t: number) => void): number => {
      queueMicrotask(() => cb(0));
      return 0;
    };
  });

  afterAll(() => {
    const g = globalThis as unknown as Record<string, unknown>;
    if (savedGlobalRaf !== undefined) Object.defineProperty(g, "requestAnimationFrame", savedGlobalRaf);
    else delete g["requestAnimationFrame"];
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

  const SMALL = TIMELINE_INCIDENT;
  const hostKeyOf = (snap: OverviewSnapshotV2, i: number): string => `host:${snap.hosts[i]!.drilldownId}`;

  function defaultRoutes(alertsBody: unknown = SMALL.alerts, extra: readonly StubRoute[] = []): StubRoute[] {
    return [
      { path: "/api/history/alerts", reply: { status: 200, body: alertsBody } },
      { path: "/api/history/estate/engine.active-series", reply: { status: 200, body: makeSeriesHistory("engine.active-series", "24h") } },
      { path: "/api/history/target/", reply: { status: 200, body: makeSeriesHistory("host.cpu.utilization", "24h") } },
      ...extra,
    ];
  }

  async function micro(rounds = 80): Promise<void> {
    await act(async () => {
      for (let i = 0; i < rounds; i++) await Promise.resolve();
    });
  }

  /** 08 §4.1 router and kiosk setup for /timeline. */
  async function mountView(o: MountOptions = {}): Promise<Mounted> {
    const { default: TimelineView } = await import("../src/client/views/timeline/view.js");
    const stub = o.noStub === true ? null : installHistoryStub(o.routes ?? defaultRoutes());
    const win = dom.win as unknown as Window;
    win.history.replaceState({}, "", "/timeline" + (o.search ?? ""));
    const router = createPathRouter({ routes: [{ pattern: "/timeline", view: "timeline" }], fallback: "/timeline", win });
    const kiosk = (o.search ?? "").includes("kiosk=1");
    const store = createAppStore({ storage: null, initialQuery: kiosk ? { kiosk: "1" } : {} });
    store.route.value = router.current();
    const off = router.subscribe((m) => {
      store.route.value = m;
    });
    const snapshot = o.snapshot ?? SMALL.snapshot;
    store.snapshot.value = snapshot;
    store.timeline.value = o.index === undefined ? makeTimelineIndex(snapshot) : o.index;
    store.connection.value = {
      ...store.connection.value,
      phase: "live",
      observation: makeObservation({ generation: "gen-1" }),
      views: { ...store.connection.value.views, timeline: delivery(o.phase ?? "current") },
    };
    o.store?.(store);
    const navs: (readonly [string, boolean])[] = [];
    const realNavigate = router.navigate.bind(router);
    (router as { navigate: PathRouter["navigate"] }).navigate = (path, opts) => {
      navs.push([path, opts?.replace === true]);
      realNavigate(path, opts);
    };
    const { container, unmount } = await dom.mount(el(TimelineView, { store, router, rotation: o.rotation ?? null }));
    if (o.fake === true) await micro();
    else await settle();
    const m: Mounted = {
      container, store, router, stub, navs,
      unmount(): void {
        unmount();
        off();
        router.stop();
        stub?.restore();
      },
    };
    live.push(m);
    return m;
  }

  const all = (c: ParentNode, sel: string): HTMLElement[] => Array.from(c.querySelectorAll<HTMLElement>(sel));
  const query = (): URLSearchParams => new URLSearchParams((dom.win as unknown as Window).location.search);
  const count = (calls: readonly string[], prefix: string): number => calls.filter((u) => u.startsWith(prefix)).length;
  const ALERTS = "/api/history/alerts";
  const COVERAGE = "/api/history/estate/engine.active-series";
  const CHECKS = "/api/history/checks/";

  function key(target: Element, k: string, init: { readonly shiftKey?: boolean } = {}): KeyboardEvent {
    const K = (dom.win as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent;
    const e = new K("keydown", { key: k, bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(e);
    return e;
  }
  const radio = (c: ParentNode, label: string): HTMLElement =>
    all(c, '[role="radio"]').find((b) => b.textContent === label)!;
  const button = (c: ParentNode, label: string): HTMLButtonElement =>
    all(c, "button").find((b) => (b.textContent ?? "").trim() === label) as HTMLButtonElement;
  const hostRowKeys = (c: ParentNode): string[] =>
    all(c, '[data-tree-row][data-level="1"]').map((r) => r.getAttribute("data-lane-key") ?? "");

  // --- boundaries (REQ-OBS-01) ------------------------------------------------------------------------

  test("REQ-OBS-01: a body throw shows the view boundary; a throw inside one region shows the region boundary there only", async () => {
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    cleanups.push(() => errSpy.mockRestore());

    // 1. The whole body throws (the timeline store signal itself faults).
    const m1 = await mountView({
      store: (s) => {
        Object.defineProperty(s, "timeline", { value: { get value(): never { throw new Error("boom"); }, peek(): never { throw new Error("boom"); } } });
      },
    });
    expect(m1.container.textContent).toContain("The timeline view hit a rendering error");
    expect(m1.container.querySelector("[data-slot=timeline-page][data-state=error] [role=alert]")).not.toBeNull();
    m1.unmount();
    live.splice(live.indexOf(m1), 1);

    // 2. Only the swimlane reads an unmatched lane's alertname: a throwing getter faults that region only.
    const lane = { ...makeAlertLane({ alertname: "x", severity: "critical", target: null, intervals: [[-900, -300]] }) };
    Object.defineProperty(lane, "alertname", { enumerable: true, get(): never { throw new Error("region fault"); } });
    const payload = { ...makeAlertHistory("24h", []), lanes: [lane] };
    const stub = installHistoryStub(defaultRoutes());
    const stubFetch = globalThis.fetch;
    globalThis.fetch = ((input: unknown, init?: RequestInit) => {
      const url = typeof input === "string" ? input : String(input);
      if (url.startsWith(ALERTS)) {
        return Promise.resolve({ status: 200, ok: true, headers: new Headers(), json: async () => payload } as unknown as Response);
      }
      return stubFetch(input as string, init);
    }) as typeof fetch;
    cleanups.push(() => stub.restore());
    const m2 = await mountView({ noStub: true });
    const faults = all(m2.container, "[data-slot=region-fault]");
    expect(faults.length).toBe(1);
    expect(faults[0]!.textContent).toContain("This panel failed to render");
    expect(faults[0]!.textContent).toContain("Alert history");
    expect(m2.container.textContent).not.toContain("The timeline view hit a rendering error");
    expect(m2.container.querySelector("[data-slot=timeline-lanes]")).not.toBeNull();
    expect(m2.container.querySelector("[data-slot=timeline-controls]")).not.toBeNull();
  });

  // --- defaults, fallbacks, writes (REQ-RANGE-01, REQ-URL-01/02) --------------------------------------

  test("REQ-RANGE-01: a fresh /timeline is 24h and live — the 24h radio is aria-checked, 'Live' and a 'Pause' button", async () => {
    const m = await mountView();
    expect(radio(m.container, "24h").getAttribute("aria-checked")).toBe("true");
    expect(all(m.container, '[role="radio"][aria-checked="true"]').length).toBe(1);
    expect(m.container.querySelector("[data-live]")!.textContent).toContain("Live");
    expect(button(m.container, "Pause")).toBeDefined();
    expect(m.navs).toEqual([]); // a default URL is already canonical
  });

  test("not-current banner: a stale connection shows a role=status callout with a 'Not current' badge and the unchanged text", async () => {
    const m = await mountView({
      store: (st) => {
        st.connection.value = { ...st.connection.value, phase: "stale" };
      },
    });
    const c = m.container;
    const banner = Array.from(c.querySelectorAll<HTMLElement>('[role="status"]')).find((r) =>
      (r.textContent ?? "").includes("Timeline index not current since"),
    )!;
    expect(banner).toBeDefined();
    expect(banner.getAttribute("data-slot")).toBe("callout");
    const badge = banner.querySelector("[data-slot=status-badge]")!;
    expect(badge.textContent).toBe("Not current");
    expect(badge.getAttribute("data-tone")).toBe("neutral");
    expect(banner.textContent).toContain("Timeline index not current since ");
    expect(banner.textContent).not.toContain("since —"); // the index is held: its generatedAt is shown
  });

  test("page frame: data-slot=timeline-page with one h1 'Timeline'; desk controls in the page header; sticky readout slot and hints below", async () => {
    const m = await mountView();
    const c = m.container;
    const page = c.querySelector<HTMLElement>("[data-slot=timeline-page]")!;
    expect(page).not.toBeNull();
    expect(page.hasAttribute("data-kiosk")).toBe(false);
    expect(pageHeadings(c).map((h) => h.textContent)).toEqual(["Timeline"]);
    const header = page.querySelector("[data-slot=page-header]")!;
    expect(header.querySelector("h1")!.textContent).toBe("Timeline");
    expect(rangeGroup(header)).not.toBeNull();
    expect(checkedRange(header)).toBe("24h");
    expect(buttonNamed(header, "Pause")!.getAttribute("aria-keyshortcuts")).toBe("l");
    expect(buttonNamed(header, "Reset zoom")!.getAttribute("aria-keyshortcuts")).toBe("0");
    expect(rangeGroup(header)!.closest("[aria-keyshortcuts]")).toBeNull();
    for (const radio of rangeGroup(header)!.querySelectorAll('[role="radio"]')) {
      expect(radio.getAttribute("aria-keyshortcuts")).toBe("[ ]");
    }
    const slot = page.querySelector("[data-slot=timeline-readout-slot]")!;
    expect(slot.querySelector("[data-slot=cursor-readout]")).not.toBeNull();
    expect(page.querySelector("details[data-slot=timeline-kbd-hints]")).not.toBeNull();
  });

  test("REQ-URL-02: ?range=90d, ?zoom=garbage and an unknown ?sel fall back with a visible notice and never throw", async () => {
    const a = await mountView({ search: "?range=90d&foo=bar" });
    expect(radio(a.container, "24h").getAttribute("aria-checked")).toBe("true");
    expect(a.container.querySelector('[data-notice-key="range"]')!.textContent).toContain("90d");
    // The canonical rewrite drops the bad value with replace; the notice survives it.
    expect(a.navs.length).toBe(1);
    expect(a.navs[0]![1]).toBe(true);
    expect(query().get("range")).toBeNull();
    expect(query().get("foo")).toBe("bar");
    a.unmount();
    live.splice(live.indexOf(a), 1);

    const b = await mountView({ search: "?zoom=garbage" });
    expect(b.container.querySelector('[data-notice-key="zoom"]')).not.toBeNull();
    expect(button(b.container, "Reset zoom").disabled).toBe(true);
    b.unmount();
    live.splice(live.indexOf(b), 1);

    const c = await mountView({ search: "?sel=host:host:nope" });
    expect(c.container.querySelector('[data-notice-key="sel"]')!.textContent).toContain("host:nope");
    expect(c.container.querySelector("[data-slot=timeline-detail]")).toBeNull();
    expect(c.container.textContent).not.toContain("The timeline view hit a rendering error");
  });

  test("REQ-URL-01: range, select, pause and resume push; pin, zoom and reset replace; unrelated keys and rotate survive every write", async () => {
    const m = await mountView({ search: "?foo=bar&rotate=overview,timeline" });
    const c = m.container;
    const survives = (): void => {
      expect(query().get("foo")).toBe("bar");
      expect(query().get("rotate")).toBe("overview,timeline");
    };

    radio(c, "6h").click();
    await settle();
    expect(m.navs.at(-1)![1]).toBe(false);
    expect(query().get("range")).toBe("6h");
    survives();

    const firstHost = c.querySelector<HTMLElement>('[data-tree-row][data-level="1"]')!;
    key(firstHost, "Enter");
    await settle();
    expect(m.navs.at(-1)![1]).toBe(false);
    expect(query().get("sel")).toBe(firstHost.getAttribute("data-lane-key"));
    expect(c.querySelector("[data-slot=timeline-detail]")).not.toBeNull();
    survives();

    button(c, "Pause").click();
    await settle();
    expect(m.navs.at(-1)![1]).toBe(false);
    expect(query().get("end")).toBe(String(TIMELINE_NOW_S));
    survives();

    button(c, "Paused — resume live").click();
    await settle();
    expect(m.navs.at(-1)![1]).toBe(false);
    expect(query().get("end")).toBeNull();
    survives();

    // Pin while live (Enter on a focused overlay) → end written with replace.
    const overlay = (): HTMLElement => c.querySelector<HTMLElement>('[data-slot=plot-overlay][data-state="active"]')!;
    key(overlay(), "Enter");
    await settle();
    expect(m.navs.at(-1)![1]).toBe(true);
    expect(query().get("end")).toBe(String(TIMELINE_NOW_S));
    survives();

    key(overlay(), "Escape"); // unpin (does not resume)
    key(overlay(), "+");
    await settle();
    expect(m.navs.at(-1)![1]).toBe(true);
    expect(query().get("zoom")).toMatch(/^\d+-\d+$/);
    expect(button(c, "Reset zoom").disabled).toBe(false);
    survives();

    button(c, "Reset zoom").click();
    await settle();
    expect(m.navs.at(-1)![1]).toBe(true);
    expect(query().get("zoom")).toBeNull();
    expect(query().get("end")).toBe(String(TIMELINE_NOW_S)); // reset keeps the pause
    survives();
  });

  test("REQ-URL-01: back/forward restores zoom and sel from the URL without extra navigations", async () => {
    const m = await mountView({ search: "?foo=bar" });
    const c = m.container;
    expect(c.querySelector("[data-slot=timeline-detail]")).toBeNull();
    const before = m.navs.length;
    const win = dom.win as unknown as Window;
    const E = TIMELINE_NOW_S;
    const sel = hostKeyOf(SMALL.snapshot, 1);
    win.history.replaceState({}, "", `/timeline?foo=bar&end=${E}&zoom=${E - 7200}-${E - 3600}&sel=${encodeURIComponent(sel)}`);
    win.dispatchEvent(new (dom.win as unknown as { PopStateEvent: typeof PopStateEvent }).PopStateEvent("popstate"));
    await settle();
    expect(button(c, "Reset zoom").disabled).toBe(false);
    expect(c.querySelector("[data-slot=timeline-detail]")).not.toBeNull();
    expect(c.querySelector("[data-live]")!.textContent).toContain("Showing until");
    expect(m.navs.length).toBe(before); // no URL↔axis loop

    win.history.replaceState({}, "", "/timeline?foo=bar");
    win.dispatchEvent(new (dom.win as unknown as { PopStateEvent: typeof PopStateEvent }).PopStateEvent("popstate"));
    await settle();
    expect(button(c, "Reset zoom").disabled).toBe(true);
    expect(c.querySelector("[data-slot=timeline-detail]")).toBeNull();
    expect(m.navs.length).toBe(before);
  });

  // --- live follow (REQ-FOLLOW-01..03, REQ-ZOOM-03) --------------------------------------------------

  test("REQ-FOLLOW-01..03 / REQ-ZOOM-03: one alerts + one coverage request per LIVE_REFRESH_MS; pause and paused issue none; resume refetches at once; lanes never blank", async () => {
    // Bun's advanceTimersByTime moves Date.now to (real start + elapsed), so times here derive from Date.now().
    jest.useFakeTimers();
    // The fixtures are pinned to TIMELINE_NOW_S; move them onto the real clock so the test does not
    // start failing once wall time passes the 24h window.
    const shift = Math.floor(Date.now() / 1000) - TIMELINE_NOW_S;
    const routes: StubRoute[] = [
      { path: ALERTS, reply: { status: 200, body: shiftFixtureTimes(SMALL.alerts, shift) }, delayMs: 1_000 },
      { path: COVERAGE, reply: { status: 200, body: shiftFixtureTimes(makeSeriesHistory("engine.active-series", "24h"), shift) } },
    ];
    const m = await mountView({ routes, fake: true });
    const c = m.container;
    const calls = m.stub!.calls;
    jest.advanceTimersByTime(1_000);
    await micro();
    expect([count(calls, ALERTS), count(calls, COVERAGE)]).toEqual([1, 1]);
    const criticalRows = (): number => all(c, '[data-tree-row][data-status="critical"]').length;
    expect(criticalRows()).toBeGreaterThan(0);
    const swimTracks = (): number => all(c, "[data-swim-track]").length;
    expect(swimTracks()).toBeGreaterThan(0);

    // One live tick: exactly one more of each; the old lanes stay drawn while the refresh is pending.
    jest.advanceTimersByTime(LIVE_REFRESH_MS - 1_000);
    const tickEnd = Math.floor(Date.now() / 1000); // the live anchor the tick just set
    await micro();
    expect([count(calls, ALERTS), count(calls, COVERAGE)]).toEqual([2, 2]);
    expect(criticalRows()).toBeGreaterThan(0);
    expect(swimTracks()).toBeGreaterThan(0);
    jest.advanceTimersByTime(1_000);
    await micro();
    expect(criticalRows()).toBeGreaterThan(0);

    // Pause writes end = the current domain end and issues nothing.
    button(c, "Pause").click();
    await micro();
    expect(query().get("end")).toBe(String(tickEnd));
    expect(m.navs.at(-1)![1]).toBe(false);
    expect([count(calls, ALERTS), count(calls, COVERAGE)]).toEqual([2, 2]);

    // Paused: nothing after 2 × LIVE_REFRESH_MS.
    jest.advanceTimersByTime(2 * LIVE_REFRESH_MS);
    await micro();
    expect([count(calls, ALERTS), count(calls, COVERAGE)]).toEqual([2, 2]);

    // Resume refetches immediately (createLiveFollow's 0 ms tick).
    button(c, "Paused — resume live").click();
    await micro();
    jest.advanceTimersByTime(0);
    await micro();
    expect([count(calls, ALERTS), count(calls, COVERAGE)]).toEqual([3, 3]);
    expect(query().get("end")).toBeNull();
    expect(criticalRows()).toBeGreaterThan(0);
  });

  // --- requests at the envelope (REQ-LANE-01..06, REQ-RANGE-02, REQ-SCALE-01) -----------------------

  test("REQ-LANE-01..06 / REQ-SCALE-01 / REQ-ECR-C1: at the envelope — one coverage and one alerts request, no target/checks until a host expands, then one checks request per listed service endpoint, ≤ 4 in flight", async () => {
    const routes: StubRoute[] = [
      { path: ALERTS, reply: { status: 200, body: TIMELINE_ENVELOPE.alerts }, delayMs: 5 },
      { path: COVERAGE, reply: { status: 200, body: makeSeriesHistory("engine.active-series", "24h") }, delayMs: 5 },
      { path: CHECKS, reply: { status: 200, body: makeEndpointHistory("any") }, delayMs: 5 },
    ];
    let maxInFlight = 0;
    const m = await mountView({ snapshot: TIMELINE_ENVELOPE.snapshot, index: TIMELINE_ENVELOPE.index, routes });
    const stub = m.stub!;
    for (let i = 0; i < 10; i++) {
      maxInFlight = Math.max(maxInFlight, stub.inFlight());
      await settle();
    }
    expect(stub.calls.slice().sort()).toEqual([`${ALERTS}?range=24h`, `${COVERAGE}?range=24h`]);
    expect(stub.calls.some((u) => u.includes("/target/") || u.includes("/checks/"))).toBe(false);
    expect(hostRowKeys(m.container).length).toBe(100); // 100 hosts; no domains declared → no Domains header (09 §3)

    // Expanding a host (→ on a host with services) mounts service rows and loads their listed check history.
    const host = m.container.querySelector<HTMLElement>('[data-tree-row][aria-expanded="false"]')!;
    const hostKey = host.getAttribute("data-lane-key")!;
    const snapHost = TIMELINE_ENVELOPE.snapshot.hosts.find((x) => `host:${x.drilldownId}` === hostKey)!;
    key(host, "ArrowRight");
    for (let i = 0; i < 6; i++) {
      maxInFlight = Math.max(maxInFlight, stub.inFlight());
      await settle();
    }
    expect(all(m.container, '[data-tree-row][data-level="2"]').length).toBeGreaterThan(0);
    const expected = snapHost.services.map((s) => `${CHECKS}${encodeURIComponent(`${snapHost.name}/${s.name}`)}?range=24h`).sort();
    expect(expected.length).toBe(3);
    expect(stub.calls.filter((u) => u.startsWith(CHECKS)).sort()).toEqual(expected);
    expect(stub.calls.length).toBe(2 + expected.length);
    expect(maxInFlight).toBeLessThanOrEqual(4);
  }, 30_000); // 100-host envelope: well inside the default on an idle host, not under a loaded one

  test("REQ-ECR-C1/C2: expanding a host requests /api/history/checks/<host>%2F<svc> for a listed endpoint and the service lane shows check evidence, not 'check history not available'", async () => {
    const snapshot = makeHierarchySnapshot({ hosts: 1, servicesPerHost: 2 });
    const snapHost = snapshot.hosts[0]!;
    const [listedSvc, unlistedSvc] = snapHost.services as [(typeof snapHost.services)[number], (typeof snapHost.services)[number]];
    const listed = `${snapHost.name}/${listedSvc.name}`;
    const unlisted = `${snapHost.name}/${unlistedSvc.name}`;
    const base = makeTimelineIndex(snapshot);
    // The index does not list the second service's endpoint (e.g. an ambiguous key).
    const index = {
      ...base,
      targets: base.targets.filter((t) => !(t.target.kind === "endpoint" && t.target.id === unlisted)),
      checkHistory: { ...base.checkHistory, endpoints: base.checkHistory.endpoints.filter((e) => e !== unlisted) },
    };
    const failing = makeEndpointHistory(listed, { results: Array.from({ length: 30 }, (_, i) => [-1_800 + i * 60, false] as const) });
    const listedPath = `${CHECKS}${encodeURIComponent(listed)}`;
    expect(listedPath).toBe(`${CHECKS}${snapHost.name}%2F${listedSvc.name}`);
    const m = await mountView({
      snapshot,
      index,
      routes: [
        { path: ALERTS, reply: { status: 200, body: makeAlertHistory("24h", []) } },
        { path: COVERAGE, reply: { status: 200, body: makeSeriesHistory("engine.active-series", "24h") } },
        { path: listedPath, reply: { status: 200, body: failing } },
      ],
    });
    const stub = m.stub!;
    expect(count(stub.calls, CHECKS)).toBe(0);

    const hostRow = m.container.querySelector<HTMLElement>(`[data-tree-row][data-lane-key="${hostKeyOf(snapshot, 0)}"]`)!;
    key(hostRow, "ArrowRight");
    await settle();
    await settle();
    expect(stub.calls.filter((u) => u.startsWith(CHECKS))).toEqual([`${listedPath}?range=24h`]);

    const row = (svcId: string): HTMLElement =>
      m.container.querySelector<HTMLElement>(`[data-tree-row][data-lane-key="service:${svcId}"]`)!;
    const listedRow = row(listedSvc.drilldownId);
    expect(listedRow.textContent).not.toContain(CHECK_HISTORY_UNAVAILABLE_TEXT);
    expect(listedRow.getAttribute("data-status")).toBe("critical"); // from the failing check results; no alerts
    const unlistedRow = row(unlistedSvc.drilldownId);
    expect(unlistedRow.textContent).toContain(CHECK_HISTORY_UNAVAILABLE_TEXT);
  });

  /** Mount the view over a 1-host index declaring example.com (failing DNS check) and example.org (healthy). */
  async function mountWithDomains(search = ""): Promise<Mounted> {
    const snapshot = makeHierarchySnapshot({ hosts: 1, servicesPerHost: 1 });
    const index = makeTimelineIndex(snapshot, { domains: ["example.com", "example.org"] });
    const failing = makeEndpointHistory("dns:example.com", { results: Array.from({ length: 30 }, (_, i) => [-1_800 + i * 60, false] as const) });
    return mountView({
      snapshot,
      index,
      search,
      routes: [
        { path: ALERTS, reply: { status: 200, body: makeAlertHistory(search.includes("range=6h") ? "6h" : "24h", []) } },
        { path: COVERAGE, reply: { status: 200, body: makeSeriesHistory("engine.active-series", "24h") } },
        { path: `${CHECKS}dns%3Aexample.com`, reply: { status: 200, body: failing } },
        { path: `${CHECKS}dns%3Aexample.org`, reply: { status: 200, body: makeEndpointHistory("dns:example.org") } },
      ],
    });
  }

  test("REQ-ECR-C3: the collapsed Domains header loads /api/history/checks/dns%3A<domain> and shows the worst status; expanding lists the domains with their DNS-check status", async () => {
    const m = await mountWithDomains();
    await settle();
    const c = m.container;
    const checks = m.stub!.calls.filter((u) => u.startsWith(CHECKS)).sort();
    expect(checks).toEqual([`${CHECKS}dns%3Aexample.com?range=24h`, `${CHECKS}dns%3Aexample.org?range=24h`]);
    const header = c.querySelector<HTMLElement>('[data-tree-row][data-lane-key="domains"]')!;
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(header.getAttribute("data-status")).toBe("critical"); // worst of example.com (failing) and example.org
    expect(header.textContent).not.toContain(CHECK_HISTORY_UNAVAILABLE_TEXT);
    expect(c.querySelector('[data-lane-key^="endpoint:"]')).toBeNull();

    key(header, "ArrowRight");
    await settle();
    const rows = all(c, '[data-tree-row][data-lane-key^="endpoint:"]');
    expect(rows.map((r) => r.querySelector("[data-slot=timeline-lane-name]")!.textContent)).toEqual(["example.com", "example.org"]);
    // example.org's checks are healthy but cover only the recent part of the 24h window; with no alert
    // evidence for a domain, the uncovered span is no data (REQ-LANE-03), so its worst-in-view is unknown.
    expect(rows.map((r) => r.getAttribute("data-status"))).toEqual(["critical", "unknown"]);
    expect(rows.every((r) => r.textContent!.includes("DNS check"))).toBe(true);
    expect(c.textContent).not.toContain("Check history is not available for domain checks.");
    // Expanding issues no further request: domain checks were already loading while collapsed.
    expect(m.stub!.calls.filter((u) => u.startsWith(CHECKS)).length).toBe(2);
  });

  test("REQ-ECR-C3: domain rows are keyboard-reachable, ← returns to the header, and Enter/Space/click never select (no sel, no detail)", async () => {
    const m = await mountWithDomains();
    const c = m.container;
    const header = c.querySelector<HTMLElement>('[data-tree-row][data-lane-key="domains"]')!;
    key(header, "Enter"); // Enter on the header toggles the group
    await settle();
    const rows = all(c, '[data-tree-row][data-lane-key^="endpoint:"]');
    expect(rows.length).toBe(2);
    header.focus();
    key(header, "ArrowRight"); // expanded header → first child
    await settle();
    expect(c.ownerDocument.activeElement?.getAttribute("data-lane-key")).toBe("endpoint:dns:example.com");
    key(rows[0]!, "ArrowDown");
    await settle();
    expect(c.ownerDocument.activeElement?.getAttribute("data-lane-key")).toBe("endpoint:dns:example.org");
    const navs = m.navs.length;
    for (const k of ["Enter", " "]) expect(key(rows[1]!, k).defaultPrevented).toBe(false);
    rows[1]!.click();
    await settle();
    expect(m.navs.length).toBe(navs);
    expect(query().get("sel")).toBeNull();
    expect(c.querySelector("[data-slot=timeline-detail]")).toBeNull();
    expect(rows[1]!.hasAttribute("aria-selected")).toBe(false);
    key(rows[1]!, "ArrowLeft");
    await settle();
    expect(c.ownerDocument.activeElement?.getAttribute("data-lane-key")).toBe("domains");
  });

  test("REQ-ECR-C3 / REQ-KIOSK-03: kiosk shows the Domains header only (collapsed, with a status), never its domain rows", async () => {
    const m = await mountWithDomains("?kiosk=1");
    await settle();
    const c = m.container;
    const header = c.querySelector<HTMLElement>('[data-lane-key="domains"]')!;
    expect(header.getAttribute("role")).toBe("listitem");
    expect(header.getAttribute("data-status")).toBe("critical");
    expect(c.querySelector('[data-lane-key^="endpoint:"]')).toBeNull();
  });

  test("REQ-ECR-C3: an index with no domains hides the Domains group and issues no DNS check request", async () => {
    const m = await mountView({});
    expect(m.container.querySelector('[data-lane-key="domains"]')).toBeNull();
    expect(m.stub!.calls.some((u) => u.includes("dns%3A"))).toBe(false);
  });

  test("REQ-ECR-C1: the selected service's latency chart requests /api/history/target/<host>%2F<svc>/endpoint.check.latency", async () => {
    const snapshot = makeHierarchySnapshot({ hosts: 1, servicesPerHost: 1 });
    const svc = snapshot.hosts[0]!.services[0]!;
    const endpoint = `${snapshot.hosts[0]!.name}/${svc.name}`;
    const latencyPath = `/api/history/target/${encodeURIComponent(endpoint)}/endpoint.check.latency`;
    const m = await mountView({
      snapshot,
      search: `?sel=${encodeURIComponent(`service:${svc.drilldownId}`)}`,
      routes: [
        { path: ALERTS, reply: { status: 200, body: makeAlertHistory("24h", []) } },
        { path: COVERAGE, reply: { status: 200, body: makeSeriesHistory("engine.active-series", "24h") } },
        { path: CHECKS, reply: { status: 200, body: makeEndpointHistory(endpoint) } },
        { path: latencyPath, reply: { status: 200, body: makeSeriesHistory("endpoint.check.latency", "24h", { target: { kind: "endpoint", id: endpoint } }) } },
      ],
    });
    const detail = m.container.querySelector<HTMLElement>("[data-slot=timeline-detail]")!;
    expect(detail.getAttribute("data-target-kind")).toBe("service");
    expect(m.stub!.calls).toContain(`${latencyPath}?range=24h`);
    expect(latencyPath).toContain("%2F");
    expect(detail.textContent).not.toContain(CHECK_LATENCY_UNAVAILABLE);
  });

  test("REQ-RANGE-02: a range missing from alertHistory.ranges issues no alerts request and says so", async () => {
    const index = makeTimelineIndex(SMALL.snapshot);
    const m = await mountView({ index: { ...index, alertHistory: { ...index.alertHistory, ranges: ["1h", "6h"] } } });
    expect(count(m.stub!.calls, ALERTS)).toBe(0);
    expect(count(m.stub!.calls, COVERAGE)).toBe(1);
    expect(m.container.textContent).toContain("Alert history is not available at this range.");
  });

  test("REQ-LANE-03: a paused end older than now − range shows the latest-window notice", async () => {
    const end = TIMELINE_NOW_S - 3 * 86_400;
    const m = await mountView({ search: `?end=${end}` });
    const n = m.container.querySelector('[data-notice-key="latest-window"]')!;
    expect(n.textContent).toContain("History is only available for the latest 24h");
    // The lanes outside the served span read "no data", never healthy.
    for (const row of all(m.container, '[data-tree-row][data-level="1"]')) {
      expect(row.getAttribute("data-status")).not.toBe("ok");
    }
  });

  // --- limit and frozen order (REQ-HISTERR-04, REQ-LANE-05) -----------------------------------------

  test("REQ-HISTERR-04: HISTORY_LIMIT_EXCEEDED on alerts — every lane reads no data, too-many state, no rows drawn, 'Try a shorter range' selects 6h", async () => {
    const m = await mountView({
      routes: [
        { path: ALERTS, reply: { status: 422, body: envelope("HISTORY_LIMIT_EXCEEDED") } },
        { path: COVERAGE, reply: { status: 200, body: makeSeriesHistory("engine.active-series", "24h") } },
      ],
    });
    const c = m.container;
    const rows = all(c, "[data-tree-row]");
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows.filter((r) => r.hasAttribute("data-status"))) {
      expect(row.getAttribute("data-status")).toBe("unknown");
      expect(row.textContent).toContain("no data");
    }
    const swim = c.querySelector("[data-slot=timeline-swimlane]")!;
    expect(swim.querySelector('[data-history-kind="too-many"]')).not.toBeNull();
    expect(swim.querySelectorAll("[data-swim-track]").length).toBe(0);
    expect(swim.querySelectorAll("[data-severity]").length).toBe(0);
    button(swim, "Try a shorter range").click();
    await settle();
    expect(query().get("range")).toBe("6h");
    expect(m.navs.at(-1)![1]).toBe(false);
  });

  test("REQ-LANE-05: the problem-first host order is frozen across live refreshes and recomputed after a range change", async () => {
    jest.useFakeTimers();
    const shift = Math.floor(Date.now() / 1000) - TIMELINE_NOW_S; // fixture offsets are relative to TIMELINE_NOW_S
    const snapshot = makeHierarchySnapshot({ hosts: 4, servicesPerHost: 1 });
    const tree = buildLaneTree(snapshot, makeTimelineIndex(snapshot));
    const problemOn = (i: number): unknown =>
      makeAlertHistory("24h", [makeAlertLane({ alertname: "HostDown", severity: "critical", target: tree.hosts[i]!.target, intervals: [[shift - 1_800, shift - 600]] })]);
    let alertsBody = problemOn(3);
    const stub = installHistoryStub(defaultRoutes());
    const stubFetch = globalThis.fetch;
    const alertCalls: string[] = [];
    globalThis.fetch = ((input: unknown, init?: RequestInit) => {
      const url = typeof input === "string" ? input : String(input);
      if (url.startsWith(ALERTS)) {
        alertCalls.push(url);
        return Promise.resolve(new Response(JSON.stringify(alertsBody), { status: 200 }));
      }
      return stubFetch(input as string, init);
    }) as typeof fetch;
    cleanups.push(() => stub.restore());
    const m = await mountView({ snapshot, noStub: true, fake: true });
    const key3 = targetKey(tree.hosts[3]!.target);
    const key2 = targetKey(tree.hosts[2]!.target);
    expect(hostRowKeys(m.container)[0]).toBe(key3);

    // A live refresh where a lower host becomes the problem: the order does not jump.
    alertsBody = problemOn(2);
    jest.advanceTimersByTime(LIVE_REFRESH_MS);
    await micro();
    expect(alertCalls.length).toBe(2);
    expect(hostRowKeys(m.container)[0]).toBe(key3);
    // (host 2 is now the only problem in the refreshed payload; the frozen order still leads with host 3)

    // A range change recomputes it from the first load after the change.
    radio(m.container, "6h").click();
    await micro();
    expect(alertCalls.length).toBe(3);
    expect(hostRowKeys(m.container)[0]).toBe(key2);
  });

  // --- kiosk (REQ-KIOSK-01/03/04, CON-08) -----------------------------------------------------------

  test("REQ-KIOSK-01/03/04 / CON-08: ?kiosk=1&range=6h&zoom&sel&end with rotation — 6h live, no overlay/detail/hints/focus, status line, no URL writes, only LIVE_REFRESH_MS recurs", async () => {
    // src modules reach timers both bare (the real global) and via globalThis (the happy-dom window).
    type Timers = { setInterval: (...a: unknown[]) => unknown; setTimeout: (...a: unknown[]) => unknown };
    const hosts = [realGlobal as unknown as Timers, dom.win as unknown as Timers];
    const intervalSpies = hosts.map((t) => spyOn(t, "setInterval"));
    const timeoutSpies = hosts.map((t) => spyOn(t, "setTimeout"));
    cleanups.push(() => {
      for (const sp of [...intervalSpies, ...timeoutSpies]) sp.mockRestore();
    });
    const intervalSpy = { mock: { calls: intervalSpies.flatMap((sp) => sp.mock.calls) } };
    const timeoutSpy = { mock: { calls: [] as unknown[][] } };
    const rotation: ViewRotationContext = Object.freeze({ entry: Object.freeze({ viewId: "timeline", dwellMs: 30_000 }), index: 1, total: 2, epoch: 3 });
    const before = JSON.stringify(rotation);
    const E = TIMELINE_NOW_S - 600;
    const sel = encodeURIComponent(hostKeyOf(SMALL.snapshot, 0));
    const m = await mountView({
      search: `?kiosk=1&rotate=overview,timeline&range=6h&zoom=${E - 3600}-${E - 1800}&sel=${sel}&end=${E}`,
      rotation,
    });
    const c = m.container;
    expect(c.querySelector("[data-slot=timeline-page]")!.getAttribute("data-kiosk")).toBe("true");
    expect(pageHeadings(c).map((h) => h.textContent)).toEqual(["Timeline"]);
    expect(c.querySelector("[data-slot=timeline-kiosk-status]")!.textContent).toContain("Last 6 hours · Live");
    expect(c.querySelector("[data-slot=timeline-controls]")).toBeNull();
    expect(c.querySelector("[data-slot=page-header] button")).toBeNull();
    expect(c.querySelector('[role="radiogroup"]')).toBeNull();
    expect(c.querySelector("[data-slot=plot-overlay]")).toBeNull();
    expect(c.querySelector("[data-slot=timeline-detail]")).toBeNull();
    expect(c.querySelector("[data-slot=timeline-kbd-hints]")).toBeNull();
    expect(c.querySelector("[data-slot=timeline-readout-slot]")).toBeNull();
    expect(c.querySelector('[role="tree"]')).toBeNull();
    expect(all(c, "[data-tree-row]").length).toBeGreaterThan(0);
    expect(all(c, "[data-tree-row][tabindex]").length).toBe(0);
    expect(all(c, "[data-swim-track]").length).toBeGreaterThan(0);
    expect(all(c, "[data-swim-track][tabindex]").length).toBe(0);
    expect(m.navs).toEqual([]);
    expect(m.stub!.calls).toContain(`${ALERTS}?range=6h`);
    expect(m.stub!.calls.some((u) => u.includes("/target/"))).toBe(false);
    expect(JSON.stringify(rotation)).toBe(before);

    // The only recurring timer is the LIVE_REFRESH_MS data refresh (CON-08).
    intervalSpy.mock.calls = intervalSpies.flatMap((sp) => sp.mock.calls);
    timeoutSpy.mock.calls = timeoutSpies.flatMap((sp) => sp.mock.calls);
    expect(intervalSpy.mock.calls.every((a) => a[1] === LIVE_REFRESH_MS)).toBe(true);
    const longTimers = timeoutSpy.mock.calls.map((a) => a[1]).filter((ms) => typeof ms === "number" && ms >= 1_000);
    expect(longTimers.length).toBeGreaterThan(0);
    expect(longTimers.every((ms) => ms === LIVE_REFRESH_MS)).toBe(true);
    expect(timeoutSpy.mock.calls.some((a) => a[1] === 30_000)).toBe(false);
  });
});
