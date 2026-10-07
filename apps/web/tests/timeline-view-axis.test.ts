// Unit tests for views/timeline/axis.ts: mapping, zoom math, the §2.5 domain effect and the
// live-follow timer (06 §2, §9). Pure: no DOM, no fake timers — createLiveFollow gets an
// injected scheduler (08 §1).

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { batch, signal } from "@preact/signals-core";

import {
  CURSOR_BIG_STEP,
  KEY_ZOOM_FACTOR,
  MIN_ZOOM_STEPS,
  brushWindow,
  clampCursor,
  createLiveFollow,
  createTimeAxis,
  formatStepLabel,
  minZoomWidth,
  normalizeZoom,
  zoomWindow,
} from "../src/client/views/_shared/timeseries/axis.js";
import type { LiveFollowScheduler, TimeWindow } from "../src/client/views/_shared/timeseries/axis.js";
import * as axisModule from "../src/client/views/_shared/timeseries/axis.js";

const T0 = 1_790_208_000;
const HOUR = 3600;
const DAY = 86_400;
const D24: TimeWindow = { start: T0 - DAY, end: T0 };

function makeAxis(d: TimeWindow = D24, initialZoom: TimeWindow | null = null, step = 145) {
  const domain = signal<TimeWindow>(d);
  const axis = createTimeAxis({ domain, initialZoom, initialStepSeconds: step });
  return { domain, axis };
}

/** Asserts the zoom invariants (06 Verification): integer, inside the domain, ≥ MIN_ZOOM_STEPS × step. */
function expectValidZoom(z: TimeWindow | null, d: TimeWindow, step: number): void {
  if (z === null) return;
  expect(Number.isInteger(z.start)).toBe(true);
  expect(Number.isInteger(z.end)).toBe(true);
  expect(z.start).toBeGreaterThanOrEqual(d.start);
  expect(z.end).toBeLessThanOrEqual(d.end);
  expect(z.end - z.start).toBeGreaterThanOrEqual(MIN_ZOOM_STEPS * step);
}

describe("axis constants", () => {
  test("00 §6.3 values; LIVE_REFRESH_MS is not declared in axis.ts", () => {
    expect(MIN_ZOOM_STEPS).toBe(2);
    expect(KEY_ZOOM_FACTOR).toBe(2);
    expect(CURSOR_BIG_STEP).toBe(10);
    expect("LIVE_REFRESH_MS" in axisModule).toBe(false);
  });
});

describe("mapping (REQ-ZOOM-01)", () => {
  test("REQ-ZOOM-01: toFraction/fromFraction round trip over the view", () => {
    const { axis } = makeAxis();
    for (const f of [0, 0.1, 0.25, 0.5, 0.9, 1]) {
      expect(axis.toFraction(axis.fromFraction(f))).toBeCloseTo(f, 9);
    }
    for (const t of [D24.start, D24.start + 1234, T0 - HOUR, D24.end]) {
      expect(axis.fromFraction(axis.toFraction(t))).toBeCloseTo(t, 6);
    }
    expect(axis.toFraction(D24.start)).toBe(0);
    expect(axis.toFraction(D24.end)).toBe(1);
  });

  test("REQ-ZOOM-01: mapping follows the zoomed view", () => {
    const z = { start: T0 - 2 * HOUR, end: T0 - HOUR };
    const { axis } = makeAxis(D24, z);
    expect(axis.view.value).toEqual(z);
    expect(axis.toFraction(T0 - 1.5 * HOUR)).toBeCloseTo(0.5, 9);
    expect(axis.fromFraction(0.5)).toBeCloseTo(T0 - 1.5 * HOUR, 6);
  });

  test("REQ-ZOOM-01: toFraction is unclamped outside the view; fromFraction is clamped", () => {
    const { axis } = makeAxis(D24, { start: T0 - 2 * HOUR, end: T0 - HOUR });
    expect(axis.toFraction(T0 - 3 * HOUR)).toBeCloseTo(-1, 9);
    expect(axis.toFraction(T0)).toBeCloseTo(2, 9);
    expect(axis.fromFraction(-0.5)).toBe(T0 - 2 * HOUR);
    expect(axis.fromFraction(7)).toBe(T0 - HOUR);
    expect(axis.fromFraction(Number.NaN)).toBe(T0 - 2 * HOUR);
  });

  test("REQ-ZOOM-01: clampCursor at view.end returns view.end − 0.001; non-finite → null", () => {
    const v = { start: 100, end: 200 };
    expect(clampCursor(200, v)).toBeCloseTo(199.999, 9);
    expect(clampCursor(500, v)).toBeCloseTo(199.999, 9);
    expect(clampCursor(50, v)).toBe(100);
    expect(clampCursor(150, v)).toBe(150);
    expect(clampCursor(Number.NaN, v)).toBeNull();
    expect(clampCursor(Number.POSITIVE_INFINITY, v)).toBeNull();
    expect(clampCursor(Number.NEGATIVE_INFINITY, v)).toBeNull();
  });
});

