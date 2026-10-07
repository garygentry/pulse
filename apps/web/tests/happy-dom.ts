// apps/web/tests/happy-dom.ts — the SHARED happy-dom registrar for every DOM test file (item 013 fix).
//
// The bug this fixes: a happy-dom `GlobalWindow` copies ALL of its own props onto `globalThis`,
// clobbering Bun's native `fetch`/`Response`/`Request`/`Headers`/`AbortController`/`AbortSignal`/
// `DOMException`/`TextEncoder`/`TextDecoder` and the timer functions. A fetch/Response-based suite
// (sources.test.ts, poll.test.ts, routes.test.ts) later running in the SAME `bun test` process then
// sees happy-dom's `Response` — whose `.text()`/`.json()` throw `getBrowserFrame() is null` once the
// window is closed — and happy-dom's `setTimeout`, tied to a closed window's async-task manager.
//
// Why restoring the natives in `afterAll` was INSUFFICIENT: bun binds a module's *bare* global
// references (a plain `Response` / `setTimeout` identifier, not `globalThis.Response`) at module
// INSTANTIATION time. Once `sources.test.ts` / `poll.ts` are instantiated while a happy-dom window has
// clobbered `globalThis.Response`, their bare `Response` stays happy-dom's FOREVER — a later
// `globalThis.Response = <native>` restore never reaches those already-captured bindings. (Verified:
// with a per-file restore, `Response.toString()` inside sources reads happy-dom's class while
// `globalThis.Response.toString()` reads `[native code]`.)
//
// The fix therefore NEVER clobbers those primitives: `registerHappyDom` copies only the props a DOM
// render actually needs (document/window/DOM constructors/events/…) and SKIPS the web-platform
// primitives listed in `KEEP_NATIVE`. Because `globalThis.Response`/`setTimeout`/… are never
// overwritten, every module — DOM or not, whenever it is instantiated — binds Bun's genuine natives.
// happy-dom's own window object still carries its own `Response`/`setTimeout` for any internal use.

import nodeProcess from "node:process";
import { GlobalWindow } from "happy-dom";

/**
 * Web-platform primitives Bun provides natively that the server/client modules bind by bare name and
 * depend on being Bun's own — never let a happy-dom window overwrite these on `globalThis`.
 *   - network/body: fetch, Response, Request, Headers, FormData, Blob, File
 *   - abort/errors:  AbortController, AbortSignal, DOMException
 *   - encoding:      TextEncoder, TextDecoder
 *   - runtime:       globalThis, global, process (Playwright and Bun libraries require the native
 *                    process streams/task queue and the actual runtime global object)
 *   - timers:        setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
 *                    setImmediate, clearImmediate, requestAnimationFrame, cancelAnimationFrame
 *   - console:       React's development build calls `console.timeStamp`, which happy-dom's virtual
 *                    console throws on
 */
const KEEP_NATIVE = new Set<string>([
  "globalThis",
  "global",
  "process",
  "fetch",
  "Response",
  "Request",
  "Headers",
  "FormData",
  "Blob",
  "File",
  "AbortController",
  "AbortSignal",
  "DOMException",
  "TextEncoder",
  "TextDecoder",
  "setTimeout",
  "clearTimeout",
  "setInterval",
  "clearInterval",
  "queueMicrotask",
  "setImmediate",
  "clearImmediate",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "console",
]);

let activeWindow: InstanceType<typeof GlobalWindow> | null = null;

/** Install a fresh happy-dom `GlobalWindow` onto `globalThis` WITHOUT clobbering Bun's native
 *  web-platform primitives (see `KEEP_NATIVE`). Call from a DOM test's `beforeAll`. */
export function registerHappyDom(): InstanceType<typeof GlobalWindow> {
  const win = new GlobalWindow({ url: "http://localhost/" });
  activeWindow = win;
  const target = globalThis as unknown as Record<string, unknown>;
  const source = win as unknown as Record<string, unknown>;
  for (const key of Object.getOwnPropertyNames(win)) {
    if (KEEP_NATIVE.has(key)) continue; // leave Bun's native primitive in place
    try {
      target[key] = source[key];
    } catch {
      /* read-only global — skip */
    }
  }
  // Reassert the runtime object after the copy as well: concurrent Bun test-file setup may have
  // installed another DOM window before this registrar runs.
  target.process = nodeProcess;
  target.window = win;
  target.document = source.document;
  target.location = source.location;
  return win;
}

/** Close the happy-dom window. Call from a DOM test's `afterAll` (closing the window releases its
 *  timers so `bun test` can exit). No native restore is needed — `KEEP_NATIVE` was never clobbered. */
export async function unregisterHappyDom(): Promise<void> {
  if (activeWindow) {
    await activeWindow.happyDOM.close();
    activeWindow = null;
  }
}
