// apps/web/tests/theme-runtime.test.ts — unit tests for the pure theme/density resolvers (item 004).
//
// These cover resolveEffectiveTheme and resolveEffectiveDensity WITHOUT a DOM: both are pure and never
// touch document/localStorage. The matchMedia branches are exercised by an injected MediaQueryList
// (the `mql` seam) and by stubbing globalThis.matchMedia, restoring it afterwards so no other suite
// in the same process inherits a stub.
import { afterEach, describe, expect, test } from "bun:test";

import {
  applyDensity,
  applyTheme,
  resolveEffectiveDensity,
  resolveEffectiveTheme,
} from "../src/client/theme/index.js";
import { resolveEffectiveDensity as resolveDensityDirect } from "../src/client/theme/density.js";

/** Build a minimal MediaQueryList stub exposing only the `.matches` read the resolver uses. */
function mql(matches: boolean): MediaQueryList {
  return { matches } as MediaQueryList;
}

describe("resolveEffectiveTheme (unit)", () => {
  const originalMatchMedia = (globalThis as { matchMedia?: unknown }).matchMedia;
  afterEach(() => {
    // Restore by assignment (not delete) so we never leave one of our stubs behind for another suite.
    (globalThis as { matchMedia?: unknown }).matchMedia = originalMatchMedia;
  });

  test("explicit dark/light pass through", () => {
    expect(resolveEffectiveTheme("dark")).toBe("dark");
    expect(resolveEffectiveTheme("light")).toBe("light");
  });

  test("system with matchMedia absent → dark (default NOC appearance)", () => {
    // Assign `undefined` (not `delete`): under bun+happy-dom the global may remain reachable via the
    // window/prototype after a `delete`, whereas an explicit `undefined` reliably shadows it so the
    // resolver's `typeof mm === "function"` guard sees the API as absent.
    (globalThis as { matchMedia?: unknown }).matchMedia = undefined;
    expect(resolveEffectiveTheme("system")).toBe("dark");
  });

  test("system with no OS preference (neither query matches) → dark", () => {
    (globalThis as { matchMedia?: unknown }).matchMedia = (_q: string): MediaQueryList => mql(false);
    expect(resolveEffectiveTheme("system")).toBe("dark");
  });

  test("system prefers dark → dark", () => {
    (globalThis as { matchMedia?: unknown }).matchMedia = (q: string): MediaQueryList =>
      mql(q.includes("dark"));
    expect(resolveEffectiveTheme("system")).toBe("dark");
  });

  test("system prefers light → light", () => {
    (globalThis as { matchMedia?: unknown }).matchMedia = (q: string): MediaQueryList =>
      mql(q.includes("light"));
    expect(resolveEffectiveTheme("system")).toBe("light");
  });

  test("an injected dark MediaQueryList is used for the dark query", () => {
    // matchMedia stubbed so the light fallback query resolves; the injected mql drives the dark check.
    (globalThis as { matchMedia?: unknown }).matchMedia = (_q: string): MediaQueryList => mql(false);
    expect(resolveEffectiveTheme("system", mql(true))).toBe("dark");
  });
});

describe("resolveEffectiveDensity (unit)", () => {
  test("passes the preference through with no kiosk param", () => {
    expect(resolveEffectiveDensity("desk")).toBe("desk");
    expect(resolveEffectiveDensity("wallboard")).toBe("wallboard");
    expect(resolveEffectiveDensity("desk", "?target=host:web-01")).toBe("desk");
  });

  test("?kiosk=1 forces wallboard regardless of preference", () => {
    expect(resolveEffectiveDensity("desk", "?kiosk=1")).toBe("wallboard");
    expect(resolveEffectiveDensity("desk", "?rotate=overview&kiosk=1")).toBe("wallboard");
    expect(resolveEffectiveDensity("desk", "?kiosk=1&rotate=overview")).toBe("wallboard");
  });

  test("only a genuine kiosk=1 param matches (not nokiosk / kiosk=10)", () => {
    expect(resolveEffectiveDensity("desk", "?nokiosk=1")).toBe("desk");
    expect(resolveEffectiveDensity("desk", "?kiosk=10")).toBe("desk");
    expect(resolveEffectiveDensity("desk", "?kiosk=0")).toBe("desk");
  });

  test("the density.ts export and the barrel-re-exported symbol are identical", () => {
    expect(resolveEffectiveDensity).toBe(resolveDensityDirect);
  });
});

describe("no localStorage access in either module", () => {
  // The store owns persistence (REQ-PREF-01); theme.ts/density.ts only apply state. The guarantee is
  // structural: neither source file names localStorage. A source-level meta-guard is robust and does
  // not depend on stubbing a readonly global.
  test("theme.ts and density.ts perform no localStorage/storage access", async () => {
    const here = new URL(".", import.meta.url);
    const themeSrc = await Bun.file(new URL("../src/client/theme/theme.ts", here)).text();
    const densitySrc = await Bun.file(new URL("../src/client/theme/density.ts", here)).text();
    // Match a genuine access (`localStorage.foo` / `localStorage[...]` / `.storage(...)`), which the
    // explanatory comments ("never touches localStorage") do not.
    const accessPattern = /localStorage\s*[.[]|\bstorage\s*\./;
    expect(accessPattern.test(themeSrc)).toBe(false);
    expect(accessPattern.test(densitySrc)).toBe(false);
  });
});

// applyTheme/applyDensity are re-exported from the barrel and covered end-to-end by the shell (item
// 013); referenced here only to assert the barrel surface exists at type/runtime level.
describe("apply helpers are exported", () => {
  test("applyTheme and applyDensity are functions", () => {
    expect(typeof applyTheme).toBe("function");
    expect(typeof applyDensity).toBe("function");
  });
});