describe("zoom math (REQ-ZOOM-02, REQ-ZOOM-03)", () => {
  test("REQ-ZOOM-03: minZoomWidth is min(MIN_ZOOM_STEPS × step, Dw); invalid step counts as 1 s", () => {
    expect(minZoomWidth(145, D24)).toBe(290);
    expect(minZoomWidth(60, { start: 0, end: 100 })).toBe(100);
    expect(minZoomWidth(0, D24)).toBe(2);
    expect(minZoomWidth(Number.NaN, D24)).toBe(2);
  });

  test("REQ-ZOOM-02: zoomWindow keeps the centre anchored at its x fraction and yields integer bounds", () => {
    const view = D24;
    const centre = D24.start + 0.25 * DAY; // fraction 0.25
    const z = zoomWindow(view, D24, 145, centre, KEY_ZOOM_FACTOR);
    expect(z).not.toBeNull();
    const w = z as TimeWindow;
    expect(w.end - w.start).toBe(DAY / 2);
    expect((centre - w.start) / (w.end - w.start)).toBeCloseTo(0.25, 9);
    expect(Number.isInteger(w.start) && Number.isInteger(w.end)).toBe(true);

    // Non-integer centre: rounding widens outward and stays integer.
    const z2 = zoomWindow(view, D24, 145, D24.start + 1000.4, 3) as TimeWindow;
    expect(Number.isInteger(z2.start) && Number.isInteger(z2.end)).toBe(true);
    expect(z2.end - z2.start).toBeGreaterThanOrEqual(DAY / 3);
  });

  test("REQ-ZOOM-02: zoomWindow shifts the window inside the domain", () => {
    const view = { start: T0 - 2 * HOUR, end: T0 };
    // Zoom out ×0.25 near the domain end: width 8 h, centre at fraction 0.9 → would pass D.end.
    const z = zoomWindow(view, D24, 145, T0 - 0.2 * HOUR, 0.25) as TimeWindow;
    expect(z).toEqual({ start: T0 - 8 * HOUR, end: T0 });
    const early = { start: D24.start, end: D24.start + 2 * HOUR };
    const z2 = zoomWindow(early, D24, 145, D24.start + 60, 0.25) as TimeWindow;
    expect(z2).toEqual({ start: D24.start, end: D24.start + 8 * HOUR });
  });

  test("REQ-ZOOM-03: zoom-in stops at MIN_ZOOM_STEPS × step", () => {
    const { axis } = makeAxis(D24, null, 145);
    const centre = T0 - 5 * HOUR;
    for (let i = 0; i < 40; i++) axis.zoomAround(centre, KEY_ZOOM_FACTOR);
    const z = axis.zoom.value as TimeWindow;
    // w = 290 s; outward floor/ceil of a non-integer start may add one second (06 §2.4).
    expect(z.end - z.start).toBeGreaterThanOrEqual(290);
    expect(z.end - z.start).toBeLessThanOrEqual(291);
    expectValidZoom(z, D24, 145);
    // Further zoom-in at the limit writes nothing.
    let writes = 0;
    const off = axis.zoom.subscribe(() => writes++);
    writes = 0;
    axis.zoomAround(centre, KEY_ZOOM_FACTOR);
    expect(writes).toBe(0);
    off();
    axis.dispose();
  });

  test("REQ-ZOOM-03: zoom out to the full domain gives null", () => {
    expect(zoomWindow({ start: T0 - HOUR, end: T0 }, D24, 145, T0 - 1800, 0.001)).toBeNull();
    const { axis } = makeAxis(D24, { start: T0 - 4 * HOUR, end: T0 - 2 * HOUR });
    for (let i = 0; i < 6; i++) axis.zoomAround(T0 - 3 * HOUR, 1 / KEY_ZOOM_FACTOR);
    expect(axis.zoom.value).toBeNull();
    expect(axis.view.value).toEqual(D24);
    axis.dispose();
  });

  test("REQ-ZOOM-02: zoomAround ignores non-finite centre/factor and factor ≤ 0", () => {
    const z = { start: T0 - 4 * HOUR, end: T0 - 2 * HOUR };
    const { axis } = makeAxis(D24, z);
    axis.zoomAround(Number.NaN, 2);
    axis.zoomAround(T0 - 3 * HOUR, Number.POSITIVE_INFINITY);
    axis.zoomAround(T0 - 3 * HOUR, 0);
    axis.zoomAround(T0 - 3 * HOUR, -2);
    expect(axis.zoom.value).toBe(z);
    axis.dispose();
  });

  test("REQ-ZOOM-02: brushWindow is 'ignored' below 2 steps and handles reversed fractions", () => {
    // 24 h view, step 145: 2 steps = 290 s = 0.003356… of the view.
    expect(brushWindow(D24, D24, 145, 0.5, 0.5 + 289 / DAY)).toEqual({ kind: "ignored" });
    expect(brushWindow(D24, D24, 145, 0.5, 0.5)).toEqual({ kind: "ignored" });
    const fwd = brushWindow(D24, D24, 145, 0.25, 0.5);
    const rev = brushWindow(D24, D24, 145, 0.5, 0.25);
    expect(fwd).toEqual({ kind: "zoom", window: { start: D24.start + DAY / 4, end: D24.start + DAY / 2 } });
    expect(rev).toEqual(fwd);
    // Fractions outside [0,1] clamp; covering the whole domain clears the zoom.
    expect(brushWindow(D24, D24, 145, -1, 2)).toEqual({ kind: "zoom", window: null });
    expect(brushWindow(D24, D24, 145, Number.NaN, 0.5)).toEqual({ kind: "ignored" });
  });

  test("REQ-ZOOM-02: axis.brush zooms, ignores narrow brushes and reset clears", () => {
    const { axis } = makeAxis();
    axis.brush(0.5, 0.5 + 100 / DAY);
    expect(axis.zoom.value).toBeNull();
    axis.brush(0.75, 0.5);
    expect(axis.zoom.value).toEqual({ start: D24.start + DAY / 2, end: D24.start + 0.75 * DAY });
    axis.cursor.value = T0 - HOUR;
    axis.pinned.value = true;
    axis.reset();
    expect(axis.zoom.value).toBeNull();
    expect(axis.cursor.value).toBe(T0 - HOUR);
    expect(axis.pinned.value).toBe(true);
    axis.dispose();
  });

  test("REQ-ZOOM-03: normalizeZoom returns the identical object when already normalised", () => {
    const z = { start: T0 - 2 * HOUR, end: T0 - HOUR };
    expect(normalizeZoom(z, D24, 145)).toBe(z);
    const frac = { start: T0 - 2 * HOUR + 0.5, end: T0 - HOUR - 0.5 };
    expect(normalizeZoom(frac, D24, 145)).toEqual({ start: T0 - 2 * HOUR, end: T0 - HOUR });
    expect(normalizeZoom({ start: D24.start - 100, end: D24.start + HOUR }, D24, 145)).toEqual({
      start: D24.start,
      end: D24.start + HOUR,
    });
    expect(normalizeZoom(null, D24, 145)).toBeNull();
    expect(normalizeZoom({ start: T0 - 100, end: T0 }, D24, 145)).toBeNull(); // too narrow
    expect(normalizeZoom({ start: D24.start - 1, end: D24.end + 1 }, D24, 145)).toBeNull(); // equals domain
    expect(normalizeZoom({ start: T0 + 100, end: T0 + 5000 }, D24, 145)).toBeNull(); // outside
    expect(normalizeZoom({ start: Number.NaN, end: T0 }, D24, 145)).toBeNull();
  });

  test("REQ-ZOOM-03: every produced zoom is integer, inside the domain and ≥ MIN_ZOOM_STEPS × stepSeconds wide", () => {
    // Deterministic sweep over centres, factors, steps and brush pairs.
    let seed = 0x2f6e2b1;
    const rand = (): number => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    for (let i = 0; i < 500; i++) {
      const step = [60, 145, 1012][i % 3] as number;
      const { axis } = makeAxis(D24, null, step);
      for (let k = 0; k < 8; k++) {
        const op = rand();
        if (op < 0.4) axis.zoomAround(D24.start + rand() * DAY, rand() < 0.7 ? 1 + rand() * 20 : rand());
        else if (op < 0.8) axis.brush(rand() * 1.2 - 0.1, rand() * 1.2 - 0.1);
        else axis.zoom.value = { start: D24.start + rand() * DAY, end: D24.start + rand() * DAY + 10 };
        expectValidZoom(axis.zoom.value === null ? null : axis.view.value, D24, step);
        expectValidZoom(zoomWindow(axis.view.value, D24, step, D24.start + rand() * DAY, 1 + rand() * 50), D24, step);
        const b = brushWindow(axis.view.value, D24, step, rand(), rand());
        if (b.kind === "zoom") expectValidZoom(b.window, D24, step);
      }
      axis.dispose();
    }
  });

  test("REQ-ZOOM-03: a raw out-of-domain zoom write never reaches view", () => {
    const { axis } = makeAxis();
    axis.zoom.value = { start: D24.start - 500.5, end: D24.start + HOUR + 0.2 };
    expect(axis.view.value).toEqual({ start: D24.start, end: D24.start + HOUR + 1 });
    axis.dispose();
  });

  test("stepSeconds is sanitised to 1 when invalid", () => {
    expect(makeAxis(D24, null, 0).axis.stepSeconds.value).toBe(1);
    expect(makeAxis(D24, null, Number.NaN).axis.stepSeconds.value).toBe(1);
    expect(makeAxis(D24, null, 145).axis.stepSeconds.value).toBe(145);
  });

  test("domain is the same signal object; initial zoom is normalised", () => {
    const { domain, axis } = makeAxis(D24, { start: T0 - 2 * HOUR + 0.3, end: T0 - HOUR });
    expect(axis.domain).toBe(domain);
    expect(axis.zoom.value).toEqual({ start: T0 - 2 * HOUR, end: T0 - HOUR });
    expect(axis.cursor.value).toBeNull();
    expect(axis.pinned.value).toBe(false);
    axis.dispose();
  });

  test("degenerate domain (06 §2.9): view = domain, mapping 0/start, zoom disabled", () => {
    const d = { start: T0, end: T0 };
    const { axis } = makeAxis(d, { start: T0 - HOUR, end: T0 });
    expect(axis.zoom.value).toBeNull();
    expect(axis.view.value).toEqual(d);
    expect(axis.toFraction(T0 + 50)).toBe(0);
    expect(axis.fromFraction(0.5)).toBe(T0);
    axis.zoomAround(T0, 2);
    axis.brush(0, 1);
    expect(axis.zoom.value).toBeNull();
    axis.dispose();

    const nan = makeAxis({ start: Number.NaN, end: Number.NaN }).axis;
    expect(nan.toFraction(5)).toBe(0);
    nan.zoomAround(5, 2);
    expect(nan.zoom.value).toBeNull();
    nan.dispose();
  });
});

