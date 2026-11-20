// Deterministic fakes for the push suites: a manual clock, manual timers, a seeded entropy source and an in-memory
// file seam.

import { dirname } from "node:path";

import type { AtomicWriteOptions, AtomicWriteResult, AtomicWriteStep } from "../../../src/server/mutations/stores/atomic-file.js";
import type { PushFs } from "../../../src/server/push/data-dir.js";
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
  /** Run exactly the next timer (advancing the clock to its due time when later). Returns false when none is set. */
  step(): boolean;
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
    step: () => {
      const t = next();
      if (t === undefined) return false;
      if (t.due > clock.nowMs()) clock.set(t.due);
      fire(t);
      return true;
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

/** The operations of {@link memoryPushFs} that can be told to fail. `storeWrite` is the atomic store writer. */
export type MemoryFsOp = "mkdir" | "writeFile" | "unlink" | "readFile" | "storeWrite";

/** How an operation fails: an errno code, and for `storeWrite` the atomic-write step reported. */
export interface MemoryFsFailure {
  /** Errno code carried by the rejection (or reported by `storeWrite`); null for an error without a code. */
  readonly code: string | null;
  /** `storeWrite` only: the failing step (default "rename"). */
  readonly step?: AtomicWriteStep;
}

/** One file held by {@link memoryPushFs}. */
export interface MemoryFile {
  /** Current content (a private copy). */
  readonly bytes: Uint8Array;
  /** Mode it was written with. */
  readonly mode: number;
}

/** An in-memory PushFs plus the registry store's read/write seams, with on-demand failures. */
export interface MemoryPushFs extends PushFs {
  /** Files by absolute path. */
  readonly files: Map<string, MemoryFile>;
  /** Directories by absolute path → mode. "/" always exists. */
  readonly dirs: Map<string, number>;
  /** Every call, in order, as `<op> <path>`. */
  readonly calls: string[];
  /** Store reader (same as `readFile`): `DeviceStoreDeps.readFile`. */
  storeReadFile(path: string): Promise<Uint8Array>;
  /** Store writer with the atomic-write contract: never rejects, resolves `{ok:false, kind:"io"}` on failure. */
  storeWriteFile(path: string, bytes: Uint8Array, options: AtomicWriteOptions): Promise<AtomicWriteResult>;
  /** Fail the next call of `op` (queued; each queued failure is used once, before any `failAlways`). */
  failNext(op: MemoryFsOp, failure: MemoryFsFailure): void;
  /** Fail every call of `op` until cleared with `null`. */
  failAlways(op: MemoryFsOp, failure: MemoryFsFailure | null): void;
  /** Seed a file directly (creates its parent directories). */
  seed(path: string, content: Uint8Array | string, mode?: number): void;
  /** The file's content as UTF-8, or undefined. */
  text(path: string): string | undefined;
}

function fsError(code: string | null): Error {
  const err = new Error(code ?? "simulated failure") as Error & { code?: string };
  if (code !== null) err.code = code;
  return err;
}

/** Build an in-memory file seam. Writes require the parent directory to exist (ENOENT otherwise). */
export function memoryPushFs(): MemoryPushFs {
  const files = new Map<string, MemoryFile>();
  const dirs = new Map<string, number>([["/", 0o755]]);
  const calls: string[] = [];
  const once = new Map<MemoryFsOp, MemoryFsFailure[]>();
  const always = new Map<MemoryFsOp, MemoryFsFailure>();

  const takeFailure = (op: MemoryFsOp): MemoryFsFailure | undefined => {
    const queue = once.get(op);
    if (queue !== undefined && queue.length > 0) return queue.shift();
    return always.get(op);
  };
  const ensureDir = (path: string, mode: number): void => {
    if (dirs.has(path)) return;
    const parent = dirname(path);
    if (parent !== path) ensureDir(parent, mode);
    dirs.set(path, mode);
  };
  const putFile = (path: string, bytes: Uint8Array, mode: number): void => {
    if (!dirs.has(dirname(path))) throw fsError("ENOENT");
    if (dirs.has(path)) throw fsError("EISDIR");
    files.set(path, { bytes: bytes.slice(), mode });
  };
  const readFile = async (path: string): Promise<Uint8Array> => {
    calls.push(`readFile ${path}`);
    const failure = takeFailure("readFile");
    if (failure !== undefined) throw fsError(failure.code);
    if (dirs.has(path)) throw fsError("EISDIR");
    const file = files.get(path);
    if (file === undefined) throw fsError("ENOENT");
    return file.bytes.slice();
  };

  return {
    files,
    dirs,
    calls,
    mkdir: async (path, options) => {
      calls.push(`mkdir ${path}`);
      const failure = takeFailure("mkdir");
      if (failure !== undefined) throw fsError(failure.code);
      if (files.has(path)) throw fsError("EEXIST");
      ensureDir(path, options.mode);
      return undefined;
    },
    writeFile: async (path, data, options) => {
      calls.push(`writeFile ${path}`);
      const failure = takeFailure("writeFile");
      if (failure !== undefined) throw fsError(failure.code);
      putFile(path, data, options.mode);
    },
    unlink: async (path) => {
      calls.push(`unlink ${path}`);
      const failure = takeFailure("unlink");
      if (failure !== undefined) throw fsError(failure.code);
      if (!files.delete(path)) throw fsError("ENOENT");
    },
    readFile,
    storeReadFile: readFile,
    storeWriteFile: async (path, bytes, options) => {
      calls.push(`storeWrite ${path}`);
      const failure = takeFailure("storeWrite");
      if (failure !== undefined) {
        return { ok: false, kind: "io", step: failure.step ?? "rename", code: failure.code };
      }
      if (options.exclusive === true && files.has(path)) {
        return { ok: false, kind: "exists", step: "link", code: "EEXIST" };
      }
      try {
        putFile(path, bytes, options.mode ?? 0o640);
      } catch (err) {
        const code = (err as { code?: string }).code ?? null;
        return { ok: false, kind: "io", step: "open", code };
      }
      return { ok: true, durable: true };
    },
    failNext: (op, failure) => {
      const queue = once.get(op) ?? [];
      queue.push(failure);
      once.set(op, queue);
    },
    failAlways: (op, failure) => {
      if (failure === null) always.delete(op);
      else always.set(op, failure);
    },
    seed: (path, content, mode = 0o600) => {
      ensureDir(dirname(path), 0o700);
      const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
      files.set(path, { bytes: bytes.slice(), mode });
    },
    text: (path) => {
      const file = files.get(path);
      return file === undefined ? undefined : new TextDecoder().decode(file.bytes);
    },
  };
}
