// Page-wide time axis (zoom, cursor, pin, step) and the live-follow data-refresh timer (06 §2).
// Pure .ts over @preact/signals-core: no DOM, no feature-local imports, never throws (00 §8.1).

import { batch, computed, effect, signal } from "@preact/signals-core";
import type { ReadonlySignal, Signal } from "@preact/signals-core";

/** A half-open time window in epoch seconds. */
export interface TimeWindow {
  /** Inclusive window start, epoch seconds. */ readonly start: number;
  /** Exclusive window end, epoch seconds. */ readonly end: number;
}

/** Page-wide time state shared by every lane, the swimlane and every chart (D2). */
export interface TimeAxis {
  /** Full fetched range window (end − range … end). */ readonly domain: ReadonlySignal<TimeWindow>;
  /** Zoom window, or null when showing the full domain. */ readonly zoom: Signal<TimeWindow | null>;
  /** Visible window = zoom ?? domain. */ readonly view: ReadonlySignal<TimeWindow>;
  /** Cursor time in epoch seconds, or null when no cursor. */ readonly cursor: Signal<number | null>;
  /** Whether the cursor is pinned (click/Enter); a pin pauses live follow. */ readonly pinned: Signal<boolean>;
  /** Effective resolution (seconds) of the current range's data, displayed in controls. */ readonly stepSeconds: Signal<number>;
  /** Map epoch seconds → x fraction of the visible window ([0,1] inside it; unclamped outside, 06 §2.3). */ toFraction(t: number): number;
  /** Map x fraction → epoch seconds (clamped to the visible window). */ fromFraction(f: number): number;
  /** Zoom in/out by factor around a centre time; clamps to domain and to ≥ MIN_ZOOM_STEPS steps. */ zoomAround(centre: number, factor: number): void;
  /** Set zoom from a brushed fraction pair; ignores brushes narrower than MIN_ZOOM_STEPS steps. */ brush(f0: number, f1: number): void;
  /** Clear zoom (reset control). */ reset(): void;
}

/** Construction options for createTimeAxis. */
export interface TimeAxisOptions {
  /** The fetched domain; recomputed from (range, end) by the view. */ readonly domain: ReadonlySignal<TimeWindow>;
  /** Initial zoom decoded from the URL, or null. */ readonly initialZoom: TimeWindow | null;
  /** Initial effective step in seconds (updated when history arrives). */ readonly initialStepSeconds: number;
}

/** Minimum zoom width in effective steps (REQ-ZOOM-03). */
export const MIN_ZOOM_STEPS = 2;
/** Keyboard zoom factor for "+"/"-" (tech-spec §3.10). */
export const KEY_ZOOM_FACTOR = 2;
/** Shift+arrow cursor jump in steps. */
export const CURSOR_BIG_STEP = 10;

/**
 * A bidirectional time ↔ x-fraction mapping. `TimeAxis` satisfies it (linear over `view`);
 * `chartFractionMap` (chart-data.ts) returns a non-linear one for DST-shifted charts (§4.5).
 */
export interface FractionMap {
  /** Map epoch seconds to an x fraction of the mapped box. Not clamped: values outside [0,1] mean "outside the box". */
  toFraction(t: number): number;
  /** Map an x fraction (clamped to [0,1]) to epoch seconds. */
  fromFraction(f: number): number;
}

/**
 * The object `createTimeAxis` returns: a `TimeAxis` plus a disposer for its internal
 * domain-normalisation effect (§2.5). Assignable to `TimeAxis` everywhere.
 */
export interface TimeAxisController extends TimeAxis {
  /** Stop the internal domain/step effect. Idempotent. Call on unmount of the owning view. */
  dispose(): void;
}

/** Outcome of a brush gesture (§2.4). */
export type BrushResult =
  /** The brush was narrower than MIN_ZOOM_STEPS × step; zoom unchanged. */
  | { readonly kind: "ignored" }
  /** Zoom to `window`; null means "the brush covered the whole domain" (zoom cleared). */
  | { readonly kind: "zoom"; readonly window: TimeWindow | null };