describe("domain effect (06 §2.5)", () => {
  test("clamps a partially overlapping zoom into the new domain", () => {
    const { domain, axis } = makeAxis(D24, { start: T0 - 2 * HOUR, end: T0 - HOUR });
    domain.value = { start: T0 - 1.5 * HOUR, end: T0 + 22.5 * HOUR };
    expect(axis.zoom.value).toEqual({ start: T0 - 1.5 * HOUR, end: T0 - HOUR });
    axis.dispose();
  });

  test("keeps a zoom fully inside the new domain (identity)", () => {
    const z = { start: T0 - 2 * HOUR, end: T0 - HOUR };
    const { domain, axis } = makeAxis(D24, z);
    domain.value = { start: T0 - 6 * HOUR, end: T0 };
    expect(axis.zoom.value).toBe(z);
    axis.dispose();
  });

  test("clears a zoom outside the new domain", () => {
    const { domain, axis } = makeAxis(D24, { start: D24.start, end: D24.start + HOUR });
    domain.value = { start: T0 - HOUR, end: T0 };
    expect(axis.zoom.value).toBeNull();
    expect(axis.view.value).toEqual({ start: T0 - HOUR, end: T0 });
    axis.dispose();
  });

  test("clears a zoom narrower than MIN_ZOOM_STEPS × the grown step", () => {
    const { axis } = makeAxis(D24, { start: T0 - 400, end: T0 - 100 }, 145);
    expect(axis.zoom.value).toEqual({ start: T0 - 400, end: T0 - 100 });
    axis.stepSeconds.value = 1012;
    expect(axis.zoom.value).toBeNull();
    axis.dispose();
  });

  test("keeps a URL zoom restored with the domain in one batch()", () => {
    const { domain, axis } = makeAxis({ start: T0 - HOUR, end: T0 }, null, 60);
    const oldEnd = T0 - 3 * DAY;
    const z = { start: oldEnd - 3 * HOUR, end: oldEnd - 2 * HOUR };
    batch(() => {
      domain.value = { start: oldEnd - DAY, end: oldEnd };
      axis.stepSeconds.value = 145;
      axis.zoom.value = z;
    });
    expect(axis.zoom.value).toBe(z);
    expect(axis.view.value).toBe(z);
    axis.dispose();
  });

  test("stops reacting after dispose(); dispose is idempotent", () => {
    const z = { start: D24.start, end: D24.start + HOUR };
    const { domain, axis } = makeAxis(D24, z);
    axis.dispose();
    axis.dispose();
    domain.value = { start: T0 - HOUR, end: T0 };
    expect(axis.zoom.value).toBe(z); // not cleared by the stopped effect
    expect(axis.view.value).toEqual({ start: T0 - HOUR, end: T0 }); // view still normalises on read
    axis.reset();
    expect(axis.zoom.value).toBeNull(); // methods keep working
  });
});

