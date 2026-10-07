// apps/web/tests/dom.ts — the per-file happy-dom kit (REQ-TEST-01, REQ-TEST-02).
//
// `describeDom` wraps `registerHappyDom` (happy-dom.ts:63) / `unregisterHappyDom` (happy-dom.ts:84):
// no bunfig.toml preload (regression 8f7d560). `renderWithStore` mounts a component with a store and
// a router wired; test call-sites read `RenderResult.router` without annotating its type so item 008
// can swap the stub below for the real `createPathRouter` (07 §10) without touching them.

import { afterAll, beforeAll, describe, jest } from "bun:test";
import type { ComponentType, ReactElement } from "react";

import { createAppStore, type AppStore } from "../src/client/store/index.js";
import type { RouteState } from "../src/client/store/types.js";
import type { OverviewSnapshot } from "../src/shared/snapshot.js";
import { createPathRouter, type PathRouter, type RouteMatch } from "../src/client/router.js";
import { registerHappyDom, unregisterHappyDom } from "./happy-dom.js";

export type { PathRouter } from "../src/client/router.js";

/**
 * Leave fake timers: run what is still queued on the fake clock, then restore the real timers.
 * React's scheduler keeps one host task in flight and will not queue another while it waits, so a
 * task stranded on a discarded fake clock would stop every later render in the process.
 */
export function restoreRealTimers(): void {
  if (jest.isFakeTimers()) jest.runOnlyPendingTimers();
  jest.useRealTimers();
}

/** Opt-out marker for `dom-guard.test.ts` — must be followed by ` — <reason>` (00 §9.1). */
export const DOM_GUARD_OPT_OUT = "// dom-guard: not-a-dom-test" as const;

/** Handed to a `describeDom` body. `win` is valid inside tests (after `beforeAll`). */
export interface DomContext {
  /** The registered happy-dom window (throws if read before `beforeAll` runs). */
  readonly win: ReturnType<typeof registerHappyDom>;
  /** Render an element into a fresh container appended to `document.body`. react-dom is loaded
   *  lazily so it initialises after happy-dom has installed `document`/`window`. */
  mount(vnode: ReactElement): Promise<{ container: HTMLElement; unmount(): void }>;
}

/** Options for `renderWithStore` (REQ-TEST-02, 00 §9.1). */
export interface RenderWithStoreOptions {
  /** Default: `createAppStore({ storage: null, initialQuery: {} })`. */
  store?: AppStore;
  /** Default: a minimal stub router bound to `globalThis.window` (item 008 replaces it). */
  router?: PathRouter;
  /** Convenience seed written to `store.snapshot` before render. `null` is written; `undefined`
   *  (the default) leaves the store's initial value untouched (exactOptionalPropertyTypes). */
  snapshot?: OverviewSnapshot | null;
}

/** What `renderWithStore` returns. */
export interface RenderResult {
  container: HTMLElement;
  store: AppStore;
  router: PathRouter;
  /** Unmount, stop the router, remove the container. Idempotent. */
  unmount(): void;
}

/**
 * `describe()` whose `beforeAll`/`afterAll` register and close happy-dom for THIS file
 * (REQ-TEST-01, regression `8f7d560`). `DomContext.win` is a getter, so a body that captures
 * `dom.win` at declaration time still reads the window registered later in `beforeAll`.
 */
export function describeDom(name: string, body: (dom: DomContext) => void): void {
  describe(name, () => {
    let win: ReturnType<typeof registerHappyDom> | null = null;
    const ctx: DomContext = {
      get win() {
        if (win === null) {
          throw new Error("describeDom: window not registered — read dom.win inside a test or hook");
        }
        return win;
      },
      mount,
    };
    beforeAll(() => {
      win = registerHappyDom();
    });
    afterAll(async () => {
      await unregisterHappyDom();
      win = null;
    });
    body(ctx);
  });
}

async function mount(vnode: ReactElement): Promise<{ container: HTMLElement; unmount(): void }> {
  if (typeof document === "undefined") {
    throw new Error("mount: no document — call inside describeDom");
  }
  const { render } = await import("./react-render.js");
  const container = document.createElement("div");
  document.body.appendChild(container);
  render(vnode, container as unknown as Element);
  let done = false;
  return {
    container: container as unknown as HTMLElement,
    unmount(): void {
      if (done) return;
      done = true;
      render(null, container as unknown as Element);
      container.remove();
    },
  };
}

/**
 * Render `target` with a store and router wired (REQ-TEST-02). A component is instantiated as
 * `createElement(target, { store, router })`; a vnode is rendered as given.
 *
 * PRECONDITION: a DOM must be registered — call inside a `describeDom` body.
 */
export async function renderWithStore(
  target: ReactElement | ComponentType<{ store: AppStore; router: PathRouter }>,
  opts: RenderWithStoreOptions = {},
): Promise<RenderResult> {
  if (typeof document === "undefined") {
    throw new Error("renderWithStore: no document — call inside describeDom");
  }
  const store = opts.store ?? createAppStore({ storage: null, initialQuery: {} });
  const router = opts.router ?? createDefaultRouter();
  if (opts.snapshot !== undefined) store.snapshot.value = opts.snapshot;

  const { createElement } = await import("react");
  const { render } = await import("./react-render.js");
  const vnode: ReactElement =
    typeof target === "function"
      ? (createElement(target as ComponentType<{ store: AppStore; router: PathRouter }>, {
          store,
          router,
        }) as unknown as ReactElement)
      : target;
  const container = document.createElement("div");
  document.body.appendChild(container);
  render(vnode, container as unknown as Element);

  let done = false;
  return {
    container: container as unknown as HTMLElement,
    store,
    router,
    unmount(): void {
      if (done) return;
      done = true;
      render(null, container as unknown as Element);
      container.remove();
      router.stop();
    },
  };
}

/** Default router for `renderWithStore` — a real `createPathRouter` bound to the happy-dom window
 *  with a single `/__test` fallback route so construction never throws. Tests that need a specific
 *  route table pass their own via `opts.router` (07 §10.1 step 2). Also serves as an adapter proof
 *  that `RouteMatch` (07 §5) is structurally assignable to `RouteState` (00 §4.1). */
function createDefaultRouter(): PathRouter {
  const win = (globalThis as { window?: Window }).window;
  if (win === undefined) {
    throw new Error("renderWithStore: no window — call inside describeDom");
  }
  const fallbackRoute = { pattern: "/__test", view: "__test" };
  // Ensure fallback is the current location so construction resolves it cleanly, no matter what a
  // previous test left in the address bar. Silently swallow if the assign is not writable.
  try {
    win.history.replaceState({}, "", "/__test");
  } catch {
    /* not writable — createPathRouter will fall back and replace regardless */
  }
  return createPathRouter({
    routes: [fallbackRoute],
    fallback: "/__test",
    win,
  });
}

// Retained: RouteState + RouteMatch types are structurally equivalent — assigning a RouteMatch to
// a Signal<RouteState> requires no cast. Reference the types once so the imports are used.
const _routeShapeCheck: (m: RouteMatch) => RouteState = (m) => m;
void _routeShapeCheck;
