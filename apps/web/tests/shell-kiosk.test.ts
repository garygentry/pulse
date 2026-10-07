// apps/web/tests/shell-kiosk.test.ts — kiosk rotation parsing + the clock-injected controller
// (07 §4). Pure (no DOM): `parseRotate` is table-tested against 07 §4.1, and `createKioskRotation`
// is driven by an injected FAKE clock so timer advance / navigate(replace:true) / stop() are
// deterministic (07 §6, tech-spec §3.7).

import { expect, test } from "bun:test";

import type { PathRouter, RouteMatch } from "../src/client/router.js";
import {
  createKioskRotation,
  DEFAULT_DWELL_MS,
  isKiosk,
  parseRotate,
  type Clock,
  type TimerHandle,
} from "../src/client/shell/kiosk.js";

const VIEW_IDS = ["overview", "alerts", "estate", "engine", "timeline"] as const;

// ─── isKiosk ────────────────────────────────────────────────────────────────────────────────────

test("isKiosk is true only for kiosk=1", () => {
  expect(isKiosk({ kiosk: "1" })).toBe(true);
  expect(isKiosk({ kiosk: "0" })).toBe(false);
  expect(isKiosk({})).toBe(false);
  expect(isKiosk({ kiosk: "true" })).toBe(false);
});

// ─── parseRotate (07 §4.1 worked-examples table) ──────────────────────────────────────────────────

test("parseRotate matches the 07 §4.1 table", () => {
  expect(parseRotate("overview,alerts:30s", VIEW_IDS)).toEqual([
    { viewId: "overview", dwellMs: DEFAULT_DWELL_MS },
    { viewId: "alerts", dwellMs: 30_000 },
  ]);
  expect(parseRotate("overview:5s,estate:10s", VIEW_IDS)).toEqual([
    { viewId: "overview", dwellMs: 5_000 },
    { viewId: "estate", dwellMs: 10_000 },
  ]);
  // unknown id dropped; rest kept.
  expect(parseRotate("overview,bogus,engine", VIEW_IDS)).toEqual([
    { viewId: "overview", dwellMs: DEFAULT_DWELL_MS },
    { viewId: "engine", dwellMs: DEFAULT_DWELL_MS },
  ]);
  // non-positive dwell → default (never a 0ms spin).
  expect(parseRotate("alerts:0s", VIEW_IDS)).toEqual([{ viewId: "alerts", dwellMs: DEFAULT_DWELL_MS }]);
  // malformed dwell → default.
  expect(parseRotate("alerts:abc", VIEW_IDS)).toEqual([{ viewId: "alerts", dwellMs: DEFAULT_DWELL_MS }]);
  // empty / whitespace → no rotation.
  expect(parseRotate("", VIEW_IDS)).toEqual([]);
  expect(parseRotate("   ", VIEW_IDS)).toEqual([]);
  // all ids unknown → no rotation.
  expect(parseRotate("nope,alsonope", VIEW_IDS)).toEqual([]);
  // duplicates allowed (a view may repeat).
  expect(parseRotate("overview,overview:5s", VIEW_IDS)).toEqual([
    { viewId: "overview", dwellMs: DEFAULT_DWELL_MS },
    { viewId: "overview", dwellMs: 5_000 },
  ]);
});

// ─── createKioskRotation (injected fake clock) ────────────────────────────────────────────────────

/** A controllable fake clock: only ever one timer is outstanding at a time (setTimeout chain). */
function makeFakeClock(): {
  clock: Clock;
  size: () => number;
  lastMs: () => number;
  fire: () => void;
} {
  const timers = new Map<TimerHandle, () => void>();
  let seq = 0;
  let lastMs = -1;
  const clock: Clock = {
    setTimeout(handler, ms) {
      seq += 1;
      timers.set(seq, handler);
      lastMs = ms;
      return seq;
    },
    clearTimeout(handle) {
      timers.delete(handle);
    },
  };
  return {
    clock,
    size: () => timers.size,
    lastMs: () => lastMs,
    fire() {
      const entries = [...timers.entries()];
      const last = entries[entries.length - 1];
      if (last === undefined) throw new Error("no pending timer to fire");
      timers.delete(last[0]);
      last[1]();
    },
  };
}