describe("formatStepLabel (REQ-ZOOM-03)", () => {
  test("REQ-ZOOM-03: '30 s', '5 min', '1 h', 'unknown'", () => {
    expect(formatStepLabel(30)).toBe("30 s");
    expect(formatStepLabel(60)).toBe("60 s");
    expect(formatStepLabel(145)).toBe("2 min");
    expect(formatStepLabel(300)).toBe("5 min");
    expect(formatStepLabel(1012)).toBe("17 min");
    expect(formatStepLabel(3600)).toBe("1 h");
    expect(formatStepLabel(5400)).toBe("1.5 h");
    expect(formatStepLabel(0)).toBe("unknown");
    expect(formatStepLabel(-5)).toBe("unknown");
    expect(formatStepLabel(Number.NaN)).toBe("unknown");
    expect(formatStepLabel(Number.POSITIVE_INFINITY)).toBe("unknown");
  });
});

/** A virtual-clock scheduler: timers fire only when the test advances time. */
function fakeScheduler(start = 1_000_000) {
  let now = start;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const scheduled: number[] = [];
  const sch: LiveFollowScheduler = {
    now: () => now,
    setTimeout(fn, ms) {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      scheduled.push(ms);
      return id;
    },
    clearTimeout(handle) {
      timers.delete(handle as number);
    },
  };
  /** Advance time, firing due timers in order at their due time. */
  function advance(ms: number): void {
    const target = now + ms;
    for (;;) {
      let due: [number, { at: number; fn: () => void }] | null = null;
      for (const entry of timers) if (entry[1].at <= target && (due === null || entry[1].at < due[1].at)) due = entry;
      if (due === null) break;
      timers.delete(due[0]);
      now = Math.max(now, due[1].at);
      due[1].fn();
    }
    now = target;
  }
  /** Jump the clock without firing (a throttled tab), then fire whatever is due exactly once each. */
  function sleepThenWake(ms: number): void {
    now += ms;
    const due = [...timers].filter(([, t]) => t.at <= now);
    for (const [id, t] of due) {
      timers.delete(id);
      t.fn();
    }
  }
  return { sch, advance, sleepThenWake, pending: () => timers.size, scheduled };
}