/** A positive finite step, else 1 s (06 §2.2 sanitizeStep, §2.9). */
function sanitizeStep(s: number): number {
  return Number.isFinite(s) && s > 0 ? s : 1;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** True when the window has finite bounds and positive width (06 §2.9). */
function isUsable(w: TimeWindow): boolean {
  return Number.isFinite(w.start) && Number.isFinite(w.end) && w.end > w.start;
}

function sameWindow(a: TimeWindow | null, b: TimeWindow | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return a.start === b.start && a.end === b.end;
}

/**
 * Clamp a cursor time into the visible window. The window is half-open, so the latest
 * cursor position is `view.end − 0.001` (a segment ending at view.end still resolves).
 * Non-finite `t` → null.
 */
export function clampCursor(t: number, view: TimeWindow): number | null {
  if (!Number.isFinite(t) || !Number.isFinite(view.start) || !Number.isFinite(view.end)) return null;
  const latest = Math.max(view.start, view.end - 0.001);
  return clamp(t, view.start, latest);
}

/** Minimum zoom width in seconds: min(MIN_ZOOM_STEPS × step, Dw). */
export function minZoomWidth(stepSeconds: number, domain: TimeWindow): number {
  return Math.min(MIN_ZOOM_STEPS * sanitizeStep(stepSeconds), domain.end - domain.start);
}

/**
 * Normalise a zoom window against the domain:
 *   start = max(D.start, floor(z.start)); end = min(D.end, ceil(z.end));
 *   end − start < MIN_ZOOM_STEPS × step  → null   (too narrow or empty after clamping)
 *   start ≤ D.start && end ≥ D.end       → null   (equals the domain = no zoom)
 *   else { start, end } — returns the SAME object `z` when already normalised (identity-stable).
 * Non-finite fields → null.
 */
export function normalizeZoom(z: TimeWindow | null, domain: TimeWindow, stepSeconds: number): TimeWindow | null {
  if (z === null) return null;
  if (!Number.isFinite(z.start) || !Number.isFinite(z.end)) return null;
  if (!Number.isFinite(domain.start) || !Number.isFinite(domain.end)) return null;
  const start = Math.max(domain.start, Math.floor(z.start));
  const end = Math.min(domain.end, Math.ceil(z.end));
  if (end - start < MIN_ZOOM_STEPS * sanitizeStep(stepSeconds)) return null;
  if (start <= domain.start && end >= domain.end) return null;
  return start === z.start && end === z.end ? z : { start, end };
}

/**
 * Zoom around `centre` by `factor` (> 1 zooms in, < 1 zooms out). Keeps `centre` at the same
 * x fraction, then shifts the window inside the domain and rounds outward to integer seconds.
 * Returns null for the full domain. Invalid input (non-finite centre/factor, factor ≤ 0, degenerate
 * domain) leaves the view unchanged: the result is the normalised current view.
 */
export function zoomWindow(view: TimeWindow, domain: TimeWindow, stepSeconds: number, centre: number, factor: number): TimeWindow | null {
  if (!isUsable(domain) || !isUsable(view) || !Number.isFinite(centre) || !Number.isFinite(factor) || factor <= 0) {
    return normalizeZoom(view, domain, stepSeconds);
  }
  const vw = view.end - view.start;
  const dw = domain.end - domain.start;
  const w = clamp(vw / factor, minZoomWidth(stepSeconds, domain), dw);
  const c = clamp(centre, view.start, view.end);
  const r = vw > 0 ? (c - view.start) / vw : 0.5;
  let s = c - r * w;
  let e = s + w;
  if (s < domain.start) {
    s = domain.start;
    e = s + w;
  }
  if (e > domain.end) {
    e = domain.end;
    s = e - w;
  }
  s = Math.max(domain.start, Math.floor(s));
  e = Math.min(domain.end, Math.ceil(e));
  return e - s >= dw ? null : { start: s, end: e };
}

/**
 * Convert a brushed fraction pair (fractions of `view`, any order) into a zoom decision.
 * Narrower than MIN_ZOOM_STEPS × step → "ignored"; a brush over the whole domain → zoom null.
 */
export function brushWindow(view: TimeWindow, domain: TimeWindow, stepSeconds: number, f0: number, f1: number): BrushResult {
  if (!isUsable(domain) || !isUsable(view) || !Number.isFinite(f0) || !Number.isFinite(f1)) {
    return { kind: "ignored" };
  }
  const vw = view.end - view.start;
  const a = clamp(Math.min(f0, f1), 0, 1);
  const b = clamp(Math.max(f0, f1), 0, 1);
  const t0 = view.start + a * vw;
  const t1 = view.start + b * vw;
  if (t1 - t0 < MIN_ZOOM_STEPS * sanitizeStep(stepSeconds)) return { kind: "ignored" };
  return { kind: "zoom", window: normalizeZoom({ start: t0, end: t1 }, domain, stepSeconds) };
}

/**
 * Human label for an effective step (REQ-ZOOM-03), e.g. 30 → "30 s", 300 → "5 min", 3600 → "1 h".
 * < 120 s → "{s} s"; < 3600 s → "{round(s/60)} min"; else "{s/3600 to 1 decimal} h".
 * Non-finite or ≤ 0 → "unknown". Callers render "resolution: {label}".
 */
export function formatStepLabel(stepSeconds: number): string {
  if (!Number.isFinite(stepSeconds) || stepSeconds <= 0) return "unknown";
  if (stepSeconds < 120) return `${stepSeconds} s`;
  if (stepSeconds < 3600) return `${Math.round(stepSeconds / 60)} min`;
  return `${Math.round(stepSeconds / 360) / 10} h`;
}

/**
 * Create the page-wide time-axis controller (D2, tech-spec §3.7; REQ-ZOOM-01..03, REQ-CHART-03).
 * Owns the zoom, cursor, pin and step signals; `domain` is supplied by the owning view.
 * A degenerate domain is tolerated (§2.9) but disables zoom.
 *
 * @param opts - Domain signal, URL-decoded initial zoom, initial step (00 §5.6).
 * @returns A controller; call `dispose()` when the owning view unmounts.
 */
export function createTimeAxis(opts: TimeAxisOptions): TimeAxisController {
  const domain = opts.domain;
  const stepSeconds = signal(sanitizeStep(opts.initialStepSeconds));
  const zoom = signal<TimeWindow | null>(normalizeZoom(opts.initialZoom, domain.peek(), stepSeconds.peek()));
  const view = computed(() => normalizeZoom(zoom.value, domain.value, stepSeconds.value) ?? domain.value);
  const cursor = signal<number | null>(null);
  const pinned = signal(false);

  const stop = effect(() => {
    const d = domain.value; // subscribe: domain changes (range change, live advance, end change)
    const step = stepSeconds.value; // subscribe: step changes (a new range's payload)
    const z = zoom.peek(); // do NOT subscribe to zoom (writes below would loop)
    if (z === null) return;
    const n = normalizeZoom(z, d, step);
    if (n !== z) zoom.value = n; // clamp into the new domain, or clear when too narrow/outside
  });
  let disposed = false;

  const writeZoom = (next: TimeWindow | null): void => {
    if (!sameWindow(zoom.peek(), next)) zoom.value = next;
  };

  return {
    domain,
    zoom,
    view,
    cursor,
    pinned,
    stepSeconds,
    toFraction(t: number): number {
      const v = view.peek();
      const vw = v.end - v.start;
      return vw > 0 ? (t - v.start) / vw : 0;
    },
    fromFraction(f: number): number {
      const v = view.peek();
      const vw = v.end - v.start;
      if (!(vw > 0) || !Number.isFinite(f)) return v.start;
      return v.start + clamp(f, 0, 1) * vw;
    },
    zoomAround(centre: number, factor: number): void {
      if (!Number.isFinite(centre) || !Number.isFinite(factor) || factor <= 0) return;
      const d = domain.peek();
      if (!isUsable(d)) return;
      batch(() => writeZoom(zoomWindow(view.peek(), d, stepSeconds.peek(), centre, factor)));
    },
    brush(f0: number, f1: number): void {
      const d = domain.peek();
      if (!isUsable(d)) return;
      const r = brushWindow(view.peek(), d, stepSeconds.peek(), f0, f1);
      if (r.kind === "zoom") writeZoom(r.window);
    },
    reset(): void {
      writeZoom(null);
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      stop();
    },
  };
}

/** Timer functions, injectable for deterministic tests. Defaults to globalThis timers + Date.now. */
export interface LiveFollowScheduler {
  /** Current epoch ms. */ now(): number;
  /** Schedule `fn` after `ms`; returns an opaque handle. */ setTimeout(fn: () => void, ms: number): unknown;
  /** Cancel a handle returned by `setTimeout`. */ clearTimeout(handle: unknown): void;
}

/** Options for createLiveFollow. */
export interface LiveFollowOptions {
  /** Tick period in ms; callers pass LIVE_REFRESH_MS (60 000) from history/client.ts. Invalid (≤ 0, non-finite) → 60 000 with a console.warn. */
  readonly intervalMs: number;
  /** True while the view is following now (§2.7 pause contract; wired by `07` §3.5; the engine view does not use live follow). */
  readonly isLive: ReadonlySignal<boolean>;
  /** Advance `end = now` and re-key live requests. Never called inside a signal effect (untracked). */
  readonly onTick: () => void;
  /** Optional timer injection (tests). */
  readonly scheduler?: LiveFollowScheduler;
}

/** A running live-follow timer. */
export interface LiveFollow {
  /** Epoch ms of the last tick, or null before the first. Diagnostic and test hook. */
  readonly lastTickAt: ReadonlySignal<number | null>;
  /** Stop observing `isLive` and cancel any pending tick. Idempotent. */
  dispose(): void;
}

/** Fallback period when `intervalMs` is invalid (the LIVE_REFRESH_MS value; not redeclared here). */
const FALLBACK_INTERVAL_MS = 60_000;

// Bare timer calls (not `globalThis.`): identical in browsers, and under the DOM test harness they
// resolve to the runtime's timers rather than a replaced (possibly already closed) window global.
const defaultScheduler: LiveFollowScheduler = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as Parameters<typeof clearTimeout>[0]),
};

