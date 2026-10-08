// apps/web/tests/engine-view-trends.test.ts — /engine trend charts (04 §10, 08 §4.2 trends row).
//
// EngineTrends is rendered directly. The lazy chart is stubbed per 08 §4.1 (one
// shared StubChart, one top-level mock.module, the real module re-mocked in afterAll and
// resetChartStub in afterEach). Every /api/history/estate/* request goes through installHistoryStub.
// happy-dom's getBoundingClientRect returns zeros, so [data-slot=timeseries-plot] / .u-over / [data-slot=plot-overlay]
// geometry is stubbed per class name, rAF runs on microtasks and flushes run inside act().

import { afterAll, afterEach, beforeAll, expect, jest, mock, spyOn, test } from "bun:test";
import { createElement } from "react";
import type { ReactElement } from "react";

import type { QueryId, RangeId } from "@pulse/web-data/wire";
import { createEstateClock } from "../src/client/format.js";
import type { EstateClock } from "../src/client/format.js";
import {
  EngineTrends,
  RANGE_LABEL,
  TREND_LABEL,
} from "../src/client/views/engine/trends.js";
import { trendWindow } from "../src/client/views/engine/trends-model.js";
import type { EngineTrendQueryId } from "../src/client/views/engine/trends.js";
import { CLIENT_QUERY_META, ENGINE_TREND_QUERIES } from "../src/client/views/_shared/timeseries/query-meta.js";
import { LIVE_REFRESH_MS } from "../src/client/views/_shared/timeseries/history/client.js";
import { FAILURE_COPY, REGION_TEXT } from "../src/client/views/_shared/timeseries/history/region.js";
import { isolateDomGlobals, realGlobal } from "./alerts-dom-isolation.js";
import { describeDom, restoreRealTimers } from "./dom.js";
import { StubChart, resetChartStub } from "./chart-stub.js";
import { envelope, installHistoryStub, makeSeriesHistory } from "./timeline-fixtures.js";
import type { StubRoute } from "./timeline-fixtures.js";
import { act } from "./react-render.js";
import { within } from "./rtl.js";

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

const CLOCK: EstateClock = createEstateClock({ name: "", timezone: "America/Chicago", tzFallback: false });
const ESTATE = "/api/history/estate/";

const PLOT_RECT = { left: 100, top: 50, width: 600, height: 260 };
const UOVER_RECT = { left: 140, top: 60, width: 540, height: 200 };
const OVERLAY_RECT = { left: 0, top: 0, width: 540, height: 200 };

function domRect(r: { left: number; top: number; width: number; height: number }): DOMRect {
  return { ...r, x: r.left, y: r.top, right: r.left + r.width, bottom: r.top + r.height, toJSON: () => r } as DOMRect;
}

function rangeOf(id: EngineTrendQueryId): RangeId {
  return CLIENT_QUERY_META[id]!.defaultRange;
}

/** A 200 route for one trend. */
function okRoute(id: EngineTrendQueryId, o?: { delayMs?: number }): StubRoute {
  return {
    path: `${ESTATE}${id}`,
    reply: { status: 200, body: makeSeriesHistory(id as QueryId, rangeOf(id)) },
    ...(o?.delayMs !== undefined ? { delayMs: o.delayMs } : {}),
  };
}

/** Routes for all five trends, with per-id overrides. */
function routes(overrides: Partial<Record<EngineTrendQueryId, StubRoute["reply"]>> = {}, delayMs?: number): StubRoute[] {
  return ENGINE_TREND_QUERIES.map((id) => {
    const reply = overrides[id];
    return reply === undefined
      ? okRoute(id, delayMs !== undefined ? { delayMs } : undefined)
      : { path: `${ESTATE}${id}`, reply };
  });
}

type Fetcher = (input: unknown, init?: unknown) => Promise<Response>;

/** Capture a stub's fetch function and put the previous fetch back (the fn keeps working). */
function captureStub(rs: readonly StubRoute[]): { fetch: Fetcher; stub: ReturnType<typeof installHistoryStub> } {
  const stub = installHistoryStub(rs);
  const f = globalThis.fetch as unknown as Fetcher;
  stub.restore();
  return { fetch: f, stub };
}

