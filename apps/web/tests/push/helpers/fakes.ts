// Deterministic fakes for the push suites: a manual clock, manual timers and a seeded entropy source.

import type { Timers } from "../../../src/server/push/dispatch/queue.js";
import type { Clock, RandomSource } from "../../../src/server/push/ids.js";

/** A manually advanced clock. */
export interface FakeClock extends Clock {
  /** Move time forward by `ms` (negative values move it backwards, for clock-skew tests). */
  advance(ms: number): void;
  /** Jump to an absolute epoch-millisecond instant. */
  set(ms: number): void;
}

/** A fake clock starting at `startMs`. */
export function createFakeClock(startMs: number): FakeClock {
  let now = startMs;
  return {
    nowMs: () => now,
    advance: (ms) => {
      now += ms;
    },
    set: (ms) => {
      now = ms;
    },
  };
}

/** Manual timers driven by a FakeClock. */
export interface FakeTimers extends Timers {
  /** Run every timer due at or before the clock's current time, in due-time then insertion order. Returns the count run. */
  runDue(): number;
  /**
   * Repeatedly advance the clock to the next due timer and run it until none remain. Throws after `maxSteps` runs
   * (an interval never ends on its own).
   */
  runAll(maxSteps?: number): number;
  /** Advance the clock by `ms`, running each timer at its own due time on the way. Returns the count run. */
  advance(ms: number): number;
  /** Number of scheduled (not yet fired or cancelled) timers. */
  pending(): number;
}

interface FakeTimer {
  readonly handle: { readonly fakeTimerId: number };
  readonly seq: number;
  due: number;
  readonly fn: () => void;
  /** Interval period, or null for a one-shot timeout. */
  readonly every: number | null;
}

/** Deterministic timers over `clock`: ordered by due time, then by insertion. */
export function createFakeTimers(clock: FakeClock): FakeTimers {
  const timers = new Map<object, FakeTimer>();
  let nextId = 1;
  let nextSeq = 1;

  const schedule = (fn: () => void, ms: number, every: number | null): unknown => {
    const handle = Object.freeze({ fakeTimerId: nextId++ });
    const delay = Number.isFinite(ms) && ms > 0 ? ms : 0;
    timers.set(handle, { handle, seq: nextSeq++, due: clock.nowMs() + delay, fn, every });
    return handle;
  };
  const cancel = (handle: unknown): void => {
    if (typeof handle === "object" && handle !== null) timers.delete(handle);
  };
  const next = (): FakeTimer | undefined => {
    let best: FakeTimer | undefined;
    for (const t of timers.values()) {
      if (best === undefined || t.due < best.due || (t.due === best.due && t.seq < best.seq)) best = t;
    }
    return best;
  };
  const fire = (t: FakeTimer): void => {
    if (t.every === null) {
      timers.delete(t.handle);
    } else {
      // Re-arm before running so the callback can cancel it; re-sequence so equal-due peers keep FIFO order.
      timers.delete(t.handle);
      timers.set(t.handle, { ...t, seq: nextSeq++, due: t.due + Math.max(1, t.every) });
    }
    t.fn();
  };

  const runUntil = (limit: number, maxSteps: number): number => {
    let ran = 0;
    for (let t = next(); t !== undefined && t.due <= limit; t = next()) {
      if (ran >= maxSteps) throw new Error(`fake timers: more than ${maxSteps} runs`);
      if (t.due > clock.nowMs()) clock.set(t.due);
      fire(t);
      ran++;
    }
    return ran;
  };

  return {
    setTimeout: (fn, ms) => schedule(fn, ms, null),
    clearTimeout: cancel,
    setInterval: (fn, ms) => schedule(fn, ms, ms),
    clearInterval: cancel,
    runDue: () => runUntil(clock.nowMs(), 100_000),
    runAll: (maxSteps = 10_000) => runUntil(Number.POSITIVE_INFINITY, maxSteps),
    advance: (ms) => {
      const target = clock.nowMs() + ms;
      const ran = runUntil(target, 100_000);
      clock.set(target);
      return ran;
    },
    pending: () => timers.size,
  };
}

/** A seeded RandomSource whose `bytes` (and `unit`) stream is fixed per seed. */
export function createSeededRandom(seed: number): RandomSource {
  // mulberry32: small, fast and deterministic; not cryptographic (tests only).
  let state = seed >>> 0;
  const nextU32 = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
  return {
    bytes: (n) => {
      const out = new Uint8Array(n);
      for (let i = 0; i < n; i++) out[i] = nextU32() & 0xff;
      return out;
    },
    unit: () => nextU32() / 4_294_967_296,
  };
}