describe("createLiveFollow (REQ-FOLLOW-01, REQ-FOLLOW-02, CON-08)", () => {
  const I = 60_000;
  let errorSpy: ReturnType<typeof spyOn> | null = null;
  let warnSpy: ReturnType<typeof spyOn> | null = null;
  afterEach(() => {
    errorSpy?.mockRestore();
    warnSpy?.mockRestore();
    errorSpy = null;
    warnSpy = null;
  });

  test("REQ-FOLLOW-01: no tick at mount; exactly one tick per interval (CON-08: data refresh only)", () => {
    const f = fakeScheduler();
    const isLive = signal(true);
    let ticks = 0;
    const follow = createLiveFollow({ intervalMs: I, isLive, onTick: () => ticks++, scheduler: f.sch });
    expect(ticks).toBe(0);
    expect(follow.lastTickAt.value).toBeNull();
    f.advance(I - 1);
    expect(ticks).toBe(0);
    f.advance(1);
    expect(ticks).toBe(1);
    expect(follow.lastTickAt.value).toBe(1_000_000 + I);
    f.advance(5 * I);
    expect(ticks).toBe(6);
    expect(f.pending()).toBe(1); // a single chained timeout, never a burst
    follow.dispose();
  });

  test("REQ-FOLLOW-02: no tick while paused, so no refetch; immediate tick on resume", () => {
    const f = fakeScheduler();
    const isLive = signal(true);
    let ticks = 0;
    const follow = createLiveFollow({ intervalMs: I, isLive, onTick: () => ticks++, scheduler: f.sch });
    f.advance(I / 2);
    isLive.value = false;
    expect(f.pending()).toBe(0);
    f.advance(10 * I);
    expect(ticks).toBe(0);
    isLive.value = true;
    expect(f.scheduled.at(-1)).toBe(0);
    f.advance(0);
    expect(ticks).toBe(1);
    f.advance(I - 1);
    expect(ticks).toBe(1);
    f.advance(1);
    expect(ticks).toBe(2);
    follow.dispose();
  });

  test("REQ-FOLLOW-02: created while paused → no tick until resume, then immediate", () => {
    const f = fakeScheduler();
    const isLive = signal(false);
    let ticks = 0;
    const follow = createLiveFollow({ intervalMs: I, isLive, onTick: () => ticks++, scheduler: f.sch });
    f.advance(3 * I);
    expect(ticks).toBe(0);
    isLive.value = true;
    f.advance(0);
    expect(ticks).toBe(1);
    follow.dispose();
  });

  test("REQ-FOLLOW-01: a late timer fires once without catch-up; next tick scheduled from fire time", () => {
    const f = fakeScheduler();
    const isLive = signal(true);
    const at: number[] = [];
    const follow = createLiveFollow({ intervalMs: I, isLive, onTick: () => at.push(f.sch.now()), scheduler: f.sch });
    f.sleepThenWake(3.5 * I); // throttled background tab
    expect(at).toEqual([1_000_000 + 3.5 * I]);
    expect(f.pending()).toBe(1);
    f.advance(I - 1);
    expect(at.length).toBe(1);
    f.advance(1);
    expect(at).toEqual([1_000_000 + 3.5 * I, 1_000_000 + 4.5 * I]);
    follow.dispose();
  });

  test("REQ-FOLLOW-01: an onTick throw is logged and does not stop the cadence", () => {
    errorSpy = spyOn(console, "error").mockImplementation(() => {});
    const f = fakeScheduler();
    const isLive = signal(true);
    let calls = 0;
    const follow = createLiveFollow({
      intervalMs: I,
      isLive,
      onTick: () => {
        calls++;
        if (calls === 1) throw new Error("boom");
      },
      scheduler: f.sch,
    });
    f.advance(I);
    expect(calls).toBe(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(follow.lastTickAt.value).toBe(1_000_000 + I);
    f.advance(2 * I);
    expect(calls).toBe(3);
    follow.dispose();
  });

  test("REQ-FOLLOW-01: dispose() stops further ticks and is idempotent", () => {
    const f = fakeScheduler();
    const isLive = signal(true);
    let ticks = 0;
    const follow = createLiveFollow({ intervalMs: I, isLive, onTick: () => ticks++, scheduler: f.sch });
    f.advance(I);
    follow.dispose();
    follow.dispose();
    expect(f.pending()).toBe(0);
    f.advance(5 * I);
    isLive.value = false;
    isLive.value = true;
    f.advance(5 * I);
    expect(ticks).toBe(1);
  });

  test("REQ-FOLLOW-02: onTick that pauses (isLive false) schedules nothing further", () => {
    const f = fakeScheduler();
    const isLive = signal(true);
    let ticks = 0;
    const follow = createLiveFollow({
      intervalMs: I,
      isLive,
      onTick: () => {
        ticks++;
        isLive.value = false;
      },
      scheduler: f.sch,
    });
    f.advance(10 * I);
    expect(ticks).toBe(1);
    expect(f.pending()).toBe(0);
    follow.dispose();
  });

  test("an invalid interval falls back to 60 000 ms with a console.warn", () => {
    warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const f = fakeScheduler();
      let ticks = 0;
      const follow = createLiveFollow({ intervalMs: bad, isLive: signal(true), onTick: () => ticks++, scheduler: f.sch });
      expect(f.scheduled[0]).toBe(60_000);
      f.advance(60_000);
      expect(ticks).toBe(1);
      follow.dispose();
    }
    expect(warnSpy).toHaveBeenCalledTimes(4);
  });
});