function makeFakeRouter(): { router: PathRouter; navs: { path: string; replace: boolean }[] } {
  const navs: { path: string; replace: boolean }[] = [];
  const router: PathRouter = {
    current: (): RouteMatch => ({ path: "/", view: "", params: {}, query: {} }),
    navigate: (path, opts) => {
      navs.push({ path, replace: opts?.replace === true });
    },
    subscribe: () => () => {},
    stop: () => {},
  };
  return { router, navs };
}

test("createKioskRotation advances via the injected clock and navigates replace:true", () => {
  const { clock, size, lastMs, fire } = makeFakeClock();
  const { router, navs } = makeFakeRouter();
  const steps = parseRotate("overview:5s,alerts:10s", VIEW_IDS); // [overview/5000, alerts/10000]

  const rotation = createKioskRotation({ router, steps, clock });
  rotation.start();

  // Armed for the CURRENT cursor (overview, 5000) — no navigation yet.
  expect(size()).toBe(1);
  expect(lastMs()).toBe(5_000);
  expect(navs).toEqual([]);

  // Fire → advance to alerts, navigate(replace), re-arm with alerts' dwell (10000).
  fire();
  expect(navs).toEqual([{ path: "/alerts", replace: true }]);
  expect(size()).toBe(1);
  expect(lastMs()).toBe(10_000);

  // Fire → wrap back to overview, re-arm with overview's dwell (5000).
  fire();
  expect(navs).toEqual([
    { path: "/alerts", replace: true },
    { path: "/overview", replace: true },
  ]);
  expect(lastMs()).toBe(5_000);

  // stop() clears the pending timer; no further navigations occur.
  rotation.stop();
  expect(size()).toBe(0);
  expect(navs).toHaveLength(2);
});

test("publishes shell-owned entry, dwell, index, total, and monotonic epoch", () => {
  const { clock, fire } = makeFakeClock();
  const { router } = makeFakeRouter();
  const contexts: Array<{ viewId: string; dwellMs: number; index: number; total: number; epoch: number }> = [];
  const steps = parseRotate("overview:5s,alerts:10s", VIEW_IDS);
  const rotation = createKioskRotation({
    router,
    steps,
    clock,
    initialViewId: "alerts",
    onContext: (context) => contexts.push({
      viewId: context.entry.viewId,
      dwellMs: context.entry.dwellMs,
      index: context.index,
      total: context.total,
      epoch: context.epoch,
    }),
  });
  rotation.start();
  expect(contexts[0]).toEqual({ viewId: "alerts", dwellMs: 10_000, index: 1, total: 2, epoch: 0 });
  fire();
  expect(contexts[1]).toEqual({ viewId: "overview", dwellMs: 5_000, index: 0, total: 2, epoch: 1 });
  rotation.stop();
});

test("start() is a no-op for empty steps or when already running; stop() is teardown-safe", () => {
  const { clock, size } = makeFakeClock();
  const { router, navs } = makeFakeRouter();

  const empty = createKioskRotation({ router, steps: [], clock });
  empty.start();
  expect(size()).toBe(0); // empty spec → no timer armed
  empty.stop(); // safe when never running

  const steps = parseRotate("overview,alerts", VIEW_IDS);
  const rotation = createKioskRotation({ router, steps, clock });
  rotation.start();
  rotation.start(); // second start is a no-op — still exactly one outstanding timer
  expect(size()).toBe(1);
  expect(navs).toEqual([]);

  rotation.stop();
  rotation.stop(); // idempotent
  expect(size()).toBe(0);
});
