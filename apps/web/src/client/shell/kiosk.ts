// shell/kiosk.ts — kiosk flag, `?rotate=` parsing, and the clock-injected rotation controller
// (07 §2, §4). No DOM, no React: `parseRotate` is pure and `createKioskRotation` takes an injectable
// Clock seam so the whole subsystem is unit-testable with a fake clock (tech-spec §3.7). Rotation and
// the palette route ONLY through the router (no shadow route state) — deep-linkable and testable.

import type { PathRouter } from "../router.js";

/** One resolved step in a kiosk rotation: a validated view id and its dwell in milliseconds.
 *  Declared in 00-core-definitions.md §4.2, co-located here (07 §4.1) — imported, never redefined. */
export interface RotationStep {
  /** A view id known to VIEWS; unknown ids are dropped at parse time. */
  viewId: string;
  /** Dwell before advancing, in ms. Global default 30_000; per-item ":Ns" overrides it. */
  dwellMs: number;
}

/** True iff the app is in unattended kiosk mode. Read from store.route.query — never location. */
export function isKiosk(query: Readonly<Record<string, string>>): boolean {
  return query["kiosk"] === "1";
}

/** Global default dwell when a step gives no `:Ns` override (REQ-KIOSK-03: "30s default"). */
export const DEFAULT_DWELL_MS = 30_000;

/**
 * Parse a `?rotate=` spec into an ordered list of validated rotation steps.
 *
 * Syntax: a comma-separated list of `viewId` or `viewId:Ns`, e.g. `"overview,alerts:30s"`.
 *   - `:Ns` is a per-item dwell override in whole seconds (N > 0); absent → DEFAULT_DWELL_MS.
 *   - view ids are validated against `viewIds` (from VIEWS, 08); UNKNOWN ids are DROPPED, remaining
 *     valid ids are KEPT (partial specs still rotate).
 *   - empty input, whitespace-only, or a spec that yields no valid step → `[]` (NO rotation).
 * Never throws (REQ-ROBUST-01). Order is preserved; duplicates are allowed (a view may repeat).
 *
 * @param spec - the raw `store.route.query.rotate` value (may be "" / undefined-coerced to "")
 * @param viewIds - the set of valid view ids (VIEWS.map(v => v.id), 08)
 * @returns validated `RotationStep[]`; `[]` when there is nothing valid to rotate.
 */
export function parseRotate(spec: string, viewIds: readonly string[]): RotationStep[] {
  const valid = new Set(viewIds);
  const steps: RotationStep[] = [];
  for (const raw of spec.split(",")) {
    const item = raw.trim();
    if (item === "") continue;
    const colon = item.indexOf(":");
    const viewId = (colon === -1 ? item : item.slice(0, colon)).trim();
    if (!valid.has(viewId)) continue; // unknown id dropped
    steps.push({ viewId, dwellMs: parseDwell(colon === -1 ? "" : item.slice(colon + 1)) });
  }
  return steps;
}

/** `"30s"` → 30000; `"5s"` → 5000. Empty/malformed/non-positive → DEFAULT_DWELL_MS. */
function parseDwell(token: string): number {
  const m = /^(\d+)s$/.exec(token.trim());
  if (m === null) return DEFAULT_DWELL_MS;
  const seconds = Number(m[1]);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : DEFAULT_DWELL_MS;
}

/** Injectable timer seam so rotation is testable with a fake clock (tech-spec §3.7). Handles are
 *  opaque numbers (browser/happy-dom `setTimeout` returns a number). */
export type TimerHandle = number;

export interface Clock {
  setTimeout(handler: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

/** Default clock delegating to the ambient globals (used in production; tests inject a fake). */
export const realClock: Clock = {
  setTimeout: (handler, ms) => globalThis.setTimeout(handler, ms) as unknown as TimerHandle,
  clearTimeout: (handle) => globalThis.clearTimeout(handle),
};

export interface RotationContext {
  /** Active validated entry. */ readonly entry: RotationStep;
  /** Zero-based active entry index. */ readonly index: number;
  /** Total validated entries. */ readonly total: number;
  /** Monotonic shell-owned epoch, incremented after every advance. */ readonly epoch: number;
}

export interface KioskRotationOptions {
  /** The router — each advance calls `navigate("/" + viewId, { replace: true })` (REQ-KIOSK-04). */
  router: PathRouter;
  /** Validated steps from `parseRotate`. An empty array makes `start()` a no-op. */
  steps: readonly RotationStep[];
  /** View shown when the controller starts; selects the matching rotation cursor when present. */
  initialViewId?: string;
  /** Readonly context publication; the shell remains the sole timer owner. */
  onContext?: (context: RotationContext) => void;
  /** Timer seam. Default `realClock`; tests pass a controllable fake (INJECTION SEAM). */
  clock?: Clock;
}

/** A running (or stoppable) rotation. `start`/`stop` are idempotent. */
export interface KioskRotation {
  /** Begin the setTimeout chain from the current cursor. No-op if steps is empty or already running. */
  start(): void;
  /** Cancel any pending timer and mark stopped. Safe to call when not running (teardown-safe). */
  stop(): void;
}

/**
 * Create a `setTimeout`-chained kiosk rotation controller (REQ-KIOSK-03/04).
 *
 * Behavior: the cursor starts at the entry matching `initialViewId`, falling back to step 0, and
 * publishes its readonly context before arming. After `steps[cursor].dwellMs` it advances the
 * cursor, increments the epoch, publishes the next context, and calls
 * `router.navigate("/" + steps[cursor].viewId, { replace: true })` — replace so kiosk cycling does
 * NOT pollute history — and re-arms the timer with the NEW cursor's dwell. Only one timer is ever
 * outstanding. `stop()` clears it; active views never own a competing timer.
 *
 * @param opts - router, steps, and (optionally) an injected clock
 * @returns a `KioskRotation` handle
 */
export function createKioskRotation(opts: KioskRotationOptions): KioskRotation {
  const clock = opts.clock ?? realClock;
  const steps = opts.steps;
  const initialIndex = opts.initialViewId === undefined
    ? -1
    : steps.findIndex((step) => step.viewId === opts.initialViewId);
  let cursor = initialIndex >= 0 ? initialIndex : 0;
  let epoch = 0;
  let handle: TimerHandle | null = null;

  const publish = (): void => {
    const entry = steps[cursor];
    if (entry !== undefined) opts.onContext?.({ entry, index: cursor, total: steps.length, epoch });
  };

  const arm = (): void => {
    const step = steps[cursor];
    if (step === undefined) return; // defensive; steps is non-empty when started
    handle = clock.setTimeout(() => {
      cursor = (cursor + 1) % steps.length;
      epoch += 1;
      const next = steps[cursor];
      if (next !== undefined) {
        publish();
        opts.router.navigate(`/${next.viewId}`, { replace: true }); // REQ-KIOSK-04
      }
      arm(); // chain the next dwell
    }, step.dwellMs);
  };

  return {
    start(): void {
      if (steps.length === 0 || handle !== null) return; // empty spec / already running
      publish();
      arm();
    },
    stop(): void {
      if (handle !== null) {
        clock.clearTimeout(handle);
        handle = null;
      }
    },
  };
}
