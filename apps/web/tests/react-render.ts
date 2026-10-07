// apps/web/tests/react-render.ts — a synchronous `render(element | null, container)` over React roots.
//
// Test and browser-fixture code renders into plain containers and re-renders or unmounts them by
// container. React keys roots by `createRoot`, so this keeps one root per container and flushes
// each render synchronously (`flushSync`), so the DOM is committed when the call returns. Passing
// `null` unmounts the root and forgets it. No `bun:test` import: browser fixtures bundle this file.
//
// react-dom is loaded on first render, not at import. It probes the DOM once when it is evaluated
// (e.g. whether `input` events exist), and every `bun test` file shares one module registry, so a
// static import from a file that runs before happy-dom registers would leave controlled inputs
// on a fallback event path for the rest of the run.
//
// Under `bun test`, React's scheduler runs its work on microtasks (react-dom loads while
// `setImmediate` is a microtask shim), so renders and effects settle the way the suites drain them
// and no scheduler task ever waits on a timer: on some hosts Bun's fake timers also capture
// `setImmediate`, and a scheduler task stranded there stops every later render. `act()`'s
// follow-up task is pinned to a microtask for the same reason.

import { act as reactAct, type ReactNode } from "react";
import type { Root } from "react-dom/client";

import { ROOT_OPTIONS } from "../src/client/root-options.js";

const roots = new WeakMap<Element, Root>();

interface ReactDomApi {
  readonly createRoot: typeof import("react-dom/client").createRoot;
  readonly flushSync: typeof import("react-dom").flushSync;
}

let reactDom: ReactDomApi | null = null;

/** True under `bun test`; false in a browser fixture bundle. */
const IN_BUN = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

/** Run `load` (which evaluates React's scheduler) with `setImmediate` as a microtask, under Bun only. */
function withMicrotaskScheduler<T>(load: () => T): T {
  if (!IN_BUN) return load();
  const g = globalThis as Record<string, unknown>;
  const original = Object.getOwnPropertyDescriptor(g, "setImmediate");
  g["setImmediate"] = (callback: () => void): void => queueMicrotask(callback);
  try {
    return load();
  } finally {
    if (original === undefined) delete g["setImmediate"];
    else Object.defineProperty(g, "setImmediate", original);
  }
}

function loadReactDom(): ReactDomApi {
  if (reactDom === null) {
    reactDom = withMicrotaskScheduler(() => {
      const client = require("react-dom/client") as typeof import("react-dom/client");
      const dom = require("react-dom") as typeof import("react-dom");
      return { createRoot: client.createRoot, flushSync: dom.flushSync };
    });
  }
  return reactDom;
}

/**
 * Load a module that evaluates react-dom (e.g. `@testing-library/react`) the way `render` loads
 * react-dom itself: after react-dom is initialised, with React's scheduler on microtasks.
 */
export function requireWithReactDom<T>(load: () => T): T {
  loadReactDom();
  return withMicrotaskScheduler(load);
}

/** Render `node` into `container` synchronously; `null`, `undefined` or `false` unmounts it. */
export function render(node: ReactNode, container: Element): void {
  let root = roots.get(container);
  if (node === null || node === undefined || node === false) {
    if (root !== undefined) {
      root.unmount();
      roots.delete(container);
    }
    return;
  }
  const { createRoot, flushSync } = loadReactDom();
  if (root === undefined) {
    root = createRoot(container, ROOT_OPTIONS);
    roots.set(container, root);
  }
  const target = root;
  flushSync(() => target.render(node));
}

/** Open `act` scopes. Scopes can overlap (one awaited while another starts), so the flag tracks a
 *  count rather than restoring a saved value. */
let actDepth = 0;

/**
 * React's `act`, with `IS_REACT_ACT_ENVIRONMENT` switched on only while an `act` scope is open, so
 * work scheduled inside `callback` is flushed before the returned promise settles and code outside
 * an `act` scope never triggers React's not-wrapped-in-act warnings.
 */
export function act(callback: () => void | Promise<void>): Promise<void> {
  const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean | undefined };
  const exit = (): void => {
    actDepth -= 1;
    if (actDepth === 0) env.IS_REACT_ACT_ENVIRONMENT = false;
  };
  actDepth += 1;
  env.IS_REACT_ACT_ENVIRONMENT = true;
  let async = false;
  let pending: PromiseLike<void>;
  try {
    pending = reactAct(() => {
      const result = callback();
      async = result !== undefined;
      return result;
    });
  } catch (error) {
    exit();
    throw error;
  }
  // A synchronous scope has already flushed when act() returns; close it now so updates after it
  // are not treated as inside a scope.
  if (!async) {
    exit();
    return Promise.resolve(pending);
  }
  return Promise.resolve(pending).finally(exit);
}

/**
 * React resolves the task queue for `act()`'s follow-up work once, from `require("timers")`, the
 * first time an async `act()` finishes. Point it at a microtask for that one call so the cached
 * choice never depends on timers (see the header).
 */
async function pinActTaskQueue(): Promise<void> {
  const timers = require("timers") as { setImmediate: (callback: () => void) => unknown };
  const original = timers.setImmediate;
  timers.setImmediate = (callback) => queueMicrotask(callback);
  try {
    await act(async () => undefined);
  } finally {
    timers.setImmediate = original;
  }
}

if (IN_BUN) await pinActTaskQueue();

/**
 * Set a form control's value the way a user edit does. React tracks each controlled input's value
 * through an instance property, so a plain `el.value = x` before an `input` event looks like no
 * change and `onChange` never fires. Writing through the prototype setter bypasses that tracker.
 */
export function setInputValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  for (let proto = Object.getPrototypeOf(el) as object | null; proto !== null; proto = Object.getPrototypeOf(proto) as object | null) {
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter !== undefined) {
      setter.call(el, value);
      return;
    }
  }
  el.value = value;
}
