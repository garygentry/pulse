// apps/web/tests/rtl.ts — React Testing Library for `@/ui` suites under `bun test` + happy-dom.
//
// Suites import `render`, `screen`, `userEvent` and friends from here, never from
// `@testing-library/*` directly, and wrap their tests in `describeUi` (a `describeDom` that also
// installs the Radix stubs below and unmounts after each test).
//
// Why a wrapper instead of the packages:
// - RTL evaluates react-dom when it loads, and react-dom probes the DOM once at load (see
//   `react-render.ts`). Every `bun test` file shares one module registry, so RTL is required lazily,
//   on first use inside a test, with react-dom initialised the way `react-render.ts` does it.
// - `@testing-library/dom` binds its `screen` to the `document.body` that existed when it loaded.
//   Each file registers a fresh happy-dom window, so `screen` here re-binds to the current body on
//   every access.
// - The `pure` entry is used: the default entry registers `afterEach`/`beforeAll` hooks at load and
//   pins `IS_REACT_ACT_ENVIRONMENT` on for the rest of the run, which the pulse suites keep off
//   outside `act()` scopes.

import { afterAll, afterEach, beforeAll, expect, mock } from "bun:test";
import * as matchers from "@testing-library/jest-dom/matchers";
import type { TestingLibraryMatchers } from "@testing-library/jest-dom/matchers";

import { describeDom, type DomContext } from "./dom.js";
import { requireWithReactDom } from "./react-render.js";

declare module "bun:test" {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- declaration merge
  interface Matchers<T = unknown>
    extends TestingLibraryMatchers<ReturnType<typeof expect.stringContaining>, T> {}
}

expect.extend(matchers as unknown as Parameters<typeof expect.extend>[0]);

type RtlModule = typeof import("@testing-library/react/pure");
type UserEventModule = typeof import("@testing-library/user-event");
type UserEvent = UserEventModule["default"];

let rtl: RtlModule | null = null;
let userEventModule: UserEvent | null = null;

function lib(): RtlModule {
  if (typeof document === "undefined") {
    throw new Error("rtl: no document — call inside describeUi");
  }
  rtl ??= requireWithReactDom(() => require("@testing-library/react/pure") as RtlModule);
  return rtl;
}

function lazy<K extends keyof RtlModule>(key: K): RtlModule[K] {
  return ((...args: unknown[]) => (lib()[key] as (...a: unknown[]) => unknown)(...args)) as RtlModule[K];
}

export const render = lazy("render");
export const renderHook = lazy("renderHook");
export const cleanup = lazy("cleanup");
export const within = lazy("within");
export const waitFor = lazy("waitFor");
export const waitForElementToBeRemoved = lazy("waitForElementToBeRemoved");
export const act = lazy("act");

/** `fireEvent(el, event)` and `fireEvent.click(el)` etc., resolved on use. */
export const fireEvent = new Proxy(lazy("fireEvent"), {
  get: (_target, key) => (lib().fireEvent as unknown as Record<PropertyKey, unknown>)[key],
}) as RtlModule["fireEvent"];

/** `screen` bound to the current window's `document.body` (see the header). */
export const screen = new Proxy({} as RtlModule["screen"], {
  get(_target, key) {
    const { within: withinBody, screen: loaded } = lib();
    const queries = withinBody(document.body) as unknown as Record<PropertyKey, unknown>;
    return key in queries ? queries[key] : (loaded as unknown as Record<PropertyKey, unknown>)[key];
  },
});

/** `@testing-library/user-event`'s default export, loaded after RTL (they share its DOM config). */
export const userEvent = new Proxy({} as UserEvent, {
  get(_target, key) {
    lib();
    userEventModule ??= (require("@testing-library/user-event") as UserEventModule).default;
    // user-event defaults `document` to the `globalThis.document` it saw at load, i.e. the first
    // file's window; `setup()` with no node would then type into a closed document. Bind the current one.
    if (key === "setup") {
      const setup = userEventModule.setup;
      return (options: Parameters<UserEvent["setup"]>[0] = {}) => setup({ document, ...options });
    }
    // The direct API (`userEvent.click(el)`, `userEvent.keyboard(...)`) has the same default: run it
    // as a one-off instance bound to the current document, which is what the direct API does.
    const value = (userEventModule as unknown as Record<PropertyKey, unknown>)[key];
    if (typeof value === "function") {
      const instance = (): Record<PropertyKey, unknown> =>
        userEventModule!.setup({ document }) as unknown as Record<PropertyKey, unknown>;
      return (...args: unknown[]) => (instance()[key] as (...a: unknown[]) => unknown)(...args);
    }
    return value;
  },
});