async function flush(rounds = 60): Promise<void> {
  // React runs non-urgent updates on a scheduler task; act() flushes them with the microtasks.
  await act(async () => {
    for (let i = 0; i < rounds; i++) await Promise.resolve();
  });
}

/** Real-timer settle: microtasks plus macrotasks (lazy import resolution, MutationObserver). */
async function settle(): Promise<void> {
  // Inside act() so a lazy chunk that resolves here is revealed without React's fallback throttle.
  await act(async () => {
    for (let i = 0; i < 6; i++) {
      await flush();
      await new Promise<void>((r) => setTimeout(r, 0));
    }
    await flush();
  });
}

describeDom("engine view — EngineTrends (item 016)", (dom) => {
  let savedGlobalRaf: PropertyDescriptor | undefined;
  let rectSpy: { mockRestore(): void } | null = null;
  const mounted: { unmount(): void }[] = [];
  const cleanups: (() => void)[] = [];
  let savedFetch: typeof fetch;

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
    savedFetch = globalThis.fetch;
  });

  afterEach(() => {
    while (mounted.length > 0) mounted.pop()!.unmount();
    restoreRealTimers();
    while (cleanups.length > 0) cleanups.pop()!();
    globalThis.fetch = savedFetch;
  });

  afterAll(() => {
    const g = globalThis as unknown as { requestAnimationFrame?: unknown };
    if (savedGlobalRaf === undefined) delete g.requestAnimationFrame;
    else Object.defineProperty(g, "requestAnimationFrame", savedGlobalRaf);
    rectSpy?.mockRestore();
  });

  async function mountTrends(o: { kiosk?: boolean; generation?: string | null } = {}): Promise<{ container: HTMLElement; unmount(): void }> {
    const m = await dom.mount(
      el(EngineTrends, { clock: CLOCK, kiosk: o.kiosk ?? false, generation: o.generation ?? "gen-1" }),
    );
    let done = false;
    const handle = {
      container: m.container,
      unmount(): void {
        if (done) return;
        done = true;
        m.unmount();
      },
    };
    mounted.push(handle);
    return handle;
  }

  function item(c: HTMLElement, id: EngineTrendQueryId): HTMLElement {
    return c.querySelector<HTMLElement>(`li[data-query="${id}"]`)!;
  }

  function region(c: HTMLElement, id: EngineTrendQueryId): HTMLElement {
    return item(c, id).querySelector<HTMLElement>("[data-slot=history-region]")!;
  }

  // --- pure helpers ------------------------------------------------------------------------------

  test("REQ-CAP-02: trendWindow is [end − range, end) and the labels cover every trend and range", () => {
    expect(trendWindow(10_000, "1h")).toEqual({ start: 6_400, end: 10_000 });
    expect(trendWindow(100_000, "6h")).toEqual({ start: 100_000 - 21_600, end: 100_000 });
    expect(Object.keys(TREND_LABEL)).toEqual([...ENGINE_TREND_QUERIES]);
    expect(TREND_LABEL["engine.notification-latency"].title).toBe("Notification latency (p99)");
    expect(RANGE_LABEL).toEqual({ "1h": "Last 1 hour", "6h": "Last 6 hours", "24h": "Last 24 hours", "7d": "Last 7 days" });
  });

  // --- REQ-CAP-02 / REQ-SCALE-01 -----------------------------------------------------------------

  test("REQ-CAP-02, REQ-SCALE-01: five captioned trends in order, five estate requests at their default ranges, never more than 4 in flight", async () => {
    const stub = installHistoryStub(routes({}, 5));
    cleanups.push(() => stub.restore());
    const inner = globalThis.fetch as unknown as Fetcher;
    let maxInFlight = 0;
    globalThis.fetch = ((input: unknown, init?: unknown) => {
      const p = inner(input, init);
      maxInFlight = Math.max(maxInFlight, stub.inFlight());
      return p;
    }) as unknown as typeof fetch;

    const { container: c } = await mountTrends();
    for (let i = 0; i < 6; i++) {
      await settle();
      await new Promise<void>((r) => setTimeout(r, 10));
    }
    await settle();

    const trends = c.querySelector<HTMLElement>("section[aria-labelledby]")!;
    const trendsHeading = c.querySelector<HTMLElement>(`#${CSS.escape(trends.getAttribute("aria-labelledby")!)}`)!;
    expect(trendsHeading.tagName).toBe("H2");
    expect(trendsHeading.textContent).toBe("Trends");
    expect(c.querySelectorAll("h2")).toHaveLength(1);
    expect(c.querySelectorAll("h4")).toHaveLength(0);

    const items = [...c.querySelectorAll<HTMLElement>("li[data-query]")];
    expect(items.map((li) => li.getAttribute("data-query"))).toEqual([...ENGINE_TREND_QUERIES]);
    for (const id of ENGINE_TREND_QUERIES) {
      const li = item(c, id);
      const title = li.querySelector("h3")!;
      expect(title.textContent).toBe(TREND_LABEL[id].title);
      const chartSection = li.querySelector<HTMLElement>("section[aria-labelledby]")!;
      expect(chartSection.getAttribute("aria-labelledby")).toBe(title.id);
      const meta = title.nextElementSibling!;
      expect(meta.tagName).toBe("P");
      expect(meta.textContent).toBe(
        `${RANGE_LABEL[rangeOf(id)]} · ${TREND_LABEL[id].unit} · Times in America/Chicago`,
      );
      expect(region(c, id).getAttribute("data-history-phase")).toBe("ready");
      expect(li.querySelector("[data-slot=timeseries-plot] [data-slot=time-series-chart]")).not.toBeNull();
    }

    expect(stub.calls).toEqual(ENGINE_TREND_QUERIES.map((id) => `${ESTATE}${id}?range=${rangeOf(id)}`));
    expect(ENGINE_TREND_QUERIES.map(rangeOf)).toEqual(["1h", "6h", "6h", "6h", "6h"]);
    expect(stub.calls.some((u) => u.includes("end="))).toBe(false);
    expect(maxInFlight).toBeLessThanOrEqual(4);
    expect(maxInFlight).toBeGreaterThan(0);
  });

  // --- #15: one visible caption per card ---------------------------------------------------------

  test("#15: each trend figure is named by its h3 and described by its meta line, with no second visible caption", async () => {
    const stub = installHistoryStub(routes());
    cleanups.push(() => stub.restore());
    const { container: c } = await mountTrends();
    for (let i = 0; i < 4; i++) {
      await settle();
      await new Promise<void>((r) => setTimeout(r, 10));
    }
    await settle();

    for (const id of ENGINE_TREND_QUERIES) {
      const card = within(item(c, id));
      const label = TREND_LABEL[id];
      const heading = card.getByRole("heading", { level: 3, name: label.title });
      const figure = card.getByRole("figure", { name: label.title });
      expect(figure).toHaveAttribute("aria-labelledby", heading.id);
      const meta = `${RANGE_LABEL[rangeOf(id)]} · ${label.unit} · Times in America/Chicago`;
      expect(figure).toHaveAccessibleDescription(expect.stringContaining(meta));
      expect(figure).toHaveAccessibleDescription(expect.stringContaining("resolution: "));
      // The title, range and zone are printed once: no figcaption repeats them.
      expect(figure.querySelector("figcaption")).toBeNull();
      expect(card.getAllByText(label.title)).toHaveLength(1);
      expect(card.getAllByText(/Times in America\/Chicago/)).toHaveLength(1);
      // The plot's own name uses the same unit wording as the meta line (never the "count" kind).
      // (The stubbed chart keeps the aria-label but not the real chart's role="img".)
      const plot = figure.querySelector("[data-slot=time-series-chart]")!;
      expect(plot.getAttribute("aria-label")).toBe(`${label.title}, ${rangeOf(id)}, ${label.unit}`);
    }
  });

  // --- REQ-KIOSK-04 / CON-08 ---------------------------------------------------------------------

  test("REQ-KIOSK-04, CON-08: each trend re-requests once per LIVE_REFRESH_MS while mounted, never after unmount; the only recurring timer is LIVE_REFRESH_MS", async () => {
    jest.useFakeTimers();
    // The bare `setInterval` in src modules resolves on the real global, not the happy-dom window
    // that `globalThis` names inside this file.
    const g = realGlobal as unknown as { setInterval: (...a: unknown[]) => unknown };
    const intervalSpy = spyOn(g, "setInterval");
    cleanups.push(() => intervalSpy.mockRestore());
    const stub = installHistoryStub(routes());
    cleanups.push(() => stub.restore());

    const m = await mountTrends({ kiosk: true });
    await flush();
    await flush();
    expect(stub.calls.length).toBe(5);

    jest.advanceTimersByTime(LIVE_REFRESH_MS - 1);
    await flush();
    expect(stub.calls.length).toBe(5);
    jest.advanceTimersByTime(1);
    await flush();
    await flush();
    expect(stub.calls.length).toBe(10);
    jest.advanceTimersByTime(LIVE_REFRESH_MS);
    await flush();
    await flush();
    expect(stub.calls.length).toBe(15);
    for (const id of ENGINE_TREND_QUERIES) {
      expect(stub.calls.filter((u) => u === `${ESTATE}${id}?range=${rangeOf(id)}`).length).toBe(3);
    }

    const periods = intervalSpy.mock.calls.map((args) => args[1]);
    expect(periods.length).toBe(5);
    expect(periods.every((p) => p === LIVE_REFRESH_MS)).toBe(true);

    m.unmount();
    jest.advanceTimersByTime(LIVE_REFRESH_MS * 3);
    await flush();
    expect(stub.calls.length).toBe(15);
  });

  // --- REQ-CAP-03 / REQ-HISTERR-01 ---------------------------------------------------------------

  test("REQ-CAP-03, REQ-HISTERR-01: per-cause failures render their FAILURE_COPY and Retry in that chart only; the other charts still render", async () => {
    const stub = installHistoryStub(
      routes({
        "engine.ingestion-rate": { status: 503, body: envelope("HISTORY_OVERLOADED"), retryAfter: 1 },
        "engine.active-series": { status: 504, body: envelope("SOURCE_TIMEOUT") },
        "engine.disk-usage": { status: 502, body: envelope("HISTORY_LIMIT_EXCEEDED") },
      }),
    );
    cleanups.push(() => stub.restore());
    const { container: c } = await mountTrends();
    await settle();

    const overloaded = region(c, "engine.ingestion-rate");
    expect(overloaded.getAttribute("data-history-phase")).toBe("error");
    expect(overloaded.getAttribute("data-history-kind")).toBe("overloaded");
    expect(overloaded.getAttribute("data-history-code")).toBe("HISTORY_OVERLOADED");
    expect(overloaded.textContent).toContain(FAILURE_COPY.overloaded);
    const wait = overloaded.querySelector<HTMLButtonElement>("button")!;
    expect(wait.textContent).toBe("Retry in 1s");
    expect(wait.disabled).toBe(true);
    expect(overloaded.querySelector("[data-slot=timeseries-plot]")).toBeNull();

    const timeout = region(c, "engine.active-series");
    expect(timeout.getAttribute("data-history-kind")).toBe("timeout");
    expect(timeout.textContent).toContain(FAILURE_COPY.timeout);
    const retry = timeout.querySelector<HTMLButtonElement>("button")!;
    expect(retry.textContent).toBe(REGION_TEXT.retry);
    expect(retry.disabled).toBe(false);
    expect(timeout.querySelector("[data-slot=timeseries-plot]")).toBeNull();

    // Fixed range: too-many says so without a shorter-range suggestion, and offers no Retry.
    const tooMany = region(c, "engine.disk-usage");
    expect(tooMany.getAttribute("data-history-kind")).toBe("too-many");
    expect(tooMany.textContent).toContain(REGION_TEXT.tooManyNoShorter);
    expect(tooMany.querySelector("button")).toBeNull();

    for (const id of ["engine.notification-failures", "engine.notification-latency"] as const) {
      expect(region(c, id).getAttribute("data-history-phase")).toBe("ready");
      expect(item(c, id).querySelector("[data-slot=timeseries-plot] [data-slot=time-series-chart]")).not.toBeNull();
    }

    // Retry re-issues only the failed chart's request.
    const before = stub.calls.length;
    retry.click();
    await settle();
    expect(stub.calls.slice(before)).toEqual([`${ESTATE}engine.active-series?range=6h`]);
  });

  // --- REQ-HISTERR-03 ----------------------------------------------------------------------------

  test("REQ-HISTERR-03: a single MODEL_CHANGED is retried automatically and the chart renders; a repeat failure is shown as superseded", async () => {
    const changed: StubRoute["reply"] = { status: 409, body: envelope("MODEL_CHANGED") };
    const first = captureStub(routes({ "engine.disk-usage": changed, "engine.active-series": changed }));
    const later = captureStub(routes({ "engine.active-series": changed }));
    const counts = new Map<string, number>();
    const seen: string[] = [];
    globalThis.fetch = ((input: unknown, init?: unknown) => {
      const url = String(input);
      seen.push(url);
      const n = (counts.get(url) ?? 0) + 1;
      counts.set(url, n);
      return (n === 1 ? first.fetch : later.fetch)(input, init);
    }) as unknown as typeof fetch;

    const { container: c } = await mountTrends();
    await settle();

    // One MODEL_CHANGED then success: ready, and superseded never rendered.
    const disk = region(c, "engine.disk-usage");
    expect(disk.getAttribute("data-history-phase")).toBe("ready");
    expect(item(c, "engine.disk-usage").textContent).not.toContain(FAILURE_COPY.superseded);
    expect(counts.get(`${ESTATE}engine.disk-usage?range=6h`)).toBe(2);

    // MODEL_CHANGED twice: error/superseded after exactly two fetches.
    const active = region(c, "engine.active-series");
    expect(active.getAttribute("data-history-kind")).toBe("superseded");
    expect(active.textContent).toContain(FAILURE_COPY.superseded);
    expect(counts.get(`${ESTATE}engine.active-series?range=6h`)).toBe(2);

    // The others fetched once each.
    for (const id of ["engine.ingestion-rate", "engine.disk-usage", "engine.notification-failures", "engine.notification-latency"] as const) {
      if (id === "engine.disk-usage") continue;
      expect(counts.get(`${ESTATE}${id}?range=${rangeOf(id)}`)).toBe(1);
      expect(region(c, id).getAttribute("data-history-phase")).toBe("ready");
    }
    expect(seen.length).toBe(7);
  });

  // --- REQ-HISTERR-02 / REQ-FOLLOW-03 ------------------------------------------------------------

  test("REQ-HISTERR-02, REQ-FOLLOW-03: a failed refresh keeps the previous chart rendered, marked stale", async () => {
    jest.useFakeTimers();
    const ok = captureStub(routes());
    const failing = captureStub(routes({ "engine.ingestion-rate": { status: 502, body: envelope("SOURCE_UNAVAILABLE") } }));
    let calls = 0;
    globalThis.fetch = ((input: unknown, init?: unknown) => {
      calls++;
      return (calls <= 5 ? ok.fetch : failing.fetch)(input, init);
    }) as unknown as typeof fetch;

    const { container: c } = await mountTrends();
    await flush();
    await flush();
    const r0 = region(c, "engine.ingestion-rate");
    expect(r0.getAttribute("data-history-phase")).toBe("ready");
    expect(r0.getAttribute("data-history-stale")).toBe("false");
    expect(r0.querySelector("[data-slot=timeseries-plot]")).not.toBeNull();

    jest.advanceTimersByTime(LIVE_REFRESH_MS);
    await flush();
    await flush();
    expect(calls).toBe(10);

    const r1 = region(c, "engine.ingestion-rate");
    expect(r1.getAttribute("data-history-phase")).toBe("error");
    expect(r1.getAttribute("data-history-kind")).toBe("unavailable");
    expect(r1.getAttribute("data-history-stale")).toBe("true");
    expect(r1.querySelector("[data-slot=history-region-stale]")!.textContent).toBe(REGION_TEXT.stalePrevious);
    expect(r1.querySelector("[data-slot=history-region-failure]")!.textContent).toContain(FAILURE_COPY.unavailable);
    // The previous chart is still there.
    expect(r1.querySelector("[data-slot=timeseries-plot]")).not.toBeNull();
    // The other charts refreshed normally.
    expect(region(c, "engine.active-series").getAttribute("data-history-phase")).toBe("ready");
    expect(region(c, "engine.active-series").getAttribute("data-history-stale")).toBe("false");
  });

  // --- REQ-OBS-01 --------------------------------------------------------------------------------

  test("REQ-OBS-01: a render fault inside one chart shows 'This panel failed to render' for that chart only", async () => {
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    cleanups.push(() => errSpy.mockRestore());
    const stub = captureStub(routes());
    // The disk-usage payload throws when the chart reads its series (inside the render callback).
    globalThis.fetch = (async (input: unknown, init?: unknown) => {
      const res = await stub.fetch(input, init);
      if (!String(input).includes("engine.disk-usage")) return res;
      const body = (await res.json()) as Record<string, unknown>;
      const hostile = Object.defineProperty({ ...body }, "series", {
        get(): never {
          throw new Error("trend render fault");
        },
      });
      return { status: res.status, ok: res.ok, headers: res.headers, json: async () => hostile } as unknown as Response;
    }) as unknown as typeof fetch;

    const { container: c } = await mountTrends();
    await settle();

    const faulted = item(c, "engine.disk-usage");
    expect(faulted.textContent).toContain("This panel failed to render");
    expect(faulted.textContent).toContain(TREND_LABEL["engine.disk-usage"].title);
    expect(faulted.querySelector("[data-slot=timeseries-plot]")).toBeNull();
    for (const id of ENGINE_TREND_QUERIES) {
      if (id === "engine.disk-usage") continue;
      expect(item(c, id).textContent).not.toContain("This panel failed to render");
      expect(item(c, id).querySelector("[data-slot=timeseries-plot] [data-slot=time-series-chart]")).not.toBeNull();
    }
    expect(errSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  test("REQ-OBS-01, REQ-CAP-02: the five charts share no axis — moving one chart's cursor leaves the other readouts empty", async () => {
    const stub = installHistoryStub(routes());
    cleanups.push(() => stub.restore());
    const { container: c } = await mountTrends();
    await settle();

    for (const id of ENGINE_TREND_QUERIES) {
      expect(item(c, id).querySelector("[data-slot=timeseries-plot]")!.getAttribute("data-overlay-state")).toBe("measured");
      expect(item(c, id).querySelector("[data-slot=cursor-readout][data-variant=inline]")).not.toBeNull();
      expect(item(c, id).querySelector("[data-slot=cursor-readout-charts]")).toBeNull();
    }

    const overlay = item(c, "engine.active-series").querySelector<HTMLElement>("[data-slot=plot-overlay]")!;
    expect(overlay.getAttribute("data-state")).toBe("active");
    overlay.focus();
    overlay.dispatchEvent(new dom.win.KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true }) as unknown as Event);
    await settle();

    const moved = item(c, "engine.active-series");
    expect(moved.querySelector("[data-slot=cursor-readout-charts]")!.textContent).toContain(TREND_LABEL["engine.active-series"].title);
    for (const id of ENGINE_TREND_QUERIES) {
      if (id === "engine.active-series") continue;
      const li = item(c, id);
      expect(li.querySelector("[data-slot=cursor-readout-charts]")).toBeNull();
      expect(li.querySelector("[data-slot=cursor-readout-time]")!.textContent).toContain("Point at the timeline");
    }
  });

  test("REQ-KIOSK-02: in kiosk the charts render with inert overlays and no readout", async () => {
    const stub = installHistoryStub(routes());
    cleanups.push(() => stub.restore());
    const { container: c } = await mountTrends({ kiosk: true });
    await settle();
    for (const id of ENGINE_TREND_QUERIES) {
      const li = item(c, id);
      expect(li.querySelector("[data-slot=timeseries-plot] [data-slot=time-series-chart]")).not.toBeNull();
      const overlay = li.querySelector("[data-slot=plot-overlay]")!;
      expect(overlay.getAttribute("data-state")).toBe("inert");
      expect(overlay.hasAttribute("tabindex")).toBe(false);
      expect(li.querySelector("[data-slot=cursor-readout]")).toBeNull();
    }
  });
});