/**
 * A view-owned data-refresh timer (tech-spec §3.7). This is NOT a rotation timer (CON-08, REQ-KIOSK-04);
 * the shell owns rotation.
 * - Created while live: the first tick fires intervalMs after creation (no tick at mount).
 * - While live: exactly one tick per intervalMs, scheduled from the actual fire time (no catch-up burst).
 * - live → paused: the pending tick is cancelled; no tick fires while paused (§2.7).
 * - paused → live (resume): a tick fires immediately (a 0 ms timeout), then every intervalMs.
 */
export function createLiveFollow(opts: LiveFollowOptions): LiveFollow {
  const sch = opts.scheduler ?? defaultScheduler;
  const valid = Number.isFinite(opts.intervalMs) && opts.intervalMs > 0;
  if (!valid) console.warn(`[timeline] invalid live-follow interval ${String(opts.intervalMs)}; using ${FALLBACK_INTERVAL_MS} ms`);
  const interval = valid ? opts.intervalMs : FALLBACK_INTERVAL_MS;
  const lastTickAt = signal<number | null>(null);
  let handle: unknown = null;
  let first = true;
  let disposed = false;

  const schedule = (ms: number): void => {
    if (handle !== null) sch.clearTimeout(handle);
    handle = sch.setTimeout(tick, ms);
  };
  function tick(): void {
    handle = null;
    if (disposed || !opts.isLive.peek()) return;
    try {
      opts.onTick();
    } catch (err) {
      console.error("[timeline] live-follow tick failed", err);
    }
    lastTickAt.value = sch.now();
    if (!disposed && opts.isLive.peek()) schedule(interval);
  }
  const stop = effect(() => {
    const live = opts.isLive.value; // the only tracked read
    if (live) schedule(first ? interval : 0); // resume → immediate
    else if (handle !== null) {
      sch.clearTimeout(handle);
      handle = null;
    }
    first = false;
  });
  return {
    lastTickAt,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      stop();
      if (handle !== null) sch.clearTimeout(handle);
      handle = null;
    },
  };
}