/**
 * The happy-dom gaps Radix and Floating UI hit:
 * - `ResizeObserver` (Radix measures popper content and scroll areas);
 * - pointer capture and `scrollIntoView` (Radix Select);
 * - `matches(":modal")` / `matches(":popover-open")`, which Floating UI probes on every position
 *   update and happy-dom's selector parser rejects; answer `false` directly.
 */
/** `@radix-ui/react-use-layout-effect`'s CJS entry as each `@radix-ui/*` dependency of apps/web
 *  resolves it, deduplicated. Throws if none does, so a dependency change cannot skip the stub. */
function radixLayoutEffectEntries(): string[] {
  const { dependencies } = require("../package.json") as { dependencies: Record<string, string> };
  const entries = new Set<string>();
  for (const name of Object.keys(dependencies).filter((d) => d.startsWith("@radix-ui/"))) {
    try {
      entries.add(require.resolve("@radix-ui/react-use-layout-effect", { paths: [require.resolve(name)] }));
    } catch {
      // This package does not reach it; another one will.
    }
  }
  if (entries.size === 0) throw new Error("no @radix-ui dependency resolves @radix-ui/react-use-layout-effect");
  return [...entries];
}

export function installUiStubs(): () => void {
  const g = globalThis as Record<string, unknown>;
  // Globals this call adds; the returned restore removes them, so suites that run after a
  // `describeUi` file see the same globals as before it (`requestAnimationFrame` is deliberately absent
  // from bun's globals, and app code branches on it). The Element prototype stubs stay: they fill
  // happy-dom gaps with what a browser provides, so no code path depends on their absence.
  const added: string[] = [];
  // Bun has no `requestAnimationFrame` and happy-dom.ts keeps it off `globalThis` (KEEP_NATIVE);
  // Disclosure/Collapsible schedule on it. A timer-backed frame (works under fake timers too).
  if (typeof g["requestAnimationFrame"] !== "function") {
    g["requestAnimationFrame"] = (cb: (t: number) => void) => setTimeout(() => cb(performance.now()), 16);
    g["cancelAnimationFrame"] = (id: ReturnType<typeof setTimeout>) => clearTimeout(id);
    added.push("requestAnimationFrame", "cancelAnimationFrame");
  }
  // `@radix-ui/react-use-layout-effect` picks `useLayoutEffect` or a no-op ONCE, at module load, by
  // probing `globalThis.document`. Suites import `@/ui` before `describeUi` registers happy-dom, so
  // it binds the no-op: Portals never mount (no popover content) and roving focus never registers
  // its items. Re-point the module (both entries; Bun updates live bindings) at React's hook. This
  // stays for the whole process (bun cannot un-mock a module); it only changes Radix, whose only
  // importers are the `@/ui` primitives, and makes it behave as it does in a browser. It is not a
  // direct dependency: resolve it from each scoped Radix package the app declares (one copy today).
  if (!(g["__uiLayoutEffectStub"] === true)) {
    g["__uiLayoutEffectStub"] = true;
    const { useLayoutEffect } = require("react") as typeof import("react");
    for (const cjs of radixLayoutEffectEntries()) {
      for (const entry of [cjs, cjs.replace(/index\.js$/, "index.mjs")]) {
        void mock.module(entry, () => ({ useLayoutEffect }));
      }
    }
  }
  if (typeof g["ResizeObserver"] !== "function") {
    g["ResizeObserver"] = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };
    added.push("ResizeObserver");
  }
  const proto = (g["Element"] as { prototype: Record<string, unknown> }).prototype;
  proto["hasPointerCapture"] ??= () => false;
  proto["setPointerCapture"] ??= () => undefined;
  proto["releasePointerCapture"] ??= () => undefined;
  proto["scrollIntoView"] ??= () => undefined;
  const matches = proto["matches"] as (this: Element, selector: string) => boolean;
  if (!(matches as { uiStub?: boolean }).uiStub) {
    const patched = function (this: Element, selector: string): boolean {
      if (selector === ":modal" || selector === ":popover-open") return false;
      return matches.call(this, selector);
    };
    (patched as { uiStub?: boolean }).uiStub = true;
    proto["matches"] = patched;
  }
  return () => {
    for (const key of added) delete g[key];
  };
}

/** `describeDom` for RTL suites: stubs installed once, the rendered tree unmounted after each test. */
export function describeUi(name: string, body: (dom: DomContext) => void): void {
  describeDom(name, (dom) => {
    let restoreStubs: (() => void) | null = null;
    beforeAll(() => {
      restoreStubs = installUiStubs();
    });
    afterAll(() => {
      restoreStubs?.();
      restoreStubs = null;
    });
    afterEach(() => {
      if (rtl !== null) rtl.cleanup();
    });
    body(dom);
  });
}
